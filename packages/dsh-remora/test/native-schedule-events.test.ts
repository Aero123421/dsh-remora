import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAdapter } from '../src/adapter/index.ts'
import { OperationError, type RemoteScheduleRecord, type RemoteScheduleStore } from '../src/ops/types.ts'
import { context, createFake, harness } from './fake-dsh.ts'

function gate() {
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  return { wait, release }
}

function fixture() {
  const dsh = createFake()
  dsh.addWorkspace('w1', '/work/project')
  dsh.addSession('s1', { workspace: 'w1' })
  const h = harness(dsh, { workspaces: ['w1'] })
  let records: RemoteScheduleRecord[] = []
  let removals = 0
  const store: RemoteScheduleStore = {
    list: () => records.map(record => ({ ...record })),
    put: async record => { records = [...records.filter(item => item.scheduleId !== record.scheduleId), { ...record }] },
    remove: async ids => { removals++; records = records.filter(item => !ids.includes(item.scheduleId)) },
  }
  const adapter = buildAdapter(dsh.ctx(), { ...h.deps, remoteSchedules: store })
  const params = { sessionId: 's1', title: 'Remote schedule', prompt: 'fixture', when: { everySeconds: 3600 }, idempotencyKey: 'key' }
  return { dsh, adapter, store, params, removals: () => removals }
}

test('a durable native delete removes its tracker, and adapter disposal waits for that write', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  const created = await f.adapter.handlers['schedule.create']!(f.params, context())
  const entered = gate()
  const resume = gate()
  const remove = f.store.remove
  f.store.remove = async ids => {
    entered.release()
    await resume.wait
    await remove(ids)
  }
  assert.equal((await f.dsh.schedule.delete({ sessionId: 's1', id: created.schedule.scheduleId })).deleted, true)
  await entered.wait
  let disposed = false
  const disposing = f.adapter.dispose().then(() => { disposed = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(disposed, false, 'the durable tracking write is still pending')
  resume.release()
  await disposing
  assert.deepEqual(f.store.list(), [])
  assert.equal(f.dsh.listeners.get('domain/changed')?.length, 0)
})

test('malformed, unrelated and non-deletion native events never remove a tracker', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  const created = await f.adapter.handlers['schedule.create']!(f.params, context())
  const event = { domain: 'schedule', table: 'tasks', operation: 'deleted', key: created.schedule.scheduleId }
  for (const invalid of [
    null, undefined, [], { ...event, domain: 'another-domain' }, { ...event, table: 'another-table' },
    { ...event, operation: 'put' }, { ...event, key: '' }, { ...event, key: 42 },
    { ...event, value: {} }, { ...event, key: 'untracked-local-schedule' },
  ]) f.dsh.fire('domain/changed', invalid)
  await f.adapter.dispose()
  assert.equal(f.store.list().length, 1)
  assert.equal(f.removals(), 0)
  f.dsh.fire('domain/changed', event)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(f.store.list().length, 1, 'the disposed observer no longer receives events')
})

test('catalogue absence and schedule/changed do not confirm a durable native deletion', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  await f.adapter.handlers['schedule.create']!(f.params, context())
  f.dsh.scheduleRows = []
  f.dsh.fire('schedule/changed')
  assert.equal(await f.adapter.removeRemoteSchedules(), 0)
  assert.equal(f.store.list().length, 1)
  for (const params of [f.params, { ...f.params, idempotencyKey: 'new-key' }]) {
    await assert.rejects(f.adapter.handlers['schedule.create']!(params, context()), (error: unknown) => error instanceof OperationError && error.code === 'unavailable')
  }
  assert.equal(f.dsh.calls.filter(call => call.method === 'schedule.create').length, 1)
  assert.equal(f.store.list().length, 1)
})

test('a native deletion during create is recorded after the in-flight retry tracker is saved', async t => {
  const f = fixture()
  t.after(() => f.adapter.dispose())
  const entered = gate()
  const resume = gate()
  const put = f.store.put
  f.store.put = async record => {
    entered.release()
    await resume.wait
    await put(record)
  }
  const creating = f.adapter.handlers['schedule.create']!(f.params, context())
  await entered.wait
  assert.equal(f.store.list().length, 0)
  const nativeId = f.dsh.scheduleRows[0]!.id
  assert.equal((await f.dsh.schedule.delete({ sessionId: 's1', id: nativeId })).deleted, true)
  resume.release()
  await creating
  await f.adapter.dispose()
  assert.deepEqual(f.store.list(), [], 'the queued observer sees and removes the newly saved tracker')
  assert.equal(f.removals(), 1)
})
