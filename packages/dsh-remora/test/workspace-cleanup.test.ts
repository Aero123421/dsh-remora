import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAdapter } from '../src/adapter/index.ts'
import { SettingsScopePolicy, validatePlacement } from '../src/core/scope.ts'
import { defaultSettings } from '../src/core/settings.ts'
import { FileWorkspaceCreationStore, workspaceCreationsSpec } from '../src/core/workspace-creations.ts'
import { JsonDocument } from '../src/core/storage.ts'
import type { WorkspaceCreationRecord } from '../src/ops/types.ts'
import { context, createFake, harness } from './fake-dsh.ts'
import { tempDir } from './helpers.ts'

async function fixture() {
  const f = await tempDir()
  const home = join(await realpath(f.dir), 'home')
  const placement = join(home, 'projects')
  await mkdir(placement, { recursive: true })
  const roots = { home, dshHome: join(home, '.dsh') }
  const settings = defaultSettings()
  settings.scope.placements = [{ placementId: 'p1', path: await validatePlacement(placement, roots), addedAt: 0 }]
  const scope = new SettingsScopePolicy({ settings: () => settings, markUntrusted: async () => {} })
  await scope.revalidatePlacements(roots)
  const dsh = createFake()
  const h = harness(dsh)
  const store = new FileWorkspaceCreationStore(await JsonDocument.open(f.dir, workspaceCreationsSpec))
  const deps = { ...h.deps, scope, workspaceCreations: store }
  const adapter = buildAdapter(dsh.ctx(), deps)
  await adapter.recovered
  await adapter.handlers['workspace.create']!({ placementId: 'p1', name: 'app', idempotencyKey: 'k' }, context())
  const original = store.list()[0]!
  await store.put({ ...original, state: 'cloning' })
  adapter.dispose()
  return { ...f, home, placement, roots, settings, dsh, deps, store, original }
}

test('clone recovery keeps protected content when its approved parent was replaced by a symlink', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const protectedFolder = join(f.home, '.ssh', 'app')
  await mkdir(protectedFolder, { recursive: true })
  await writeFile(join(protectedFolder, 'keep'), 'private content')
  await writeFile(join(f.placement, 'app', 'keep'), 'original content')
  await rename(f.placement, f.placement + '-original')
  await symlink(join(f.home, '.ssh'), f.placement, process.platform === 'win32' ? 'junction' : 'dir')
  const adapter = buildAdapter(f.dsh.ctx(), f.deps)
  t.after(() => adapter.dispose())
  await adapter.recovered
  assert.equal(await readFile(join(protectedFolder, 'keep'), 'utf8'), 'private content')
  assert.equal(await readFile(join(f.placement + '-original', 'app', 'keep'), 'utf8'), 'original content')
  assert.equal(f.store.list()[0]?.state, 'clone-failed')
  assert.match(f.store.list()[0]?.message ?? '', /folder was kept/)
})

test('clone recovery keeps a replacement directory even when its path is still under an allowed placement', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const app = join(f.placement, 'app')
  await rename(app, app + '-original')
  await mkdir(app)
  await writeFile(join(app, 'keep'), 'replacement content')
  const adapter = buildAdapter(f.dsh.ctx(), f.deps)
  t.after(() => adapter.dispose())
  await adapter.recovered
  assert.equal(await readFile(join(app, 'keep'), 'utf8'), 'replacement content')
  assert.equal(f.store.list()[0]?.state, 'clone-failed')
})

test('legacy clone records stay readable and retain their folder when ownership cannot be proved', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const { directory: _directory, ...legacy } = f.store.list()[0]!
  await f.store.put(legacy)
  await writeFile(join(legacy.path, 'keep'), 'legacy content')
  const adapter = buildAdapter(f.dsh.ctx(), f.deps)
  t.after(() => adapter.dispose())
  await adapter.recovered
  assert.equal(await readFile(join(legacy.path, 'keep'), 'utf8'), 'legacy content')
  assert.equal(f.store.list()[0]?.state, 'clone-failed')
})

test('workspace directory identity survives reopening and can refresh from another store', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const reopened = new FileWorkspaceCreationStore(await JsonDocument.open(f.dir, workspaceCreationsSpec))
  assert.deepEqual(reopened.list()[0]?.directory, f.original.directory)
  const changed: WorkspaceCreationRecord = { ...f.store.list()[0]!, state: 'ready' }
  await f.store.put(changed)
  await reopened.refresh()
  assert.equal(reopened.list()[0]?.state, 'ready')
})

test('deferred adapter preparation leaves a live owner clone untouched until ownership is acquired', async t => {
  const f = await fixture()
  t.after(f.cleanup)
  const adapter = buildAdapter(f.dsh.ctx(), f.deps, { deferRecovery: true })
  t.after(() => adapter.dispose())
  await adapter.recovered
  assert.equal(f.store.list()[0]?.state, 'cloning')
  assert.ok(await realpath(f.original.path))
  await adapter.prepare()
  assert.equal(f.store.list()[0]?.state, 'clone-failed')
  await assert.rejects(realpath(f.original.path), { code: 'ENOENT' })
})

test('stopping waits for a pending creation and its cancelled cleanup before releasing ownership', async t => {
  const f = await fixture()
  f.settings.scope.gitHosts = ['github.com']
  t.after(f.cleanup)
  const adapter = buildAdapter(f.dsh.ctx(), f.deps, { deferRecovery: true })
  t.after(() => adapter.dispose())
  const cancellation = new AbortController()
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  const create = f.dsh.workspaceRegistry.create
  f.dsh.workspaceRegistry.create = async path => {
    enter()
    await resume
    return create(path)
  }
  const creating = adapter.handlers['workspace.create']!({ placementId: 'p1', name: 'pending', gitUrl: 'https://github.com/o/r.git', idempotencyKey: 'pending' }, { ...context(), signal: cancellation.signal })
  const rejected = assert.rejects(creating, /cancelled/)
  await entered
  cancellation.abort()
  let stopped = false
  const stopping = adapter.stopClones().then(() => { stopped = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(stopped, false, 'the native creation has not returned or been cleaned up yet')
  release()
  await rejected
  await stopping
  await assert.rejects(realpath(join(f.placement, 'pending')), { code: 'ENOENT' })
  assert.equal(f.store.list().find(record => record.name === 'pending')?.state, 'clone-failed')
})
