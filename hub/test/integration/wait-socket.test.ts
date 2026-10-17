import { env } from 'cloudflare:workers'
import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { executeHostOperation, runOperation } from '../../src/ops.ts'
import type { ExecuteCall } from '../../src/host-do.ts'
import { WAIT_HEADER, WAIT_PATH, WAIT_TAG, awaitWaitResponse } from '../../src/ledger-wait.ts'
import type { TaskInfo, ConfirmationInfo } from '../../src/vendor/protocol/index.ts'
import { FakeHost, eventually, setupOwner } from './helpers.ts'

const actor = { clientId: 'wait-client', clientName: 'Wait client' }
const caller = { ...actor, kind: 'client' as const, scopes: ['dsh.read', 'dsh.tasks', 'dsh.content', 'dsh.admin'] }
const call = (op: string, params: Record<string, unknown>, extra: Partial<ExecuteCall> = {}): ExecuteCall => ({ op, params, actor, scopes: caller.scopes, grant: { level: 'request' }, ...extra })
const hub = () => env.HUB.get(env.HUB.idFromName('hub'))
const stubFor = (hostId: string) => env.HOST.get(env.HOST.idFromName(hostId))
const taskOf = (outcome: { ok: boolean }) => (outcome as unknown as { result: TaskInfo }).result
const countWaits = (hostId: string) => runInDurableObject(stubFor(hostId), (_target, state) => state.getWebSockets(WAIT_TAG).length)
async function setup() {
  const owner = await setupOwner()
  // These independent lifecycle cases share an isolate, not an IP quota.
  await runInDurableObject(hub(), (_instance, state) => { state.storage.sql.exec('DELETE FROM rate') })
  const host = await FakeHost.create()
  await host.pair(owner)
  await host.connect()
  await host.next('ready')
  host.respond = frame => ({ ok: true, result: { taskId: frame.taskId, sessionId: 's', state: 'running' } })
  await hub().upsertClient({ clientId: actor.clientId, name: actor.clientName, kind: 'cimd', domain: null, redirectHost: null })
  await hub().setGrant(actor.clientId, host.hostId, 'request', 'request')
  const task = taskOf(await runOperation(env, caller, 'task.start', { hostId: host.hostId, target: { sessionId: 's' }, prompt: 'hello', idempotencyKey: 'wait-test' }))
  return { host, task }
}

