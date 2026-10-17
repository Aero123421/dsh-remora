import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { ExecuteCall, ExecuteResult } from '../../src/host-do.ts'
import { runOperation, type Caller } from '../../src/ops.ts'
import type { ConfirmationInfo, Grant, ResponseFrame, TaskInfo } from '../../src/vendor/protocol/index.ts'
import { FakeHost, eventually, setupOwner } from './helpers.ts'

const caller: Caller = { clientId: 'race-reader', clientName: 'Race reader', kind: 'client', scopes: ['dsh.read', 'dsh.content', 'dsh.tasks', 'dsh.admin'] }
const hub = () => env.HUB.get(env.HUB.idFromName('hub'))
const hostObject = (hostId: string) => env.HOST.get(env.HOST.idFromName(hostId))
const resultOf = <T>(outcome: ExecuteResult): T => {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return outcome.result as T
}

// These probes pause the actual delivery methods at their asynchronous policy
// boundary, while retaining the durable ledger and transport serialization.
interface DeliveryProbe {
  hub(): { clientStanding(): Promise<{ revoked: boolean; grant: Grant | null }> }
  revalidate(row: Record<string, unknown>): Promise<ExecuteCall | null>
  sendRequest(ws: WebSocket, id: string, call: ExecuteCall, timeout: number, taskId: string, key: string): boolean
  deliverUndelivered(ws: WebSocket): Promise<void>
  relay(ws: WebSocket, id: string, call: ExecuteCall, timeout: number, taskId: string, key: string): Promise<ResponseFrame | null>
  executeInner(call: ExecuteCall): Promise<ExecuteResult>
  pending: Map<string, unknown>
  inFlight: Set<string>
}

async function setup() {
  const owner = await setupOwner()
  // These cases share the worker, but exercise policy transitions, not IP quotas.
  await runInDurableObject(hub(), (_instance, state) => { state.storage.sql.exec('DELETE FROM rate') })
  const host = await FakeHost.create()
  await host.pair(owner)
  await hub().upsertClient({ clientId: caller.clientId, name: caller.clientName, kind: 'cimd', domain: null, redirectHost: null })
  await hub().setGrant(caller.clientId, host.hostId, 'request', 'request')
  await host.connect()
  await host.next('ready')
  return { owner, host }
}

async function offline(host: FakeHost) {
  host.socket?.close(1000, 'offline')
  await eventually(async () => expect((await hostObject(host.hostId).summary()).online).toBe(false))
}

const startParams = (hostId: string, idempotencyKey: string) => ({ hostId, target: { sessionId: 's' }, prompt: 'do work', idempotencyKey })

