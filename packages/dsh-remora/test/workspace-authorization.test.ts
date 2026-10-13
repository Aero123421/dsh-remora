import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAdapter } from '../src/adapter/index.ts'
import { OperationError, type WorkspaceCreationRecord } from '../src/ops/types.ts'
import { context, createFake, harness } from './fake-dsh.ts'
import { tempDir } from './helpers.ts'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function fixture(t: TestContext) {
  const tmp = await tempDir('remora-workspace-authorization-')
  const placement = join(tmp.dir, 'place')
  await mkdir(placement)
  const git = join(tmp.dir, 'fake-git')
  await writeFile(git, '#!/bin/sh\necho started > ../clone-started\n')
  await chmod(git, 0o700)
  const dsh = createFake()
  const h = harness(dsh, { placements: [{ placementId: 'p1', path: placement }], gitHosts: ['github.com'] })
  const records = new Map<string, WorkspaceCreationRecord>()
  const store = { list: () => [...records.values()], put: async (record: WorkspaceCreationRecord) => { records.set(record.key, { ...record }) } }
  const adapter = buildAdapter(dsh.ctx(), { ...h.deps, workspaceCreations: store }, { clone: { git } })
  await adapter.recovered
  t.after(async () => { await adapter.dispose(); await tmp.cleanup() })
  return { ...tmp, placement, dsh, ...h, records, store, adapter, create: adapter.handlers['workspace.create']! }
}

for (const change of ['abort', 'placement', 'permission'] as const) {
  test(`workspace registration is prevented after ${change} during native lookup`, async t => {
    const f = await fixture(t), entered = gate(), resume = gate()
    t.after(() => resume.release())
    f.dsh.workspaceRegistry.resolveByPath = async () => { entered.release(); await resume.promise; return undefined }
    const controller = new AbortController()
    let allowed = true
    const pending = f.create({ placementId: 'p1', name: 'new', idempotencyKey: 'key' }, {
      ...context(), signal: controller.signal,
      assertAuthorized: () => { if (!allowed) throw new OperationError('denied', 'permission revoked') },
    })
    const rejected = assert.rejects(pending, (e: unknown) => e instanceof OperationError && ['unavailable', 'denied'].includes(e.code))
    await entered.promise
    if (change === 'abort') controller.abort()
    else if (change === 'placement') f.policy.placements = () => []
    else allowed = false
    resume.release(); await rejected
    assert.deepEqual(f.dsh.workspaces, [])
    assert.deepEqual(await readdir(f.placement), [])
  })
}

test('git host revocation during ledger persistence prevents clone and retains cleanup record', async t => {
  const f = await fixture(t), entered = gate(), resume = gate()
  t.after(() => resume.release())
  const put = f.store.put
  f.store.put = async record => { await put(record); if (record.state === 'cloning') { entered.release(); await resume.promise } }
  const pending = f.create({ placementId: 'p1', name: 'clone', gitUrl: 'https://github.com/example/repo.git', idempotencyKey: 'key' }, context())
  const rejected = assert.rejects(pending, (e: unknown) => e instanceof OperationError && e.code === 'denied')
  await entered.promise
  f.policy.gitHosts = () => []
  resume.release(); await rejected
  assert.deepEqual(f.dsh.workspaces, [])
  assert.deepEqual(await readdir(f.placement), [])
  assert.equal(f.records.get('client-1\u0000key')?.state, 'clone-failed')
})

for (const failed of [false, true]) {
  test(`workspace retry ${failed ? 'failure' : 'success'} does not disclose an out-of-scope workspace`, async t => {
    const f = await fixture(t)
    const params = { placementId: 'p1', name: 'kept', idempotencyKey: 'key' }
    const created = await f.create(params, context())
    assert.equal((await f.create(params, context())).workspace.workspaceId, created.workspace.workspaceId)
    if (failed) f.records.get('client-1\u0000key')!.state = 'clone-failed'
    f.policy.canAccessWorkspace = () => false
    await assert.rejects(f.create(params, context()), (e: unknown) => e instanceof OperationError && e.code === 'denied')
    assert.equal(f.dsh.workspaces.length, 1, 'denied reads must not delete completed work')
  })
}

test('a cancelled coalesced caller receives no result while the original creation succeeds', async t => {
  const f = await fixture(t), entered = gate(), resume = gate()
  t.after(() => resume.release())
  f.dsh.workspaceRegistry.resolveByPath = async () => { entered.release(); await resume.promise; return undefined }
  const params = { placementId: 'p1', name: 'kept', idempotencyKey: 'key' }
  const first = f.create(params, context())
  await entered.promise
  const controller = new AbortController()
  const second = f.create(params, { ...context(), signal: controller.signal })
  const rejected = assert.rejects(second, (e: unknown) => e instanceof OperationError && e.code === 'unavailable')
  controller.abort(); resume.release()
  assert.equal((await first).workspace.path, join(f.placement, 'kept'))
  await rejected
  assert.equal(f.dsh.workspaces.length, 1)
})
