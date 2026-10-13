import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAdapter } from '../src/adapter/index.ts'
import { OperationError } from '../src/ops/types.ts'
import { context, createFake, harness } from './fake-dsh.ts'

function gate() {
  let release!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  return { waiting, release }
}

/** Capture a native response, then let the owner change policy before its consumer resumes. */
function pause<F extends (...args: any[]) => Promise<any>>(original: F) {
  const entered = gate()
  const resume = gate()
  const call = async (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> => {
    const value = await original(...args)
    entered.release()
    await resume.waiting
    return value
  }
  return { call, entered: entered.waiting, release: resume.release }
}

function setup() {
  const dsh = createFake()
  const a = dsh.addWorkspace('ws-a', '/tmp')
  const b = dsh.addWorkspace('ws-b', '/work/b')
  dsh.addSession('s1', { workspace: 'ws-a', live: true, title: 'Private title' })
  dsh.append('s1', 'assistant/message', { message: { content: [{ type: 'text', text: 'private answer' }] } })
  const h = harness(dsh, { workspaces: ['ws-a'], skills: ['review'] })
  let goalsCreated = 0
  const host = dsh.ctx()
  const get = host.get
  host.get = (name: string) => name === 'goals' ? {
    get: () => null,
    create: () => { goalsCreated++ },
  } : get(name)
  const adapter = buildAdapter(host, h.deps)
  const controller = new AbortController()
  let authorized = true
  const request = { ...context({ taskId: 't1' }), signal: controller.signal, assertAuthorized: () => {
    if (!authorized) throw new OperationError('denied', 'permission narrowed')
  } }
  return {
    dsh, ...h, adapter, request, controller, handlers: adapter.handlers as Required<typeof adapter.handlers>,
    goalCount: () => goalsCreated,
    revoke: () => { authorized = false },
    narrow: () => { h.policy.canAccessSession = () => false },
    move: () => { (a.sessionIds as string[]).splice(0); (b.sessionIds as string[]).push('s1') },
  }
}

const denied = (error: unknown) => error instanceof OperationError && error.code === 'denied'

for (const change of ['permission', 'scope', 'workspace', 'trust', 'archive', 'abort', 'unchanged'] as const) {
  test(`goal creation rechecks ${change} after an Agent lookup`, async t => {
    const f = setup()
    t.after(() => f.adapter.dispose())
    const barrier = pause(f.dsh.sessionController.resolveAgent)
    f.dsh.sessionController.resolveAgent = barrier.call
    const pending = f.handlers['goal.manage']({ sessionId: 's1', action: 'set', goal: 'run it' }, f.request)
    await barrier.entered
    if (change === 'permission') f.revoke()
    if (change === 'scope') f.narrow()
    if (change === 'workspace') f.move()
    if (change === 'trust') await f.policy.markUntrustedWorkspace('ws-a')
    if (change === 'archive') f.dsh.archived.push('s1')
    if (change === 'abort') f.controller.abort(new OperationError('unavailable', 'cancelled'))
    barrier.release()
    if (change === 'unchanged') {
      await pending
      assert.equal(f.goalCount(), 1)
    } else {
      await assert.rejects(pending, change === 'archive'
        ? (error: unknown) => error instanceof OperationError && error.code === 'conflict'
        : change === 'abort' ? /cancelled/ : denied)
      assert.equal(f.goalCount(), 0)
    }
  })
}

for (const change of ['scope', 'workspace', 'permission', 'abort', 'unchanged'] as const) {
  test(`transcript reads recheck ${change} after inspect returns`, async t => {
    const f = setup()
    t.after(() => f.adapter.dispose())
    const barrier = pause(f.dsh.sessionController.inspect)
    f.dsh.sessionController.inspect = barrier.call
    const pending = f.handlers['session.read']({ sessionId: 's1', depth: 'page' }, f.request)
    await barrier.entered
    if (change === 'scope') f.narrow()
    if (change === 'workspace') f.move()
    if (change === 'permission') f.revoke()
    if (change === 'abort') f.controller.abort(new OperationError('unavailable', 'cancelled'))
    barrier.release()
    if (change === 'unchanged') assert.ok((await pending).items?.some(item => item.text === 'private answer'))
    else await assert.rejects(pending, change === 'abort' ? /cancelled/ : denied)
  })
}

test('a subagent read follows its parent workspace after the parent moves', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  f.dsh.addSession('child', { origin: 'subagent', parent: 's1' })
  const barrier = pause(f.dsh.sessionController.inspect)
  f.dsh.sessionController.inspect = barrier.call
  const pending = f.handlers['session.read']({ sessionId: 'child', depth: 'page' }, f.request)
  await barrier.entered
  f.move()
  barrier.release()
  await assert.rejects(pending, denied)
})

