import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, realpath, rename, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAdapter } from '../src/adapter/index.ts'
import { SettingsScopePolicy, validatePlacement } from '../src/core/scope.ts'
import { defaultSettings } from '../src/core/settings.ts'
import { OperationError } from '../src/ops/types.ts'
import { context, createFake, harness } from './fake-dsh.ts'
import { tempDir } from './helpers.ts'

for (const replacement of ['.ssh', '.dsh', 'other']) {
  test(`workspace.create refuses a previously approved placement replaced by a link to ${replacement}`, async t => {
    const f = await tempDir()
    t.after(f.cleanup)
    const home = join(await realpath(f.dir), 'home')
    const placement = join(home, 'projects')
    const destination = join(home, replacement)
    await mkdir(placement, { recursive: true })
    await mkdir(destination, { recursive: true })
    const roots = { home, dshHome: join(home, '.dsh') }
    const settings = defaultSettings()
    settings.scope.placements = [{ placementId: 'p1', path: await validatePlacement(placement, roots), addedAt: 0 }]
    const scope = new SettingsScopePolicy({ settings: () => settings, markUntrusted: async () => {} })
    await scope.revalidatePlacements(roots)
    const dsh = createFake()
    const h = harness(dsh)
    const adapter = buildAdapter(dsh.ctx(), { ...h.deps, scope })
    t.after(() => adapter.dispose())
    await rename(placement, placement + '-original')
    await symlink(destination, placement, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(adapter.handlers['workspace.create']!({ placementId: 'p1', name: 'forbidden', idempotencyKey: 'k' }, context()), (error: unknown) => error instanceof OperationError && error.code === 'denied')
    assert.equal(dsh.workspaces.length, 0)
    await assert.rejects(stat(join(destination, 'forbidden')), { code: 'ENOENT' })
    assert.deepEqual(scope.placements(), [], 'changed placements cease granting implicit workspace access')
  })
}

test('a placement still resolving to its approved folder creates a workspace', async t => {
  const f = await tempDir()
  t.after(f.cleanup)
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
  const adapter = buildAdapter(dsh.ctx(), { ...h.deps, scope })
  t.after(() => adapter.dispose())
  assert.equal((await adapter.handlers['workspace.create']!({ placementId: 'p1', name: 'app', idempotencyKey: 'k' }, context())).workspace.path, join(placement, 'app'))
})
