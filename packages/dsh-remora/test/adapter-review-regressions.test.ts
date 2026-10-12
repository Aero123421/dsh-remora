import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OWNER_CLIENT_ID, type AttentionEvent } from '@dsh-remora/protocol'
import { buildAdapter } from '../src/adapter/index.ts'
import { OperationError } from '../src/ops/types.ts'
import { context, createFake, harness, RemoteError } from './fake-dsh.ts'

function fixture() {
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  dsh.addSession('s1', { workspace: 'ws-a', live: true })
  const h = harness(dsh, { workspaces: ['ws-a'] })
  let allowed = true
  h.policy.canAccessSession = () => allowed
  const adapter = buildAdapter(dsh.ctx(), h.deps)
  return {
    dsh, ...h, adapter, handlers: adapter.handlers as Required<typeof adapter.handlers>,
    revoke: () => { allowed = false; adapter.settingsChanged() },
  }
}

async function start(f: ReturnType<typeof fixture>, taskId = 't1') {
  return f.handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'do it', idempotencyKey: taskId }, context({ taskId }))
}

const isCode = (code: string) => (error: unknown) => error instanceof OperationError && error.code === code

function gate() {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { waiting, release }
}

test('completed task reads respect current scope for their client and the hub owner', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  await start(f)
  f.dsh.runTurn('s1', { reply: 'private reply' })
  assert.equal((await f.handlers['task.get']({ taskId: 't1' }, context())).result?.reply, 'private reply')
  f.revoke()
  const before = f.dsh.calls.filter(call => call.method === 'inspect').length
  await assert.rejects(f.handlers['task.get']({ taskId: 't1' }, context()), isCode('denied'))
  await assert.rejects(f.handlers['task.wait']({ taskId: 't1', timeoutMs: 0 }, context({ clientId: OWNER_CLIENT_ID })), isCode('denied'))
  assert.equal(f.dsh.calls.filter(call => call.method === 'inspect').length, before, 'revoked reads never inspect private logs')
})

test('scope is checked again when a completed task content read finishes', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  await start(f)
  f.dsh.runTurn('s1', { reply: 'private reply' })
  await f.handlers['task.get']({ taskId: 't1' }, context())
  const entered = gate()
  const resume = gate()
  const inspect = f.dsh.sessionController.inspect
  f.dsh.sessionController.inspect = async id => {
    const snapshot = await inspect(id)
    entered.release()
    await resume.waiting
    return snapshot
  }
  const read = f.handlers['task.get']({ taskId: 't1' }, context())
  await entered.waiting
  f.revoke()
  resume.release()
  await assert.rejects(read, isCode('denied'))
})

test('a narrowed scope wakes an in-progress task.wait and clears cached attention', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  f.adapter.start()
  await start(f)
  const waiting = f.handlers['task.wait']({ taskId: 't1', timeoutMs: 10_000 }, context())
  // All fake DSH calls settle in microtasks, so this barrier lets wait register its listener.
  await new Promise<void>(resolve => setImmediate(resolve))
  f.revoke()
  await assert.rejects(waiting, isCode('denied'))
  await f.adapter.watcher.idle()
  assert.deepEqual(f.events.filter((event): event is AttentionEvent => event.kind === 'attention').at(-1)?.items, [])
})

test('attention already sent to the hub is cleared when its workspace leaves scope', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  f.adapter.start()
  f.dsh.append('s1', 'turn/start', { turn: 1 })
  f.dsh.append('s1', 'tool/call', { turn: 1, callId: 'q1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Private question?' }] }) })
  await f.adapter.watcher.idle()
  assert.equal(f.events.filter((event): event is AttentionEvent => event.kind === 'attention').at(-1)?.items.length, 1)
  f.revoke()
  await f.adapter.watcher.idle()
  assert.deepEqual(f.events.filter((event): event is AttentionEvent => event.kind === 'attention').at(-1)?.items, [])
})

test('the hub owner may inspect and cancel client tasks, while another client cannot', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  await start(f)
  f.dsh.runTurn('s1', { reply: 'owner-visible reply' })
  const owner = context({ clientId: OWNER_CLIENT_ID })
  assert.equal((await f.handlers['task.get']({ taskId: 't1' }, owner)).result?.reply, 'owner-visible reply')
  assert.equal((await f.handlers['task.wait']({ taskId: 't1', timeoutMs: 0 }, owner)).state, 'completed')
  await assert.rejects(f.handlers['task.get']({ taskId: 't1' }, context({ clientId: 'other' })), isCode('not_found'))
  await start(f, 't2')
  await assert.rejects(f.handlers['task.cancel']({ taskId: 't2' }, context({ clientId: 'other' })), isCode('not_found'))
  assert.deepEqual(await f.handlers['task.cancel']({ taskId: 't2' }, owner), { cancelled: true, how: 'removed-from-queue' })
  assert.equal(f.tasks.get('t2')?.clientId, 'client-1', 'owner actions do not change task ownership')
})

