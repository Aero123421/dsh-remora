import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PlacementError, SettingsScopePolicy, isWithin, validatePlacement } from '../src/core/scope.ts'
import { defaultSettings, type RemoraSettings } from '../src/core/settings.ts'
import { tempDir } from './helpers.ts'

async function fixture() {
  const t = await tempDir()
  const home = join(t.dir, 'home')
  const dshHome = join(home, '.dsh')
  await mkdir(join(home, '.ssh'), { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await mkdir(join(home, 'projects', 'app'), { recursive: true })
  await writeFile(join(home, 'file.txt'), 'x')
  await symlink(home, join(t.dir, 'home-link'))
  await symlink(join(home, '.ssh'), join(home, 'projects', 'ssh-link'))
  return { ...t, roots: { home, dshHome } }
}

test('placements must be real folders away from home, $DSH_HOME, ~/.ssh and roots', async () => {
  const f = await fixture()
  try {
    const code = async (path: string) => validatePlacement(path, f.roots).then(() => 'ok', (error: PlacementError) => error.code)
    assert.equal(await code(join(f.roots.home, 'projects')), 'ok')
    assert.equal(await code('relative/path'), 'not-absolute')
    assert.equal(await code(join(f.dir, 'missing')), 'not-found')
    assert.equal(await code(join(f.roots.home, 'file.txt')), 'not-directory')
    assert.equal(await code(f.roots.home), 'forbidden')
    assert.equal(await code(join(f.dir, 'home-link')), 'forbidden', 'a symlink to home is home')
    assert.equal(await code(f.dir), 'forbidden', 'a parent of home contains it')
    assert.equal(await code(f.roots.dshHome), 'forbidden')
    assert.equal(await code(join(f.roots.home, '.ssh')), 'forbidden')
    assert.equal(await code(join(f.roots.home, 'projects', 'ssh-link')), 'forbidden', 'symlinks are resolved')
    assert.equal(await code('/'), 'forbidden')
  } finally { await f.cleanup() }
})

test('scope: workspaces, placements, outside sessions, exceptions and allow-lists', async () => {
  const f = await fixture()
  try {
    const projects = await validatePlacement(join(f.roots.home, 'projects'), f.roots)
    let settings: RemoraSettings = defaultSettings()
    settings = { ...settings, scope: { ...settings.scope, workspaces: ['w1'], placements: [{ placementId: 'p1', path: projects, addedAt: 0 }], exceptions: [{ sessionId: 's-deny', allow: false }, { sessionId: 's-allow', allow: true }], skills: ['review'], commands: ['/compact'], untrustedWorkspaces: ['w-cloned'] } }
    const marked: string[] = []
    const scope = new SettingsScopePolicy({ settings: () => settings, markUntrusted: async id => { marked.push(id) }, now: () => 0 })
    await scope.revalidatePlacements(f.roots)
    assert.equal(scope.canAccessWorkspace('w1', null), true)
    assert.equal(scope.canAccessWorkspace('w2', join(projects, 'app')), true)
    assert.equal(scope.canAccessWorkspace('w2', projects), false)
    assert.equal(scope.canAccessWorkspace('w2', join(f.roots.home, 'other')), false)
    assert.equal(scope.canAccessSession({ sessionId: 's', workspaceId: null, workspacePath: null }), false)
    assert.equal(scope.canAccessSession({ sessionId: 's-allow', workspaceId: 'w9', workspacePath: null }), true)
    assert.equal(scope.canAccessSession({ sessionId: 's-deny', workspaceId: 'w1', workspacePath: null }), false)
    assert.deepEqual(scope.placements(), [{ placementId: 'p1', path: projects }])
    assert.equal(scope.isAllowedSkill('review', 'w1'), true)
    assert.equal(scope.isAllowedSkill('review', 'w-cloned'), false)
    assert.equal(scope.isAllowedSkill('other', null), false)
    assert.equal(scope.isAllowedCommand('compact'), true)
    assert.equal(scope.isAllowedCommand('/export'), false)
    // Full remote access never widens the allow-lists (the /permission attack).
    settings = { ...settings, ceiling: { level: 'full', fullAccessExpiresAt: 10 }, scope: { ...settings.scope, commands: ['/export', '/permission'] } }
    assert.equal(scope.isAllowedCommand('/anything'), false)
    assert.equal(scope.isAllowedCommand('/permission'), false, 'raising the permission preset is never allowed')
    assert.equal(scope.isAllowedCommand('/PERMISSION'), false)
    assert.equal(scope.isAllowedCommand('/export'), false, 'forbidden commands stay forbidden even when listed')
    assert.equal(scope.isAllowedAgentPreset('ptc'), false)
    assert.equal(scope.isAllowedSkill('deploy', 'w1'), false)
    await scope.markUntrustedWorkspace('w3')
    assert.deepEqual(marked, ['w3'])
    settings = { ...settings, scope: { ...settings.scope, outsideWorkspace: true } }
    assert.equal(scope.canAccessSession({ sessionId: 's', workspaceId: null, workspacePath: null }), true)
    settings = { ...settings, scope: { ...settings.scope, placements: [{ placementId: 'bad', path: f.roots.home, addedAt: 0 }] } }
    await scope.revalidatePlacements(f.roots)
    assert.deepEqual(scope.placements(), [])
  } finally { await f.cleanup() }
})

test('isWithin does not match sibling prefixes', () => {
  assert.equal(isWithin('/a/bc', '/a/b'), false)
  assert.equal(isWithin('/a/b/c', '/a/b'), true)
  assert.equal(isWithin('/a/b', '/a/b'), true)
})
