import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAdapter } from '../src/adapter/index.ts'
import { FileRemoteScheduleStore, remoteSchedulesSpec } from '../src/core/remote-schedules.ts'
import { JsonDocument } from '../src/core/storage.ts'
import { OperationError } from '../src/ops/types.ts'
import { context, createFake, harness } from './fake-dsh.ts'
import { tempDir } from './helpers.ts'

test('schedule idempotency survives a reopened store and rejects changed retry content', async t => {
  const f = await tempDir()
  t.after(f.cleanup)
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  dsh.addSession('s1', { workspace: 'ws-a' })
  dsh.addSession('s2', { workspace: 'ws-a' })
  const h = harness(dsh, { workspaces: ['ws-a'] })
  const store = new FileRemoteScheduleStore(await JsonDocument.open(f.dir, remoteSchedulesSpec))
  const first = buildAdapter(dsh.ctx(), { ...h.deps, remoteSchedules: store })
  t.after(() => first.dispose())
  const params = { sessionId: 's1', title: 'Recurring', prompt: 'Keep the prompt only in DSH', when: { everySeconds: 3600 }, idempotencyKey: 'stable' }
  const created = await first.handlers['schedule.create']!(params, context())
  const reopened = new FileRemoteScheduleStore(await JsonDocument.open(f.dir, remoteSchedulesSpec))
  const next = buildAdapter(dsh.ctx(), { ...h.deps, remoteSchedules: reopened })
  t.after(() => next.dispose())
  assert.equal((await next.handlers['schedule.create']!(params, context())).schedule.scheduleId, created.schedule.scheduleId)
  assert.equal(dsh.scheduleRows.length, 1)
  for (const change of [{ sessionId: 's2' }, { prompt: 'different' }, { title: 'different' }, { when: { everySeconds: 7200 } }]) {
    await assert.rejects(next.handlers['schedule.create']!({ ...params, ...change }, context()), (error: unknown) => error instanceof OperationError && error.code === 'conflict')
  }
  assert.equal(dsh.scheduleRows.length, 1)
  const file = await readFile(join(f.dir, 'remote-schedules.json'), 'utf8')
  assert.ok(!file.includes(params.prompt), 'the retry ledger never contains prompt text')
  assert.equal(reopened.list()[0]?.idempotencyKey, params.idempotencyKey)
  assert.match(reopened.list()[0]?.requestHash ?? '', /^[a-f0-9]{64}$/)
  await reopened.put({ ...reopened.list()[0]!, createdAt: Date.now() - 24 * 60 * 60_000 - 1000 })
  assert.notEqual((await next.handlers['schedule.create']!(params, context())).schedule.scheduleId, created.schedule.scheduleId, 'keys expire after 24 hours')
})

test('old remote schedule files remain valid and malformed retry metadata fails closed', async t => {
  const f = await tempDir()
  t.after(f.cleanup)
  const record = { scheduleId: 'schedule-old', sessionId: 's1', clientId: 'c1', clientName: 'Old client', createdAt: 1 }
  await writeFile(join(f.dir, remoteSchedulesSpec.file), JSON.stringify({ version: 1, data: { schedules: [record] } }))
  assert.deepEqual(new FileRemoteScheduleStore(await JsonDocument.open(f.dir, remoteSchedulesSpec)).list(), [record])
  assert.throws(() => remoteSchedulesSpec.parse({ schedules: [{ ...record, idempotencyKey: 'k', requestHash: 'broken' }] }))
})

test('failed revocation deletions keep their tracking records if the catalogue is unavailable', async t => {
  const f = await tempDir()
  t.after(f.cleanup)
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  dsh.addSession('s1', { workspace: 'ws-a' })
  const h = harness(dsh, { workspaces: ['ws-a'] })
  const store = new FileRemoteScheduleStore(await JsonDocument.open(f.dir, remoteSchedulesSpec))
  const adapter = buildAdapter(dsh.ctx(), { ...h.deps, remoteSchedules: store })
  t.after(() => adapter.dispose())
  const params = { sessionId: 's1', title: 'Recurring', prompt: 'work', when: { everySeconds: 60 }, idempotencyKey: 'k' }
  await adapter.handlers['schedule.create']!(params, context())
  const deletion = dsh.schedule.delete
  const catalog = dsh.schedule.catalog
  dsh.schedule.delete = async () => { throw new Error('temporarily unavailable') }
  dsh.schedule.catalog = async () => { throw new Error('temporarily unavailable') }
  assert.equal(await adapter.removeRemoteSchedules(), 0)
  assert.equal(store.list().length, 1)
  dsh.schedule.delete = deletion
  dsh.schedule.catalog = catalog
  assert.equal(await adapter.removeRemoteSchedules(), 1)
  assert.equal(store.list().length, 0)
})

test('schedule creation removes the DSH schedule if its durable retry record cannot be saved', async t => {
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  dsh.addSession('s1', { workspace: 'ws-a' })
  const h = harness(dsh, { workspaces: ['ws-a'] })
  const adapter = buildAdapter(dsh.ctx(), {
    ...h.deps,
    remoteSchedules: { list: () => [], put: async () => { throw new Error('disk full') }, remove: async () => {} },
  })
  t.after(() => adapter.dispose())
  await assert.rejects(adapter.handlers['schedule.create']!({ sessionId: 's1', title: 'Recurring', prompt: 'work', when: { everySeconds: 60 }, idempotencyKey: 'k' }, context()), /disk full/)
  assert.equal(dsh.scheduleRows.length, 0)
})

test('revocation removes a remote schedule whose creation is still in flight', async t => {
  const f = await tempDir()
  t.after(f.cleanup)
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  dsh.addSession('s1', { workspace: 'ws-a' })
  const h = harness(dsh, { workspaces: ['ws-a'] })
  const store = new FileRemoteScheduleStore(await JsonDocument.open(f.dir, remoteSchedulesSpec))
  const adapter = buildAdapter(dsh.ctx(), { ...h.deps, remoteSchedules: store })
  t.after(() => adapter.dispose())
  let signalEntered!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { signalEntered = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  const create = dsh.schedule.create
  dsh.schedule.create = async (sessionId, request) => {
    signalEntered()
    await resume
    return create(sessionId, request)
  }
  const creating = adapter.handlers['schedule.create']!({ sessionId: 's1', title: 'Recurring', prompt: 'work', when: { everySeconds: 60 }, idempotencyKey: 'k' }, context())
  await entered
  const revoking = adapter.removeRemoteSchedules()
  release()
  await creating
  assert.equal(await revoking, 1)
  assert.equal(dsh.scheduleRows.length, 0)
  assert.equal(store.list().length, 0)
})