test('task.cancel stops its running turn if DSH claimed the queued prompt before removal', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  await start(f)
  const entered = gate()
  const claimed = gate()
  f.dsh.sessionController.updateQueue = async () => {
    entered.release()
    await claimed.waiting
    throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending')
  }
  const cancelling = f.handlers['task.cancel']({ taskId: 't1' }, context())
  await entered.waiting
  f.dsh.runTurn('s1', { leaveOpen: true })
  claimed.release()
  assert.deepEqual(await cancelling, { cancelled: true, how: 'stopped-session' })
  assert.equal(f.dsh.calls.filter(call => call.method === 'cancel').length, 1)
  assert.equal(f.tasks.get('t1')?.state, 'cancelled')
})

test('a lost queue removal never cancels a subsequent human turn or reports successful cancellation', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  await start(f)
  f.dsh.sessionController.updateQueue = async () => {
    f.dsh.runTurn('s1', { reply: 'already done' })
    f.dsh.append('s1', 'turn/start', { turn: 2 })
    f.dsh.append('s1', 'user/message', { content: [{ type: 'text', text: 'local work' }], source: { kind: 'user' } })
    f.dsh.sessions.get('s1')!.agent!.status = 'running'
    throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending')
  }
  // Completion evaluation includes session activity, so the old task may still say running.
  await assert.rejects(f.handlers['task.cancel']({ taskId: 't1' }, context()), isCode('conflict'))
  assert.equal(f.dsh.calls.filter(call => call.method === 'cancel').length, 0)
  assert.notEqual(f.tasks.get('t1')?.state, 'cancelled')
})

test('queue claim before the task is logged returns a retryable conflict, not cancellation', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  await start(f)
  f.dsh.sessionController.updateQueue = async () => {
    const session = f.dsh.sessions.get('s1')!
    session.inbox = []
    session.agent!.status = 'running'
    f.dsh.syncInbox(session)
    throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending')
  }
  await assert.rejects(f.handlers['task.cancel']({ taskId: 't1' }, context()), isCode('conflict'))
  assert.equal(f.dsh.calls.filter(call => call.method === 'cancel').length, 0)
  assert.notEqual(f.tasks.get('t1')?.state, 'cancelled')
})

test('a task that finished before queue removal is reported already finished', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  await start(f)
  f.dsh.sessionController.updateQueue = async () => {
    f.dsh.runTurn('s1', { reply: 'finished' })
    throw new RemoteError('session/queue-item-not-found', 'queued item is no longer pending')
  }
  assert.deepEqual(await f.handlers['task.cancel']({ taskId: 't1' }, context()), { cancelled: false, how: 'already-finished' })
  assert.equal(f.tasks.get('t1')?.state, 'completed')
  assert.equal(f.dsh.calls.filter(call => call.method === 'cancel').length, 0)
})

test('a deleted session settles its active task with gone metadata without reading its log', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  await start(f)
  f.dsh.sessions.delete('s1')
  const inspected = f.dsh.calls.filter(call => call.method === 'inspect').length
  const info = await f.handlers['task.get']({ taskId: 't1' }, context())
  assert.equal(info.state, 'failed')
  assert.equal(info.error?.code, 'gone')
  assert.equal(f.tasks.get('t1')?.state, 'failed')
  assert.equal(f.adapter.tasks.active().length, 0)
  assert.equal(f.dsh.calls.filter(call => call.method === 'inspect').length, inspected)
  assert.ok(f.events.some(event => event.kind === 'task' && event.taskId === 't1' && event.state === 'failed' && event.error?.code === 'gone'))
})

test('the watcher settles tasks of a deleted session instead of keeping them active', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  f.adapter.start()
  await start(f)
  const inspected = f.dsh.calls.filter(call => call.method === 'inspect').length
  f.dsh.sessions.delete('s1')
  f.dsh.fire('api-session/status', 's1', false)
  await f.adapter.watcher.idle()
  assert.equal(f.tasks.get('t1')?.state, 'failed')
  assert.equal(f.tasks.get('t1')?.error?.code, 'gone')
  assert.equal(f.adapter.tasks.active().length, 0)
  assert.equal(f.dsh.calls.filter(call => call.method === 'inspect').length, inspected)
})
