import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAdapter } from '../src/adapter/index.ts'
import { JsonDocument } from '../src/core/storage.ts'
import { tasksSpec } from '../src/core/settings.ts'
import { FileTaskStore } from '../src/core/tasks.ts'
import { OperationError } from '../src/ops/types.ts'
import { context, createFake, harness, RemoteError } from './fake-dsh.ts'
import { tempDir } from './helpers.ts'

function gate() {
  let release!: () => void
  let enter!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { enter = resolve })
  return { entered, release, wait: () => { enter(); return held } }
}

async function setup() {
  const tmp = await tempDir('remora-delivery-race-')
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  const session = dsh.addSession('s1', { workspace: 'ws-a', live: true })
  const h = harness(dsh, { workspaces: ['ws-a'], skills: ['review'] })
  const tasks = new FileTaskStore(await JsonDocument.open(tmp.dir, tasksSpec))
  const adapter = buildAdapter(dsh.ctx(), { ...h.deps, tasks })
  return {
    dsh, session, tasks, adapter, events: h.events,
    handlers: adapter.handlers as Required<typeof adapter.handlers>,
    stored: async () => (await JsonDocument.open(tmp.dir, tasksSpec)).value.tasks.find(record => record.taskId === 't1'),
    cleanup: async () => { await adapter.dispose(); await tmp.cleanup() },
  }
}

type Fixture = Awaited<ReturnType<typeof setup>>
const params = { target: { sessionId: 's1' }, prompt: 'harmless /review', idempotencyKey: 'k1' }

function holdPreparation(f: Fixture, stage: 'publish' | 'row' | 'skills' | 'prompt') {
  const hold = gate()
  let armed = true
  const pause = async () => {
    if (!armed || !f.tasks.get('t1')) return
    armed = false
    await hold.wait()
  }
  if (stage === 'publish') {
    const put = f.tasks.put.bind(f.tasks)
    f.tasks.put = async record => { await put(record); await pause() }
  } else if (stage === 'row') {
    const row = f.adapter.runtime.row.bind(f.adapter.runtime)
    f.adapter.runtime.row = async (...args) => { await pause(); return row(...args) }
  } else if (stage === 'skills') {
    const list = f.dsh.sessionSkillCatalog.list
    f.dsh.sessionSkillCatalog.list = async () => { await pause(); return list() }
  } else {
    const prompt = f.dsh.sessionController.prompt
    f.dsh.sessionController.prompt = async request => { await pause(); return prompt(request) }
  }
  return hold
}

for (const stage of ['publish', 'row', 'skills', 'prompt'] as const) {
  for (const reader of ['get', 'watcher'] as const) {
    test(`${stage} preparation stays accepted during ${reader}, then completes`, { timeout: 10_000 }, async () => {
      const f = await setup()
      const hold = holdPreparation(f, stage)
      const pending = f.handlers['task.start'](params, context({ taskId: 't1' }))
      try {
        await hold.entered
        if (reader === 'get') {
          assert.equal((await f.handlers['task.get']({ taskId: 't1' }, context())).state, 'accepted')
        } else {
          f.adapter.watcher.schedule('s1', 0)
          await f.adapter.watcher.idle()
        }
        assert.equal((await f.stored())?.state, 'accepted')
        assert.equal(f.session.inbox.length, 0)
        hold.release()
        assert.equal((await pending).state, 'accepted')
        assert.equal(f.session.inbox.length, 1)
        f.dsh.runTurn('s1')
        assert.equal((await f.handlers['task.get']({ taskId: 't1' }, context())).state, 'completed')
        assert.equal((await f.stored())?.state, 'completed')
        assert.equal(f.events.some(event => event.kind === 'task' && event.state === 'cancelled'), false)
      } finally { hold.release(); await pending.catch(() => undefined); await f.cleanup() }
    })
  }
}