describe('in-flight authorization', () => {
  it.each(['revoked', 'blocked', 'ceiling', 'kill-switch', 'unpaired', 'unchanged'])('checks %s policy after a session.read relay', async change => {
    const { host } = await setup()
    const stub = hostObject(host.hostId)
    host.respond = () => undefined
    const pending = runOperation(env, caller, 'session.read', { hostId: host.hostId, sessionId: 's', depth: 'page' })
    const frame = await host.next('request')
    if (frame.t !== 'request') throw new Error('missing request')
    if (change === 'revoked') await hub().revokeClient(caller.clientId)
    if (change === 'blocked') await hub().setGrant(caller.clientId, host.hostId, 'none', 'request')
    if (change === 'ceiling' || change === 'kill-switch') {
      host.sendEvent([{ kind: 'host-status', ceiling: { level: 'request', overrides: change === 'ceiling' ? { 'session.read': false } : {} }, killSwitch: change === 'kill-switch', operations: ['session.read'] }])
      await eventually(async () => {
        const state = await stub.summary()
        expect(change === 'ceiling' ? state.ceiling?.overrides?.['session.read'] : state.killSwitch).toBe(change !== 'ceiling')
      })
    }
    if (change === 'unpaired') await hub().revokeHost(host.hostId)
    host.socket!.send(JSON.stringify({ t: 'response', id: frame.id, ok: true, result: { messages: [{ text: 'private transcript' }] } }))
    const result = await pending
    host.socket?.close(1000, 'done')
    if (change === 'unchanged') expect(result).toMatchObject({ ok: true, result: { messages: [{ text: 'private transcript' }] } })
    else {
      expect(result).toMatchObject({ ok: false, error: { code: 'denied' } })
      expect(JSON.stringify(result)).not.toContain('private transcript')
    }
  })

  it('rechecks the client after a task.wait wakes and fetches its result', async () => {
    const { host } = await setup()
    host.respond = frame => ({ ok: true, result: { taskId: frame.taskId, sessionId: 's', state: 'running' } })
    const task = resultOf<TaskInfo>(await runOperation(env, caller, 'task.start', startParams(host.hostId, 'wait-revoke')))
    const pending = runOperation(env, caller, 'task.wait', { taskId: task.taskId, timeoutMs: 10_000 })
    await eventually(async () => expect(await runInDurableObject(hostObject(host.hostId), (_instance, state) => state.getWebSockets('ledger-wait').length)).toBe(1))
    await hub().revokeClient(caller.clientId)
    host.respond = frame => ({ ok: true, result: { taskId: frame.taskId, sessionId: 's', state: 'completed', result: { reply: 'private reply' } } })
    host.sendEvent([{ kind: 'task', taskId: task.taskId, sessionId: 's', state: 'completed', updatedAt: Date.now() }])
    expect(await pending).toMatchObject({ ok: false, error: { code: 'denied' } })
    host.socket?.close(1000, 'done')
  })

  it('revoking a client denies parked hub approvals and releases collectors immediately', async () => {
    const { host } = await setup()
    const asked = resultOf<ConfirmationInfo>(await runOperation(env, caller, 'hub.export', {}))
    const id = asked.confirmationId
    const pending = runOperation(env, caller, 'confirmation.get', { confirmationId: id, timeoutMs: 10_000 })
    await eventually(async () => expect(await runInDurableObject(hub(), (_instance, state) => state.getWebSockets('ledger-wait').length)).toBe(1))
    await hub().revokeClient(caller.clientId)
    expect(await hub().decideApproval(id, true)).toBe(false)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(await hub().approvalFor(id)).toMatchObject({ state: 'denied' })
    expect(await hub().claimApprovalResult(id, caller.clientId)).toBe(false)
    host.socket?.close(1000, 'done')
  })
})

