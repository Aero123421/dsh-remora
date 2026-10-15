import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { ExecuteResult } from '../../src/host-do.ts'
import { runOperation, type Caller } from '../../src/ops.ts'
import type { TaskInfo } from '../../src/vendor/protocol/index.ts'
import { FakeHost, eventually, setupOwner } from './helpers.ts'

const caller: Caller = { clientId: 'delivery-reader', clientName: 'Delivery', kind: 'client', scopes: ['dsh.read', 'dsh.content', 'dsh.tasks', 'dsh.admin'] }
const hub = () => env.HUB.get(env.HUB.idFromName('hub'))
const hostObject = (hostId: string) => env.HOST.get(env.HOST.idFromName(hostId))
const resultOf = <T>(outcome: ExecuteResult): T => {
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
  return outcome.result as T
}

async function setup() {
  const owner = await setupOwner()
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

const startParams = (hostId: string, idempotencyKey: string) => ({ hostId, target: { sessionId: 's' }, prompt: 'secret prompt', idempotencyKey })

describe('unconfirmed delivery', () => {
  it('fails a task that was never sent and keeps one that was sent but not answered', async () => {
    const { owner, host } = await setup()
    const stub = hostObject(host.hostId)
    await offline(host)
    const never = resultOf<TaskInfo>(await runOperation(env, caller, 'task.start', startParams(host.hostId, 'never-sent')))
    const sent = resultOf<TaskInfo>(await runOperation(env, caller, 'task.start', startParams(host.hostId, 'sent-unknown')))
    await runInDurableObject(stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ frame: string }>('SELECT frame FROM tasks WHERE task_id = ?', sent.taskId).one()
      const frame = JSON.parse(row.frame) as Record<string, unknown>
      frame.deliveryStarted = true
      state.storage.sql.exec('UPDATE tasks SET frame = ?, expires_at = ? WHERE task_id = ?', JSON.stringify(frame), Date.now() - 1, sent.taskId)
      state.storage.sql.exec('UPDATE tasks SET expires_at = ? WHERE task_id = ?', Date.now() - 1, never.taskId)
    })
    await runInDurableObject(stub, instance => instance.alarm())
    const neverRow = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec('SELECT * FROM tasks WHERE task_id = ?', never.taskId).one())
    expect(neverRow).toMatchObject({ state: 'failed', params: null, frame: null })
    expect(String(neverRow.error)).toContain('never delivered')
    const sentRow = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ state: string; params: string | null; frame: string | null; delivery_id: string; error: string | null }>('SELECT * FROM tasks WHERE task_id = ?', sent.taskId).one())
    expect(sentRow.state).toBe('parked')
    expect(sentRow.params).toBeNull()
    expect(sentRow.frame).not.toBeNull()
    expect(sentRow.delivery_id).toBeTruthy()
    expect(String(sentRow.error)).not.toContain('never delivered')
    const again = resultOf<TaskInfo>(await runOperation(env, caller, 'task.start', startParams(host.hostId, 'sent-unknown')))
    expect(again.taskId).toBe(sent.taskId)
    const count = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE idempotency_key = ?', 'sent-unknown').one().n)
    expect(count).toBe(1)
    const page = await owner.browser.fetch(`/tasks/${sent.taskId}`)
    const html = await page.text()
    expect(html).not.toContain('never delivered')
    expect(html).not.toContain('ホストがオフラインのため保留しています')
    expect(html).toContain('結果はまだ届いていません')

    let answered = false
    host.respond = frame => {
      if (frame.op === 'task.get' && !answered) {
        answered = true
        host.socket?.send(JSON.stringify({ t: 'response', id: sentRow.delivery_id, ok: true, result: { taskId: sent.taskId, sessionId: 's', state: 'running', updatedAt: Date.now() } }))
      }
      if (frame.op === 'task.get') return { ok: true, result: { taskId: sent.taskId, sessionId: 's', state: 'running', updatedAt: Date.now() } }
      if (frame.op === 'task.cancel') return { ok: true, result: { cancelled: true, how: 'stopped-session' } }
      return undefined
    }
    await host.connect()
    await host.next('ready')
    await eventually(async () => expect((await stub.summary()).running.some(task => task.taskId === sent.taskId && task.state === 'running')).toBe(true))
    expect(host.frames.filter(frame => frame.t === 'request' && frame.op === 'task.start')).toHaveLength(0)
    expect(host.frames.some(frame => frame.t === 'request' && frame.op === 'task.get')).toBe(true)
    const cancelled = await runOperation(env, caller, 'task.cancel', { taskId: sent.taskId })
    expect(cancelled).toMatchObject({ ok: true, result: { cancelled: true, how: 'stopped-session' } })
    host.respond = frame => frame.op === 'task.get'
      ? { ok: true, result: { taskId: sent.taskId, sessionId: 's', state: 'completed', updatedAt: Date.now() } }
      : undefined
    const read = resultOf<TaskInfo>(await runOperation(env, caller, 'task.get', { taskId: sent.taskId }))
    expect(read.state).toBe('completed')
    const late = sentRow.delivery_id
    host.socket!.send(JSON.stringify({ t: 'response', id: late, ok: true, result: { taskId: sent.taskId, sessionId: 's', state: 'accepted', updatedAt: Date.now() } }))
    await eventually(async () => expect((await stub.summary()).recent.some(task => task.taskId === sent.taskId && task.state === 'completed')).toBe(true))
    host.socket?.close(1000, 'done')
  })
})