describe('hibernating ledger subscriptions', () => {
  it('transfers the internal fetch upgrade and promptly wakes a 25s wait on a task event', async () => {
    const { host, task } = await setup()
    const pending = runOperation(env, caller, 'task.wait', { taskId: task.taskId })
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(1))
    const started = Date.now()
    host.respond = frame => ({ ok: true, result: { taskId: frame.taskId, sessionId: 's', state: 'completed', result: { reply: 'done' } } })
    host.sendEvent([{ kind: 'task', taskId: task.taskId, state: 'completed', updatedAt: Date.now() }])
    expect(await pending).toMatchObject({ ok: true, result: { state: 'completed', result: { reply: 'done' } } })
    expect(Date.now() - started).toBeLessThan(2000)
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(0))
    host.socket?.close()
  })

  it('hibernates during a 25s task wait and resumes its notification attachment', async () => {
    const { host, task } = await setup()
    const pending = runOperation(env, caller, 'task.wait', { taskId: task.taskId, timeoutMs: 25_000 })
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(1))
    // Graceful eviction drains DO requests. It can complete while the outer
    // Worker waits only because no long-poll timer/request remains in HostDO.
    await evictDurableObject(stubFor(host.hostId))
    host.respond = frame => ({ ok: true, result: { taskId: frame.taskId, state: 'completed' } })
    host.sendEvent([{ kind: 'task', taskId: task.taskId, state: 'completed', updatedAt: Date.now() }])
    expect(await pending).toMatchObject({ ok: true, result: { state: 'completed' } })
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(0))
    host.socket?.close()
  })

  it('waits for the requested timeout in the Worker and removes its socket', async () => {
    const { host, task } = await setup()
    const audits = () => runInDurableObject(stubFor(host.hostId), (_instance, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM audit WHERE operation = 'task.wait'").one().n)
    const before = await audits()
    const started = Date.now()
    expect(await runOperation(env, caller, 'task.wait', { taskId: task.taskId, timeoutMs: 250 })).toMatchObject({ ok: true, result: { state: 'running' } })
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(await audits()).toBe(before + 1)
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(0))
    host.socket?.close()
  })

  it('limits concurrent waits per client and cleans up all aborted collectors', async () => {
    const { host, task } = await setup()
    const aborts = Array.from({ length: 8 }, () => new AbortController())
    const pending = aborts.map(abort => executeHostOperation(env, host.hostId, call('task.wait', { taskId: task.taskId }), abort.signal).catch(() => undefined))
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(8))
    expect(await executeHostOperation(env, host.hostId, call('task.wait', { taskId: task.taskId }))).toMatchObject({ ok: false, error: { code: 'rate_limited' } })
    for (const abort of aborts) abort.abort()
    await Promise.all(pending)
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(0))
    host.socket?.close()
  })

  it('retains the WebSocket message meter batch across real hibernation', async () => {
    const { host } = await setup()
    const stub = stubFor(host.hostId)
    await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets().find(socket => (socket.deserializeAttachment() as { stage?: string })?.stage === 'ready')!
      socket.serializeAttachment({ ...socket.deserializeAttachment() as object, messagesSinceFlush: 199 })
    })
    const before = (await hub().meterToday()).durableObjectRequests
    await evictDurableObject(stub)
    host.sendEvent([])
    await eventually(async () => expect((await hub().meterToday()).durableObjectRequests).toBeGreaterThanOrEqual(before + 11))
    const batch = await runInDurableObject(stub, (_instance, state) => {
      const socket = state.getWebSockets().find(socket => (socket.deserializeAttachment() as { stage?: string })?.stage === 'ready')!
      return (socket.deserializeAttachment() as { messagesSinceFlush: number }).messagesSinceFlush
    })
    expect(batch).toBe(0)
    host.socket?.close()
  })

  it('rejects forged capability headers', async () => {
    const { host } = await setup()
    const response = await stubFor(host.hostId).fetch(new Request(`https://internal${WAIT_PATH}`, { headers: { upgrade: 'websocket', [WAIT_HEADER]: 'forged.signature' } }))
    expect(response.status).toBe(403)
    expect(await countWaits(host.hostId)).toBe(0)
    host.socket?.close()
  })

  it('ends a pending wait on revocation without exposing a result', async () => {
    const { host, task } = await setup()
    const pending = runOperation(env, caller, 'task.wait', { taskId: task.taskId, timeoutMs: 25_000 })
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(1))
    await evictDurableObject(hub())
    await hub().revokeClient(actor.clientId)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'denied' } })
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(0))
    host.socket?.close()
  })

  it('closes the subscription when its request is aborted', async () => {
    const { host, task } = await setup()
    const abort = new AbortController()
    const pending = executeHostOperation(env, host.hostId, call('task.wait', { taskId: task.taskId }), abort.signal)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(1))
    abort.abort(new Error('cancelled'))
    await rejected
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(0))
    host.socket?.close()
  })

  it('does not miss completion between capability minting and registration', async () => {
    const { host, task } = await setup()
    const stub = stubFor(host.hostId)
    const capability = await stub.prepareLedgerWait(call('task.wait', { taskId: task.taskId }))
    host.respond = frame => ({ ok: true, result: { taskId: frame.taskId, state: 'completed' } })
    host.sendEvent([{ kind: 'task', taskId: task.taskId, state: 'completed', updatedAt: Date.now() }])
    const response = await stub.fetch(new Request(`https://internal${WAIT_PATH}`, { headers: { upgrade: 'websocket', [WAIT_HEADER]: capability } }))
    const first = await awaitWaitResponse(response)
    if (first !== null) expect(first).toMatchObject({ ok: true, result: { state: 'completed' } })
    else expect(await stub.execute(call('task.get', { taskId: task.taskId }))).toMatchObject({ ok: true, result: { state: 'completed' } })
    host.socket?.close()
  })

  it('enforces task ownership even with an internally minted subscription capability', async () => {
    const { host, task } = await setup()
    const other = { clientId: 'other-client', clientName: 'Other' }
    expect(await executeHostOperation(env, host.hostId, call('task.wait', { taskId: task.taskId }, { actor: other }))).toMatchObject({ ok: false, error: { code: 'not_found' } })
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(0))
    host.socket?.close()
  })

  it('hibernates a host confirmation wait and wakes it when the owner refuses', async () => {
    const { host } = await setup()
    host.sendEvent([{ kind: 'host-status', ceiling: { level: 'full' }, killSwitch: false, operations: ['terminal.run'] }])
    await eventually(async () => expect((await stubFor(host.hostId).summary()).ceiling?.level).toBe('full'))
    await hub().setGrant(actor.clientId, host.hostId, 'full', 'full')
    const asked = await runOperation(env, caller, 'terminal.run', { hostId: host.hostId, command: 'git status', cwdWorkspaceId: 'ws', timeoutMs: 30_000 })
    expect(asked.ok).toBe(true)
    const id = (asked as { result: ConfirmationInfo }).result.confirmationId
    const pending = runOperation(env, caller, 'confirmation.get', { confirmationId: id, timeoutMs: 25_000 })
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(1))
    await evictDurableObject(stubFor(host.hostId))
    expect(await stubFor(host.hostId).denyConfirmation(id)).toBe(true)
    expect(await pending).toMatchObject({ ok: true, result: { state: 'denied' } })
    await eventually(async () => expect(await countWaits(host.hostId)).toBe(0))
    host.socket?.close()
  })

  it('wakes a hub approval collector immediately on revoke', async () => {
    const { host } = await setup()
    const asked = await runOperation(env, caller, 'hub.export', {})
    expect(asked.ok).toBe(true)
    const id = (asked as { result: ConfirmationInfo }).result.confirmationId
    const pending = runOperation(env, caller, 'confirmation.get', { confirmationId: id, timeoutMs: 25_000 })
    await eventually(async () => expect(await runInDurableObject(hub(), (_instance, state) => state.getWebSockets(WAIT_TAG).length)).toBe(1))
    await evictDurableObject(hub())
    await hub().revokeClient(actor.clientId)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'denied' } })
    host.socket?.close()
  })
})