describe('offline task ledger', () => {
  it('keeps a task non-cancellable when another delivery starts during grant revalidation', async () => {
    const { host } = await setup()
    const stub = hostObject(host.hostId)
    await offline(host)
    const task = resultOf<TaskInfo>(await runOperation(env, caller, 'task.start', startParams(host.hostId, 'delivery-marker-race')))
    const evidence = await runInDurableObject(stub, async (target, state) => {
      const instance = target as unknown as DeliveryProbe
      const row = state.storage.sql.exec<{ delivery_id: string; frame: string; params: string }>('SELECT * FROM tasks WHERE task_id = ?', task.taskId).one()
      const realHub = instance.hub
      let release!: (standing: { revoked: boolean; grant: Grant }) => void
      instance.hub = () => ({ clientStanding: () => new Promise(resolve => { release = resolve }) })
      try {
        const revalidating = instance.revalidate(row)
        const sent: string[] = []
        const socket = { send: (frame: string) => sent.push(frame) } as unknown as WebSocket
        instance.sendRequest(socket, row.delivery_id, { ...JSON.parse(row.frame), params: JSON.parse(row.params) } as ExecuteCall, 10_000, task.taskId, 'delivery-marker-race')
        release({ revoked: false, grant: { level: 'request' } })
        await revalidating
        const current = state.storage.sql.exec<{ frame: string }>('SELECT frame FROM tasks WHERE task_id = ?', task.taskId).one()
        return { sent: sent.length, marker: (JSON.parse(current.frame) as { deliveryStarted: boolean }).deliveryStarted }
      } finally {
        instance.hub = realHub
      }
    })
    expect(evidence).toEqual({ sent: 1, marker: true })
    expect(await runOperation(env, caller, 'task.cancel', { taskId: task.taskId })).toMatchObject({ ok: false, error: { code: 'host_offline' } })
  })

  it('does not send a task cancelled between successful revalidation and the delivery continuation', async () => {
    const { host } = await setup()
    const stub = hostObject(host.hostId)
    await offline(host)
    const task = resultOf<TaskInfo>(await runOperation(env, caller, 'task.start', startParams(host.hostId, 'cancel-before-send')))
    const evidence = await runInDurableObject(stub, async (target, state) => {
      const instance = target as unknown as DeliveryProbe
      const row = state.storage.sql.exec<{ delivery_id: string; frame: string; params: string }>('SELECT * FROM tasks WHERE task_id = ?', task.taskId).one()
      const realHub = instance.hub
      let release!: (standing: { revoked: boolean; grant: Grant }) => void
      instance.hub = () => ({ clientStanding: () => new Promise(resolve => { release = resolve }) })
      try {
        const sent: string[] = []
        const socket = { send: (frame: string) => sent.push(frame) } as unknown as WebSocket
        const delivering = instance.deliverUndelivered(socket)
        const cancelCall: ExecuteCall = { op: 'task.cancel', params: { taskId: task.taskId }, actor: caller, scopes: caller.scopes, grant: { level: 'request' } }
        let cancellation: Promise<ExecuteResult> | undefined
        release({ revoked: false, grant: { level: 'request' } })
        // revalidate resumes first; cancellation runs before its awaiting
        // deliverUndelivered continuation resumes with the validated snapshot.
        queueMicrotask(() => { cancellation = instance.executeInner(cancelCall) })
        await delivering
        const cancelled = await cancellation
        // A relay with that same old snapshot must settle its original waiter
        // immediately from the ledger as well, without sending a new frame.
        const call = { ...JSON.parse(row.frame), params: JSON.parse(row.params) } as ExecuteCall
        const relay = await instance.relay(socket, row.delivery_id, call, 10_000, task.taskId, 'cancel-before-send')
        return { sent: sent.length, cancelled, relay, pending: instance.pending.size, inFlight: instance.inFlight.size }
      } finally {
        instance.hub = realHub
      }
    })
    expect(evidence).toMatchObject({ sent: 0, cancelled: { ok: true, result: { cancelled: true } }, relay: { ok: true, result: { state: 'cancelled' } }, pending: 0, inFlight: 0 })
    expect(await runOperation(env, caller, 'task.get', { taskId: task.taskId })).toMatchObject({ ok: true, result: { state: 'cancelled' } })
  })

  it('routes task-id-only cancel and steer across multiple hosts while respecting explicit hosts and ownership', async () => {
    const { host: first } = await setup()
    const { host: second } = await setup()
    first.respond = frame => frame.op === 'task.cancel'
      ? { ok: true, result: { cancelled: true, how: 'stopped-session' } }
      : { ok: true, result: { taskId: frame.taskId, sessionId: 's', state: 'accepted' } }
    const task = resultOf<TaskInfo>(await runOperation(env, caller, 'task.start', startParams(first.hostId, 'multi-host')))
    const before = first.frames.filter(frame => frame.t === 'request').length
    for (const op of ['task.cancel', 'task.steer']) {
      const params = { taskId: task.taskId, ...(op === 'task.steer' ? { prompt: 'follow up', idempotencyKey: 'multi-steer' } : {}) }
      expect(await runOperation(env, caller, op, { ...params, hostId: second.hostId })).toMatchObject({ ok: false, error: { code: 'not_found' } })
      expect(await runOperation(env, caller, op, params)).toMatchObject({ ok: true })
    }
    const forwarded = first.frames.filter(frame => frame.t === 'request').slice(before)
    expect(forwarded.map(frame => frame.t === 'request' ? frame.op : '')).toEqual(['task.cancel', 'task.steer'])
    expect(second.frames.some(frame => frame.t === 'request')).toBe(false)
    const stranger = { ...caller, clientId: 'another-task-client' }
    await hub().upsertClient({ clientId: stranger.clientId, name: 'Other client', kind: 'cimd', domain: null, redirectHost: null })
    await hub().setGrant(stranger.clientId, first.hostId, 'request', 'request')
    for (const op of ['task.cancel', 'task.steer']) {
      const params = { taskId: task.taskId, ...(op === 'task.steer' ? { prompt: 'other', idempotencyKey: 'other-steer' } : {}) }
      expect(await runOperation(env, stranger, op, params)).toMatchObject({ ok: false, error: { code: 'not_found' } })
    }
    expect(first.frames.filter(frame => frame.t === 'request')).toHaveLength(before + 2)
    first.socket?.close(1000, 'done')
    second.socket?.close(1000, 'done')
  })

  it('cancels an undelivered task, clears its prompt and never delivers it on reconnect', async () => {
    const { host } = await setup()
    const stub = hostObject(host.hostId)
    await offline(host)
    const task = resultOf<TaskInfo>(await runOperation(env, caller, 'task.start', startParams(host.hostId, 'offline-cancel')))
    expect(task.state).toBe('parked')
    const cancelled = await runOperation(env, caller, 'task.cancel', { hostId: host.hostId, taskId: task.taskId })
    expect(cancelled).toMatchObject({ ok: true, result: { cancelled: true, how: 'removed-from-queue' } })
    expect(await runOperation(env, caller, 'task.get', { taskId: task.taskId })).toMatchObject({ ok: true, result: { state: 'cancelled' } })
    const row = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT * FROM tasks WHERE task_id = ?', task.taskId).one())
    expect(row).toMatchObject({ params: null, frame: null, expires_at: null })
    await host.connect()
    await host.next('ready')
    // Wait for onAuthenticated's redelivery pass to finish, then inspect the durable record.
    await runInDurableObject(stub, instance => instance.alarm())
    expect(host.frames.filter(frame => frame.t === 'request' && frame.taskId === task.taskId)).toHaveLength(0)
    host.socket?.close(1000, 'done')
  })

  it.each([undefined, true])('does not pretend an uncertain delivery (%s) was removed locally', async deliveryStarted => {
    const { host } = await setup()
    const stub = hostObject(host.hostId)
    await offline(host)
    const task = resultOf<TaskInfo>(await runOperation(env, caller, 'task.start', startParams(host.hostId, `uncertain-${deliveryStarted}`)))
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ frame: string }>('SELECT frame FROM tasks WHERE task_id = ?', task.taskId).one()
      const frame = JSON.parse(row.frame) as Record<string, unknown>
      if (deliveryStarted === undefined) delete frame.deliveryStarted
      else frame.deliveryStarted = deliveryStarted
      state.storage.sql.exec('UPDATE tasks SET frame = ? WHERE task_id = ?', JSON.stringify(frame), task.taskId)
    })
    expect(await runOperation(env, caller, 'task.cancel', { hostId: host.hostId, taskId: task.taskId })).toMatchObject({ ok: false, error: { code: 'host_offline' } })
    expect(await runOperation(env, caller, 'task.get', { taskId: task.taskId })).toMatchObject({ ok: true, result: { state: 'parked' } })
  })

  it.each(['accepted', 'error'])('keeps terminal state when a delayed %s response arrives', async late => {
    const { host } = await setup()
    const stub = hostObject(host.hostId)
    host.respond = () => undefined
    const pending = runOperation(env, caller, 'task.start', startParams(host.hostId, `late-${late}`))
    const frame = await host.next('request')
    if (frame.t !== 'request') throw new Error('missing request')
    host.sendEvent([{ kind: 'task', taskId: frame.taskId, sessionId: 's', state: 'completed', updatedAt: Date.now() }])
    await eventually(async () => expect((await stub.summary()).recent[0]?.state).toBe('completed'))
    host.socket!.send(JSON.stringify({ t: 'response', id: frame.id, ...(late === 'accepted' ? { ok: true, result: { taskId: frame.taskId, sessionId: 's', state: 'accepted' } } : { ok: false, error: { code: 'unavailable', message: 'late failure' } }) }))
    const result = await pending
    if (late === 'accepted') expect(result).toMatchObject({ ok: true, result: { state: 'completed' } })
    expect((await stub.summary()).recent[0]).toMatchObject({ taskId: frame.taskId, state: 'completed' })
    expect((await stub.summary()).running).toHaveLength(0)
    host.socket?.close(1000, 'done')
  })
})