test('delivery after a concurrent read still has a working queue cancellation', { timeout: 10_000 }, async () => {
  const f = await setup()
  const hold = holdPreparation(f, 'row')
  const pending = f.handlers['task.start'](params, context({ taskId: 't1' }))
  try {
    await hold.entered
    await f.handlers['task.get']({ taskId: 't1' }, context())
    hold.release()
    await pending
    assert.deepEqual(await f.handlers['task.cancel']({ taskId: 't1' }, context()), { cancelled: true, how: 'removed-from-queue' })
    assert.equal(f.session.inbox.length, 0)
    assert.equal((await f.stored())?.state, 'cancelled')
    assert.equal((await f.handlers['task.start'](params, context({ taskId: 't1' }))).state, 'cancelled')
    assert.equal(f.dsh.calls.filter(call => call.method === 'prompt').length, 1)
  } finally { hold.release(); await pending.catch(() => undefined); await f.cleanup() }
})

test('prompt failure releases preparation protection and permits an idempotent retry', async () => {
  const f = await setup()
  const prompt = f.dsh.sessionController.prompt
  f.dsh.sessionController.prompt = async () => { throw new RemoteError('session/agent-busy', 'busy') }
  try {
    await assert.rejects(f.handlers['task.start'](params, context({ taskId: 't1' })), OperationError)
    assert.equal((await f.stored())?.state, 'failed')
    f.dsh.sessionController.prompt = prompt
    assert.equal((await f.handlers['task.start'](params, context({ taskId: 't1' }))).state, 'accepted')
    await f.handlers['task.start'](params, context({ taskId: 't1' }))
    assert.equal(f.session.inbox.length, 1)
    f.dsh.runTurn('s1')
    assert.equal((await f.handlers['task.get']({ taskId: 't1' }, context())).state, 'completed')
  } finally { await f.cleanup() }
})

test('unload abort during preparation prevents a late prompt and releases protection', { timeout: 10_000 }, async () => {
  const f = await setup()
  const hold = holdPreparation(f, 'skills')
  const abort = new AbortController()
  const pending = f.handlers['task.start'](params, { ...context({ taskId: 't1' }), signal: abort.signal })
  try {
    await hold.entered
    abort.abort(new OperationError('unavailable', 'Remote operation stopped: unloading'))
    await f.adapter.dispose()
    const rejected = assert.rejects(pending, OperationError)
    hold.release()
    await rejected
    assert.equal(f.dsh.calls.filter(call => call.method === 'prompt').length, 0)
    assert.equal((await f.handlers['task.get']({ taskId: 't1' }, context())).state, 'cancelled')
    assert.equal((await f.stored())?.state, 'cancelled')
  } finally { hold.release(); await pending.catch(() => undefined); await f.cleanup() }
})

for (const stage of ['publish', 'row', 'skills', 'prompt'] as const) {
  test(`explicit cancel during ${stage} preparation removes the delivered queue item`, { timeout: 10_000 }, async () => {
    const f = await setup()
    const hold = holdPreparation(f, stage)
    const pending = f.handlers['task.start'](params, context({ taskId: 't1' }))
    let cancelling: ReturnType<typeof f.handlers['task.cancel']> | undefined
    try {
      await hold.entered
      let checked!: () => void
      const scoped = new Promise<void>(resolve => { checked = resolve })
      let checks = 0
      cancelling = f.handlers['task.cancel']({ taskId: 't1' }, {
        ...context(), assertAuthorized: () => { if (++checks === 2) checked() },
      })
      await scoped
      hold.release()
      assert.deepEqual(await cancelling, { cancelled: true, how: 'removed-from-queue' })
      await pending
      assert.equal(f.session.inbox.length, 0)
      assert.equal((await f.stored())?.state, 'cancelled')
      assert.equal((await f.handlers['task.start'](params, context({ taskId: 't1' }))).state, 'cancelled')
      assert.equal(f.dsh.calls.filter(call => call.method === 'prompt').length, 1)
    } finally { hold.release(); await Promise.allSettled([pending, cancelling]); await f.cleanup() }
  })
}

