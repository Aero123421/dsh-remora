import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { OWNER_CLIENT_ID } from '../../src/config.ts'
import type { ExecuteCall, ExecuteResult, HostDO } from '../../src/host-do.ts'
import { runOperation } from '../../src/ops.ts'
import type { HubFrame } from '../../src/vendor/protocol/index.ts'
import { FakeHost, eventually, setupOwner } from './helpers.ts'

const actor = { clientId: 'client-recovery', clientName: 'Recovery client' }
const call = (op: string, params: Record<string, unknown>): ExecuteCall => ({
  op, params, actor, scopes: ['dsh.read', 'dsh.content', 'dsh.tasks'], grant: { level: 'request' },
})
const hostObject = (hostId: string) => env.HOST.get(env.HOST.idFromName(hostId))

async function startTask(host: FakeHost): Promise<string> {
  // Workers RPC omits the `unknown` result from its generated return type.
  const outcome = await hostObject(host.hostId).execute(call('task.start', { target: { sessionId: 's1' }, prompt: 'finish offline', idempotencyKey: 'recovery-1' })) as ExecuteResult
  if (!outcome.ok || !outcome.result || typeof outcome.result !== 'object' || !('taskId' in outcome.result) || typeof outcome.result.taskId !== 'string') {
    throw new Error('task.start did not return a task id')
  }
  return outcome.result.taskId
}

async function connectedHost() {
  const owner = await setupOwner()
  const host = await FakeHost.create()
  await host.pair(owner)
  host.respond = frame => ({ ok: true, result: { taskId: frame.taskId, sessionId: 's1', state: 'accepted' } })
  await host.connect()
  await host.next('ready')
  return host
}

describe('task ledger recovery', () => {
  it.each(['task.get', 'task.wait'])('reconciles a lost completion after host restart through %s', async op => {
    const host = await connectedHost()
    const stub = hostObject(host.hostId)
    const taskId = await startTask(host)
    host.sendEvent([{ kind: 'task', taskId, sessionId: 's1', state: 'running', updatedAt: Date.now() }])
    await eventually(async () => expect((await stub.summary()).running[0]?.state).toBe('running'))
    host.socket?.close(1000, 'restart before completion can be delivered')
    await eventually(async () => expect((await stub.summary()).online).toBe(false))

    const back = await FakeHost.create()
    Object.assign(back, { keys: host.keys, publicKey: host.publicKey, hostId: host.hostId })
    const requests: Extract<HubFrame, { t: 'request' }>[] = []
    back.respond = frame => {
      requests.push(frame)
      return { ok: true, result: { taskId, sessionId: 's1', state: 'completed', updatedAt: Date.now(), result: { reply: 'finished while offline', changes: [{ path: 'done.txt', status: 'added' }] } } }
    }
    await back.connect()
    await back.next('ready')

    // No completion event is replayed by this new host process.
    const outcome = await stub.execute(call(op, { taskId, ...(op === 'task.wait' ? { timeoutMs: 10_000 } : {}) }))
    expect(outcome).toMatchObject({ ok: true, result: { taskId, state: 'completed', result: { reply: 'finished while offline' } } })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ op: 'task.get', actor, grant: { level: 'request' }, scopes: call(op, {}).scopes })
    const summary = await stub.summary()
    expect(summary.running).toHaveLength(0)
    expect(summary.recent[0]).toMatchObject({ taskId, state: 'completed' })

    const rows = await runInDurableObject(stub, (_host: HostDO, state) => state.storage.sql.exec('SELECT * FROM tasks').toArray())
    expect(JSON.stringify(rows)).not.toContain('finished while offline')
    expect(JSON.stringify(rows)).not.toContain('done.txt')
    // A delayed active event cannot undo the recovered terminal record.
    back.sendEvent([{ kind: 'task', taskId, state: 'running', updatedAt: Date.now() }])
    back.socket?.close(1000, 'done')
    await eventually(async () => expect((await stub.summary()).online).toBe(false))
    expect(await stub.execute(call('task.get', { taskId }))).toMatchObject({ ok: true, result: { taskId, state: 'completed' } })
  })

  it('queries again when a wait ends without an event', async () => {
    const host = await connectedHost()
    const taskId = await startTask(host)
    let reads = 0
    host.respond = frame => {
      expect(frame.op).toBe('task.get')
      reads++
      return { ok: true, result: { taskId, sessionId: 's1', state: reads === 1 ? 'running' : 'completed', result: reads === 1 ? undefined : { reply: 'no event' } } }
    }
    const outcome = await hostObject(host.hostId).execute(call('task.wait', { taskId, timeoutMs: 1 }))
    expect(outcome).toMatchObject({ ok: true, result: { state: 'completed', result: { reply: 'no event' } } })
    expect(reads).toBe(2)
    host.socket?.close(1000, 'done')
  })

  it('returns current host scope denials instead of a cached task record', async () => {
    const host = await connectedHost()
    const taskId = await startTask(host)
    host.respond = () => ({ ok: false, error: { code: 'denied', message: 'Session left the Remora scope.', denial: { layer: 'dsh', reason: 'scope' } } })
    for (const op of ['task.get', 'task.wait']) {
      expect(await hostObject(host.hostId).execute(call(op, { taskId, timeoutMs: 0 }))).toMatchObject({ ok: false, error: { code: 'denied', message: 'Session left the Remora scope.' } })
    }
    expect((await hostObject(host.hostId).summary()).running[0]).toMatchObject({ taskId, state: 'accepted' })
    host.socket?.close(1000, 'done')
  })

  it('settles a task whose session is gone even if its failure event was lost', async () => {
    const host = await connectedHost()
    const taskId = await startTask(host)
    host.respond = () => ({ ok: false, error: { code: 'gone', message: 'The session was deleted.' } })
    const stub = hostObject(host.hostId)
    expect(await stub.execute(call('task.get', { taskId }))).toMatchObject({ ok: false, error: { code: 'gone' } })
    const summary = await stub.summary()
    expect(summary.running).toHaveLength(0)
    expect(summary.recent[0]).toMatchObject({ taskId, state: 'failed', error: { code: 'gone' } })
    host.socket?.close(1000, 'done')
  })

  it('rejects the owner identity from a token client before forwarding', async () => {
    const host = await connectedHost()
    const taskId = await startTask(host)
    const before = host.frames.length
    const outcome = await runOperation(env, { clientId: OWNER_CLIENT_ID, clientName: 'forged owner', kind: 'client', scopes: call('task.get', {}).scopes }, 'task.get', { taskId })
    expect(outcome).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(host.frames.length).toBe(before)
    host.socket?.close(1000, 'done')
  })
})