test('model selection rechecks permission after its catalog loads', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  const barrier = pause(f.dsh.sessionController.modelCatalog)
  f.dsh.sessionController.modelCatalog = barrier.call
  const pending = f.handlers['model.select']({ sessionId: 's1', model: 'deepseek-chat' }, f.request)
  await barrier.entered
  f.revoke()
  barrier.release()
  await assert.rejects(pending, denied)
  assert.equal(f.dsh.calls.filter(call => call.method === 'selectModel').length, 0)
})

test('commands recheck the command allow-list after the Agent lookup', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  const barrier = pause(f.dsh.sessionController.resolveAgent)
  f.dsh.sessionController.resolveAgent = barrier.call
  const pending = f.handlers['command.run']({ sessionId: 's1', command: '/compact' }, f.request)
  await barrier.entered
  f.policy.isAllowedCommand = () => false
  barrier.release()
  await assert.rejects(pending, denied)
  assert.equal(f.dsh.calls.filter(call => call.method === 'command').length, 0)
})

for (const change of ['scope', 'trust', 'permission'] as const) {
  test(`schedule creation rechecks ${change} after its catalog loads`, async t => {
    const f = setup()
    t.after(() => f.adapter.dispose())
    const barrier = pause(f.dsh.schedule.catalog)
    f.dsh.schedule.catalog = barrier.call
    const pending = f.handlers['schedule.create']({ sessionId: 's1', title: 'Later', prompt: 'private prompt', when: { afterSeconds: 60 }, idempotencyKey: 'later' }, f.request)
    await barrier.entered
    if (change === 'scope') f.narrow()
    if (change === 'trust') await f.policy.markUntrustedWorkspace('ws-a')
    if (change === 'permission') f.revoke()
    barrier.release()
    await assert.rejects(pending, denied)
    assert.equal(f.dsh.calls.filter(call => call.method === 'schedule.create').length, 0)
  })
}

test('schedule list removes private prompts when scope narrows during catalog loading', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  await f.handlers['schedule.create']({ sessionId: 's1', title: 'Later', prompt: 'private prompt', when: { afterSeconds: 60 }, idempotencyKey: 'later' }, f.request)
  const barrier = pause(f.dsh.schedule.catalog)
  f.dsh.schedule.catalog = barrier.call
  const pending = f.handlers['schedules.list']({}, f.request)
  await barrier.entered
  f.narrow()
  barrier.release()
  assert.deepEqual((await pending).schedules, [])
})

test('search removes already collected hits when scope narrows during a later session read', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  f.dsh.addSession('s2', { workspace: 'ws-a', updatedAt: 0 })
  const inspect = f.dsh.sessionController.inspect
  const barrier = pause(inspect)
  f.dsh.sessionController.inspect = id => id === 's2' ? barrier.call(id) : inspect(id)
  const pending = f.handlers['sessions.search']({ query: 'private' }, f.request)
  await barrier.entered
  f.narrow()
  barrier.release()
  assert.deepEqual((await pending).hits, [])
})

for (const change of ['scope', 'skill', 'permission'] as const) {
  test(`prompt delivery rechecks ${change} after its write-ahead record is persisted`, async t => {
    const f = setup()
    t.after(() => f.adapter.dispose())
    const barrier = pause(f.tasks.put.bind(f.tasks))
    f.tasks.put = barrier.call
    const pending = f.handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'do it', skills: ['review'], idempotencyKey: 'start' }, f.request)
    await barrier.entered
    if (change === 'scope') f.narrow()
    if (change === 'skill') f.policy.isAllowedSkill = () => false
    if (change === 'permission') f.revoke()
    barrier.release()
    await assert.rejects(pending, denied)
    assert.equal(f.dsh.calls.filter(call => call.method === 'prompt').length, 0)
    assert.ok(f.tasks.get('t1'), 'the durable retry record remains intact')
  })
}

test('terminal execution rechecks permission after resolving the shell', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  const barrier = pause(f.dsh.subprocess.resolveExecutable)
  f.dsh.subprocess.resolveExecutable = barrier.call
  const pending = f.handlers['terminal.run']({ cwdWorkspaceId: 'ws-a', command: 'true' }, f.request)
  await barrier.entered
  f.revoke()
  barrier.release()
  await assert.rejects(pending, denied)
  assert.equal(f.dsh.calls.filter(call => call.method === 'spawn').length, 0)
})