for (const operation of ['steer', 'resubmit'] as const) {
  test(`${operation} guards its accepted record during delivery preparation`, { timeout: 10_000 }, async () => {
    const f = await setup()
    await f.handlers['task.start'](params, context({ taskId: 'original' }))
    f.dsh.runTurn('s1')
    const hold = holdPreparation(f, 'publish')
    const pending = operation === 'steer'
      ? f.handlers['task.steer']({ sessionId: 's1', prompt: params.prompt, idempotencyKey: 'steer' }, context({ taskId: 't1' }))
      : f.handlers['task.resubmit']({ taskId: 'original', idempotencyKey: 'resubmit' }, context({ taskId: 't1' }))
    try {
      await hold.entered
      assert.equal((await f.handlers['task.get']({ taskId: 't1' }, context())).state, 'accepted')
      hold.release()
      assert.equal((await pending).state, 'accepted')
      assert.equal(f.session.inbox.length, 1)
      assert.deepEqual(await f.handlers['task.cancel']({ taskId: 't1' }, context()), { cancelled: true, how: 'removed-from-queue' })
      assert.equal((await f.stored())?.state, 'cancelled')
    } finally { hold.release(); await pending.catch(() => undefined); await f.cleanup() }
  })
}

test('a terminal state saved during preparation prevents subsequent delivery', { timeout: 10_000 }, async () => {
  const f = await setup()
  const hold = holdPreparation(f, 'skills')
  const pending = f.handlers['task.start'](params, context({ taskId: 't1' }))
  try {
    await hold.entered
    await f.adapter.tasks.sessionGone('s1', 'session disappeared')
    hold.release()
    assert.equal((await pending).state, 'failed')
    assert.equal((await f.stored())?.state, 'failed')
    assert.equal(f.dsh.calls.filter(call => call.method === 'prompt').length, 0)
  } finally { hold.release(); await pending.catch(() => undefined); await f.cleanup() }
})

test('concurrent retries keep preparation protected until every prompt call settles', { timeout: 10_000 }, async () => {
  const f = await setup()
  const first = gate(), second = gate()
  const prompt = f.dsh.sessionController.prompt
  let calls = 0
  f.dsh.sessionController.prompt = async request => {
    await (++calls === 1 ? first : second).wait()
    return prompt(request)
  }
  const pending = f.handlers['task.start'](params, context({ taskId: 't1' }))
  let retry: typeof pending | undefined
  try {
    await first.entered
    retry = f.handlers['task.start'](params, context({ taskId: 't1' }))
    first.release()
    await second.entered
    assert.equal((await f.handlers['task.get']({ taskId: 't1' }, context())).state, 'accepted')
    second.release()
    await Promise.all([pending, retry])
    assert.equal(f.session.inbox.length, 1)
    f.dsh.runTurn('s1')
    assert.equal((await f.handlers['task.get']({ taskId: 't1' }, context())).state, 'completed')
    assert.equal((await f.stored())?.state, 'completed')
  } finally { first.release(); second.release(); await Promise.allSettled([pending, retry]); await f.cleanup() }
})

test('new-session publication stays accepted while its title is being set', { timeout: 10_000 }, async () => {
  const f = await setup()
  const hold = gate()
  const rename = f.dsh.sessionController.rename
  f.dsh.sessionController.rename = async request => { await hold.wait(); return rename(request) }
  const pending = f.handlers['task.start']({ target: { new: { workspaceId: 'ws-a', title: 'temporary' } }, prompt: 'harmless', idempotencyKey: 'new' }, context({ taskId: 't1' }))
  try {
    await hold.entered
    assert.equal((await f.handlers['task.get']({ taskId: 't1' }, context())).state, 'accepted')
    hold.release()
    assert.equal((await pending).state, 'accepted')
    assert.deepEqual(await f.handlers['task.cancel']({ taskId: 't1' }, context()), { cancelled: true, how: 'removed-from-queue' })
    assert.equal((await f.stored())?.state, 'cancelled')
  } finally { hold.release(); await pending.catch(() => undefined); await f.cleanup() }
})