test('a late question answer cannot resume the Agent after inspect finishes under revoked permission', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  f.dsh.sessions.get('s1')!.values.userQuestions = { active: [{
    callId: 'q1', state: 'continued', questions: [{ id: 'question', question: 'Proceed?', options: [{ label: 'Yes' }] }],
  }] } as any
  const barrier = pause(f.dsh.sessionController.inspect)
  f.dsh.sessionController.inspect = barrier.call
  const pending = f.handlers['attention.respond']({ sessionId: 's1', attentionId: 'q1', answer: { optionId: '0' } }, f.request)
  await barrier.entered
  f.revoke()
  barrier.release()
  await assert.rejects(pending, denied)
  assert.deepEqual(f.dsh.answers, [])
})

test('forking at a historical turn cannot create a session after its source leaves scope', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  f.dsh.append('s1', 'turn/end', { turn: 1 })
  const barrier = pause(f.dsh.sessionController.inspect)
  f.dsh.sessionController.inspect = barrier.call
  const pending = f.handlers['session.fork']({ sessionId: 's1', atTurn: 1 }, f.request)
  await barrier.entered
  f.narrow()
  barrier.release()
  await assert.rejects(pending, denied)
  assert.equal(f.dsh.calls.filter(call => call.method === 'fork').length, 0)
})

test('queue cancellation rechecks scope after its projection read', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  await f.handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'work', idempotencyKey: 'start' }, f.request)
  const barrier = pause(f.dsh.sessionController.projections)
  f.dsh.sessionController.projections = barrier.call
  const pending = f.handlers['task.cancel']({ taskId: 't1' }, f.request)
  await barrier.entered
  f.narrow()
  barrier.release()
  await assert.rejects(pending, denied)
  assert.equal(f.dsh.calls.filter(call => call.method === 'updateQueue').length, 0)
  assert.equal(f.dsh.sessions.get('s1')!.inbox.length, 1)
})

test('a schedule accepted just before revocation still gets tracked for mandatory cleanup', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  const barrier = pause(f.dsh.schedule.create)
  f.dsh.schedule.create = barrier.call
  const pending = f.handlers['schedule.create']({ sessionId: 's1', title: 'Later', prompt: 'work', when: { afterSeconds: 60 }, idempotencyKey: 'later' }, f.request)
  await barrier.entered
  f.revoke()
  barrier.release()
  await assert.rejects(pending, denied)
  assert.equal(f.dsh.scheduleRows.length, 1)
  assert.equal(await f.adapter.removeRemoteSchedules(), 1)
  assert.equal(f.dsh.scheduleRows.length, 0)
})

test('terminal execution rejects an in-place workspace path change during shell lookup', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  const barrier = pause(f.dsh.subprocess.resolveExecutable)
  f.dsh.subprocess.resolveExecutable = barrier.call
  const pending = f.handlers['terminal.run']({ cwdWorkspaceId: 'ws-a', command: 'true' }, f.request)
  await barrier.entered
  f.dsh.workspaces[0]!.path = '/different'
  barrier.release()
  await assert.rejects(pending, denied)
  assert.equal(f.dsh.calls.filter(call => call.method === 'spawn').length, 0)
})

test('getter-backed native workspace entities are captured by value and work for terminal commands', async t => {
  const f = setup()
  t.after(() => f.adapter.dispose())
  const data = f.dsh.workspaces[0]!
  class WorkspaceEntity {
    get id() { return data.id }
    get path() { return data.path }
    get title() { return data.title }
    get createdAt() { return data.createdAt }
    get updatedAt() { return data.updatedAt }
    get sessionIds() { return data.sessionIds }
  }
  f.dsh.workspaces[0] = new WorkspaceEntity()
  const snapshot = f.adapter.runtime.workspace('ws-a')
  assert.deepEqual(snapshot, data)
  assert.notEqual(snapshot.sessionIds, data.sessionIds)
  const result = await f.handlers['terminal.run']({ cwdWorkspaceId: 'ws-a', command: 'printf getter-workspace' }, f.request)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'getter-workspace')
  data.path = '/changed'
  const sessionIds = data.sessionIds as string[]
  sessionIds.push('s2')
  assert.equal(snapshot.path, '/tmp')
  assert.deepEqual(snapshot.sessionIds, ['s1'])
  assert.throws(() => f.adapter.runtime.assertWorkspace(snapshot, f.request), denied)
})