for (const stage of ['before publication', 'during preparation'] as const) {
  test(`watcher snapshot captured ${stage} cannot cancel a later delivery`, { timeout: 10_000 }, async () => {
    const f = await setup()
    const snapshot = gate()
    const publication = stage === 'during preparation' ? holdPreparation(f, 'publish') : undefined
    let pending: ReturnType<typeof f.handlers['task.start']> | undefined
    let watching: Promise<void> | undefined
    const row = f.adapter.runtime.row.bind(f.adapter.runtime)
    const projections = f.adapter.runtime.projections.bind(f.adapter.runtime)
    let captured = false
    let paused = false
    f.adapter.runtime.projections = async (...args) => {
      const values = await projections(...args)
      if (!captured) {
        captured = true
        assert.equal(f.session.inbox.length, 0)
      }
      return values
    }
    f.adapter.runtime.row = async (...args) => {
      // Watcher has already read events and the empty inbox. Hold its scope
      // recheck while publication, prompt and preparation all finish.
      if (captured && !paused) { paused = true; await snapshot.wait() }
      return row(...args)
    }
    try {
      if (publication) {
        pending = f.handlers['task.start'](params, context({ taskId: 't1' }))
        await publication.entered
      }
      f.adapter.watcher.schedule('s1', 0)
      // idle's drain keeps a referenced timer until the unref'ed Watcher timer
      // starts. Awaiting only the barrier can let Node 22 exit before it runs.
      watching = f.adapter.watcher.idle()
      await snapshot.entered
      publication?.release()
      pending ??= f.handlers['task.start'](params, context({ taskId: 't1' }))
      assert.equal((await pending).state, 'accepted')
      assert.equal(f.session.inbox.length, 1)
      snapshot.release()
      await watching
      assert.equal((await f.stored())?.state, 'accepted')
      assert.deepEqual(await f.handlers['task.cancel']({ taskId: 't1' }, context()), { cancelled: true, how: 'removed-from-queue' })
      assert.equal(f.session.inbox.length, 0)
      assert.equal((await f.stored())?.state, 'cancelled')
    } finally { snapshot.release(); publication?.release(); await Promise.allSettled([pending, watching]); await f.cleanup() }
  })
}

test('a status snapshot and an accepted retry cannot cross delivery', { timeout: 10_000 }, async () => {
  const f = await setup()
  const prompt = f.dsh.sessionController.prompt
  f.dsh.sessionController.prompt = async () => { throw new RemoteError('gateway/cancelled', 'cancelled') }
  const snapshot = gate()
  let reading: ReturnType<typeof f.handlers['task.get']> | undefined
  let retry: ReturnType<typeof f.handlers['task.start']> | undefined
  try {
    await assert.rejects(f.handlers['task.start'](params, context({ taskId: 't1' })), OperationError)
    assert.equal((await f.stored())?.state, 'accepted')
    f.dsh.sessionController.prompt = prompt
    const projections = f.adapter.runtime.projections.bind(f.adapter.runtime)
    let armed = true
    f.adapter.runtime.projections = async (...args) => {
      const values = await projections(...args)
      if (armed) { armed = false; await snapshot.wait() }
      return values
    }
    reading = f.handlers['task.get']({ taskId: 't1' }, context())
    await snapshot.entered
    retry = f.handlers['task.start'](params, context({ taskId: 't1' }))
    snapshot.release()
    await Promise.all([reading, retry])
    // Either the read settles cancellation first and the retry does not send,
    // or delivery wins and the ledger remains accepted with a removable item.
    const stored = await f.stored()
    assert.equal(f.session.inbox.length, stored?.state === 'cancelled' ? 0 : 1)
    if (stored?.state === 'accepted') {
      assert.deepEqual(await f.handlers['task.cancel']({ taskId: 't1' }, context()), { cancelled: true, how: 'removed-from-queue' })
    }
    assert.equal(f.session.inbox.length, 0)
  } finally { snapshot.release(); await Promise.allSettled([reading, retry]); await f.cleanup() }
})
