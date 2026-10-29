import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { checkForUpdate, compareVersions, downloadVerified, expectedHash, MAX_TARBALL_BYTES, UpdateError, type BundleChangeResult, type UpdateInstallation, type UpdatePluginManager } from '../src/core/updates.ts'
import { apply } from '../src/index.ts'
import type { JsonDocument as StoredDocument } from '../src/core/storage.ts'
import { PLUGIN_VERSION } from '../src/dsh.ts'
import { fakeHost, makePasskey, rpc, tempDir, until } from './helpers.ts'
import { FakeHub } from './fake-hub.ts'

test('semver comparison handles pre-releases', () => {
  assert.ok(compareVersions('0.1.0', '0.0.9') > 0)
  assert.ok(compareVersions('v1.0.0', '1.0.0-rc.1') > 0)
  assert.ok(compareVersions('1.0.0-rc.2', '1.0.0-rc.10') < 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.ok(compareVersions('1.0.0-9007199254740992', '1.0.0-9007199254740993') < 0)
  assert.ok(compareVersions('9007199254740992.0.0', '9007199254740993.0.0') < 0)
  assert.equal(compareVersions('1.2.3+build.1', '1.2.3+build.2'), 0)
})

test('invalid release metadata is reported as an error instead of up to date', async () => {
  for (const tag_name of ['', null, 123, 'latest', 'v1.2', '1.02.3', '1.2.3-01', '1.2.3-alpha..1', '1.2.3+', '1.2.3+bad metadata', ' 1.2.3']) {
    const result = await checkForUpdate('0.1.0', async () => Response.json({ tag_name }))
    assert.equal(result.error, 'invalid-release', `tag: ${tag_name}`)
    assert.equal(result.latest, null)
  }
  const malformed = await checkForUpdate('0.1.0', async () => new Response('{'))
  assert.equal(malformed.error, 'invalid-release')
  const duplicated = await checkForUpdate('0.1.0', async () => Response.json({ tag_name: 'v0.2.0', assets: [
    { name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.2.0/first.tgz' },
    { name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.2.0/second.tgz' },
  ] }))
  assert.equal(duplicated.error, 'invalid-release')
})

function packageArchive(overrides: Record<string, unknown> = {}): Uint8Array<ArrayBuffer> {
  const manifest = { name: 'dsh-remora', version: '0.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.1-alpha.2 <0.2.2-0' }, ...overrides }
  const content = Buffer.from(JSON.stringify(manifest)), header = Buffer.alloc(512)
  header.write('package/package.json')
  header.write(content.length.toString(8).padStart(11, '0'), 124)
  header[156] = 48
  return new Uint8Array(gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)])))
}
const tarball = packageArchive()
const sha = createHash('sha256').update(tarball).digest('hex')

function github(sums: string) {
  return async (url: string) => {
    if (url.startsWith('https://raw.githubusercontent.com/')) return Response.json({ name: 'dsh-remora', version: '0.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.1-alpha.2 <0.2.2-0' } })
    if (url.endsWith('/releases/latest')) {
      return Response.json({
        id: 123, draft: false, prerelease: false, tag_name: 'v0.2.0', name: 'v0.2.0', body: 'Notes', html_url: 'https://github.com/Aero123421/dsh-remora/releases/tag/v0.2.0',
        assets: [
          { name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.2.0/dsh-remora-0.2.0.tgz' },
          { name: 'SHA256SUMS', browser_download_url: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.2.0/SHA256SUMS' },
        ],
      })
    }
    if (url.endsWith('SHA256SUMS')) return new Response(sums)
    return new Response(tarball)
  }
}

test('a newer release is found and its tarball is verified against SHA256SUMS', async () => {
  const check = await checkForUpdate('0.1.0', github(`${sha}  dsh-remora-0.2.0.tgz\n`))
  assert.equal(check.newer, true)
  assert.equal(check.latest?.version, '0.2.0')
  assert.equal(expectedHash(`${sha}  dsh-remora-0.2.0.tgz`, 'dsh-remora-0.2.0.tgz'), sha)
  const t = await tempDir()
  try {
    const path = await downloadVerified(check.latest!, t.dir, github(`${sha}  dsh-remora-0.2.0.tgz\n`), '0.2.1-alpha.2')
    assert.deepEqual(new Uint8Array(await readFile(path)), tarball)
    await assert.rejects(downloadVerified(check.latest!, t.dir, github(`${'0'.repeat(64)}  dsh-remora-0.2.0.tgz\n`)), (error: unknown) => error instanceof UpdateError && error.code === 'checksum-mismatch')
    await assert.rejects(downloadVerified(check.latest!, t.dir, github('')), (error: unknown) => error instanceof UpdateError && error.code === 'no-checksum')
  } finally { await t.cleanup() }
  const none = await checkForUpdate('0.1.0', async () => new Response('', { status: 404 }))
  assert.deepEqual([none.latest, none.newer, none.error], [null, false, undefined])
})

function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(release => { resolve = release })
  return { promise, resolve }
}

const success = (application: 'applied' | 'restart-required' = 'restart-required'): BundleChangeResult => ({
  changed: true, application, stage: 'enable', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.2.0',
})

/** DSH 0.2.1-alpha.3 with HMR: install over an installed package changes nothing. */
const alreadyInstalled = (): BundleChangeResult => ({
  changed: false, application: 'failed', stage: 'install', target: 'dsh-remora-0.2.0.tgz', error: { code: 'already-installed' },
  // The alpha.2 type package predates this code; alpha.3 returns it from installBundle.
} as unknown as BundleChangeResult)

const installedBundle = { name: 'dsh-remora', version: '0.1.2', installed: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz', enabled: true }

async function updateCore(manager: UpdatePluginManager, fetchImpl = github(`${sha}  dsh-remora-0.2.0.tgz\n`)) {
  const temp = await tempDir()
  const host = fakeHost({ pluginManager: manager, profileContext: { dir: temp.dir } })
  const core = apply(host.ctx, undefined, { dataDir: temp.dir, dshVersion: '0.2.1-alpha.2', githubFetch: fetchImpl })
  await core.ready
  await core.checkUpdate(true)
  return { core, host, cleanup: async () => { await core.dispose(); await temp.cleanup() } }
}

test('installation waits for DSH, preserves disabled selection, joins duplicate requests and reports restart separately', async () => {
  const completed = gate<BundleChangeResult>()
  let installs = 0
  let options: Parameters<UpdatePluginManager['installBundle']>[1] | undefined
  const h = await updateCore({
    listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz', enabled: false }],
    installBundle: async (_spec, selected) => { installs++; options = selected; return completed.promise },
  })
  try {
    let returned = false
    const first = rpc<UpdateInstallation>(h.host.routes, 'update-install', { version: '0.2.0' }).then(value => { returned = true; return value })
    await until(() => installs === 1)
    assert.equal(returned, false)
    assert.equal(h.core.snapshot(true).updateInstallation?.phase, 'installing')
    assert.equal(options?.enabled, false)
    assert.match(options?.requestId ?? '', /^[0-9a-f-]{36}$/)
    assert.equal((await h.core.auditEntries()).filter(entry => entry.action === 'update:0.2.0').length, 0)
    const second = rpc<UpdateInstallation>(h.host.routes, 'update-install', { version: '0.2.0' })
    const remote = await rpc(h.host.routes, 'update-install', { version: '0.2.0' }, { peer: '192.0.2.1' })
    assert.equal(remote.ok, false)
    completed.resolve(success())
    const [result, duplicate] = await Promise.all([first, second])
    assert.deepEqual(result, duplicate)
    assert.equal(result.ok && result.value.phase, 'restart-required')
    assert.equal(h.core.snapshot(true).version, PLUGIN_VERSION)
    assert.equal(h.core.snapshot(true).updateInstallation?.installedVersion, '0.2.0')
    const repeated = await rpc<UpdateInstallation>(h.host.routes, 'update-install', { version: '0.2.0' })
    assert.deepEqual(result, repeated)
    assert.equal(installs, 1)
    const audit = (await h.core.auditEntries()).find(entry => entry.action === 'update:0.2.0')
    assert.equal(audit?.outcome, 'ok')
    assert.equal(audit?.reason, 'restart-required:enable')
  } finally { completed.resolve(success()); await h.cleanup() }
})

test('DSH failure, override, cancellation and installed-version mismatch never claim success', async t => {
  const cases: { label: string; result: BundleChangeResult; phase: UpdateInstallation['phase']; error?: string }[] = [
    { label: 'incompatible', result: { changed: false, application: 'failed', stage: 'install', target: '/updates/dsh-remora-0.2.0.tgz', error: { code: 'incompatible-version' } }, phase: 'failed', error: 'incompatible-version' },
    { label: 'overridden', result: { ...success(), application: 'overridden' }, phase: 'overridden' },
    { label: 'cancelled', result: { ...success(), application: 'cancelled' }, phase: 'cancelled' },
    { label: 'wrong version', result: { ...success(), version: '0.1.9' }, phase: 'failed', error: 'installed-version-mismatch' },
    { label: 'wrong bundle', result: { ...success(), bundle: 'other-plugin' }, phase: 'failed', error: 'installed-version-mismatch' },
    { label: 'error on applied result', result: { ...success('applied'), error: { code: 'operation-error' } }, phase: 'failed', error: 'operation-error' },
    { label: 'package failure', result: { ...success(), packageResult: { exitCode: 1, kind: 'build-blocked', output: '', truncated: false, logPath: '/logs/install' } }, phase: 'failed', error: 'build-blocked' },
  ]
  for (const item of cases) await t.test(item.label, async () => {
    const h = await updateCore({ listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz', enabled: true }], installBundle: async () => item.result })
    try {
      const result = await h.core.installUpdate(true, '0.2.0')
      assert.equal(result.phase, item.phase)
      assert.equal(result.error, item.error)
      assert.equal((await h.core.auditEntries()).find(entry => entry.action === 'update:0.2.0')?.outcome, 'error')
    } finally { await h.cleanup() }
  })
})

test('an already-installed package is removed, then installed with the same selection', async () => {
  const calls: string[] = []
  let enabled: boolean | undefined
  let requestId: string | undefined
  const h = await updateCore({
    listBundles: async () => [{ ...installedBundle, enabled: false }],
    installBundle: async (_spec, options) => {
      calls.push('install')
      enabled = options.enabled
      requestId = options.requestId
      return calls.filter(call => call === 'install').length === 1 ? alreadyInstalled() : success('applied')
    },
    removeBundle: async name => {
      calls.push(`remove:${name}`)
      return { changed: true, application: 'applied', stage: 'remove', target: name }
    },
  })
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.deepEqual(calls, ['install', 'remove:dsh-remora', 'install'])
    assert.equal(enabled, false)
    assert.match(requestId ?? '', /^[0-9a-f-]{36}$/)
    assert.equal(result.phase, 'applied')
    assert.equal(result.installedVersion, '0.2.0')
    assert.equal((await h.core.auditEntries()).find(entry => entry.action === 'update:0.2.0')?.outcome, 'ok')
  } finally { await h.cleanup() }
})

test('removal failure other than stop-profile does not install again', async t => {
  for (const code of ['bundle-in-use', 'not-removable'] as const) await t.test(code, async () => {
    let installs = 0
    const h = await updateCore({
      listBundles: async () => [installedBundle],
      installBundle: async () => { installs++; return alreadyInstalled() },
      removeBundle: async () => ({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-remora', error: { code } }),
    })
    try {
      const result = await h.core.installUpdate(true, '0.2.0')
      assert.equal(installs, 1)
      assert.equal(result.phase, 'failed')
      assert.equal(result.error, code)
    } finally { await h.cleanup() }
  })
})

test('stop-profile keeps the package and installs over it', async () => {
  let installs = 0
  const h = await updateCore({
    listBundles: async () => [installedBundle],
    installBundle: async () => { installs++; return installs === 1 ? alreadyInstalled() : success() },
    removeBundle: async () => ({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-remora', error: { code: 'stop-profile' } }),
  })
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.equal(installs, 2)
    assert.equal(result.phase, 'restart-required')
  } finally { await h.cleanup() }
})

test('install continues after removal unloads this plugin', async () => {
  let core: Awaited<ReturnType<typeof updateCore>>['core'] | undefined
  const calls: string[] = []
  const h = await updateCore({
    listBundles: async () => [installedBundle],
    installBundle: async () => {
      calls.push('install')
      return calls.length === 1 ? alreadyInstalled() : success('applied')
    },
    removeBundle: async () => {
      calls.push('remove')
      await core!.dispose()
      return { changed: true, application: 'applied', stage: 'remove', target: 'dsh-remora' }
    },
  })
  core = h.core
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.deepEqual(calls, ['install', 'remove', 'install'])
    assert.equal(result.phase, 'applied')
    assert.equal(h.core.snapshot(true).updateInstallation?.phase, 'applied')
  } finally { await h.cleanup() }
})

test('already-installed without removeBundle stays a failed install', async () => {
  const h = await updateCore({
    listBundles: async () => [installedBundle],
    installBundle: async () => alreadyInstalled(),
  })
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'already-installed')
  } finally { await h.cleanup() }
})

test('a failed install after removal puts the previous source back with a new request id', async () => {
  let removed = false
  const specs: string[] = []
  const ids: string[] = []
  const h = await updateCore({
    listBundles: async () => removed ? [] : [installedBundle],
    installBundle: async (spec, options) => {
      specs.push(spec)
      ids.push(options.requestId)
      if (specs.length === 1) return alreadyInstalled()
      if (specs.length === 2) return { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'operation-error' } }
      return { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.1.2' }
    },
    removeBundle: async () => {
      removed = true
      return { changed: true, application: 'applied', stage: 'remove', target: 'dsh-remora' }
    },
  })
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'previous-restored')
    assert.equal(specs[2], installedBundle.source)
    assert.equal(ids[2] !== ids[1], true)
    assert.match(ids[2] ?? '', /^[0-9a-f-]{36}$/)
  } finally { await h.cleanup() }
})

test('a failed restore says the plugin may be missing', async () => {
  let removed = false
  let installs = 0
  const h = await updateCore({
    listBundles: async () => removed ? [] : [installedBundle],
    installBundle: async () => {
      installs++
      if (installs === 1) return alreadyInstalled()
      return { changed: false, application: 'failed', stage: 'install', target: 'dsh-remora', error: { code: 'operation-error' } }
    },
    removeBundle: async () => {
      removed = true
      return { changed: true, application: 'applied', stage: 'remove', target: 'dsh-remora' }
    },
  })
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.equal(installs, 3)
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'restore-failed')
  } finally { await h.cleanup() }
})

test('a thrown install after removal still tries to restore, and a thrown restore is visible', async () => {
  let removed = false
  let installs = 0
  const h = await updateCore({
    listBundles: async () => removed ? [] : [installedBundle],
    installBundle: async () => {
      installs++
      if (installs === 1) return alreadyInstalled()
      if (installs === 2) throw new Error('disk')
      throw new Error('restore disk')
    },
    removeBundle: async () => {
      removed = true
      return { changed: true, application: 'applied', stage: 'remove', target: 'dsh-remora' }
    },
  })
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.equal(installs, 3)
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'restore-failed')
  } finally { await h.cleanup() }
})

test('stop-profile leaves the package in place, so a later failed overwrite does not restore', async () => {
  let installs = 0
  const h = await updateCore({
    listBundles: async () => [installedBundle],
    installBundle: async () => {
      installs++
      return installs === 1 ? alreadyInstalled() : { changed: false, application: 'failed', stage: 'install', target: 'dsh-remora', error: { code: 'operation-error' } }
    },
    removeBundle: async () => ({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-remora', error: { code: 'stop-profile' } }),
  })
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.equal(installs, 2)
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'operation-error')
  } finally { await h.cleanup() }
})

test('when the bundle list cannot be read, the previous version is not installed', async () => {
  let removed = false
  let installs = 0
  const h = await updateCore({
    listBundles: async () => {
      if (removed) throw new Error('list down')
      return [installedBundle]
    },
    installBundle: async () => {
      installs++
      return installs === 1 ? alreadyInstalled() : { changed: false, application: 'failed', stage: 'install', target: 'dsh-remora', error: { code: 'operation-error' } }
    },
    removeBundle: async () => {
      removed = true
      return { changed: true, application: 'applied', stage: 'remove', target: 'dsh-remora' }
    },
  })
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.equal(installs, 2)
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'presence-unknown')
  } finally { await h.cleanup() }
})

test('missing bundle selection and rejected installer calls fail visibly', async t => {
  for (const missing of [false, true]) await t.test(missing ? 'unknown selection' : 'rejected installer', async () => {
    let installs = 0
    const h = await updateCore({
      listBundles: async () => missing ? [] : [{ name: 'dsh-remora', version: '0.1.2', installed: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz', enabled: true }],
      installBundle: async () => { installs++; throw new Error('pnpm unavailable') },
    })
    try {
      const result = await h.core.installUpdate(true, '0.2.0')
      assert.equal(result.phase, missing ? 'failed' : 'unknown')
      assert.equal(result.error, missing ? 'unknown-bundle' : 'install-failed')
      assert.equal(installs, missing ? 0 : 1)
    } finally { await h.cleanup() }
  })
})

test('install only accepts the displayed version, before downloading', async () => {
  let requests = 0
  const fetchImpl = github(`${sha}  dsh-remora-0.2.0.tgz\n`)
  const h = await updateCore({ listBundles: async () => [], installBundle: async () => success() }, async url => { requests++; return fetchImpl(url) })
  try {
    for (const version of ['0.1.9', undefined]) {
      const result = await rpc(h.host.routes, 'update-install', { version })
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.error.code, 'remora/update-candidate-changed')
    }
    assert.equal(requests, 2)
  } finally { await h.cleanup() }
})

test('unloading during the download prevents starting DSH installation', async () => {
  const resume = gate<void>()
  let downloading = false
  let installs = 0
  const fetchImpl = github(`${sha}  dsh-remora-0.2.0.tgz\n`)
  const h = await updateCore({
    listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz', enabled: true }],
    installBundle: async () => { installs++; return success() },
  }, async url => {
    if (url.endsWith('.tgz')) { downloading = true; await resume.promise }
    return fetchImpl(url)
  })
  try {
    const pending = h.core.installUpdate(true, '0.2.0')
    await until(() => downloading)
    await h.core.dispose()
    resume.resolve()
    const result = await pending
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'unloading')
    assert.equal(installs, 0)
  } finally { resume.resolve(); await h.cleanup() }
})

test('same-version Host reloads retain durable receipts and have distinct connection identities', async () => {
  const manager: UpdatePluginManager = {
    listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz', enabled: true }],
    installBundle: async () => ({ ...success(), application: 'cancelled' }),
  }
  const h = await updateCore(manager)
  let replacement: ReturnType<typeof apply> | undefined
  try {
    await h.core.installUpdate(true, '0.2.0')
    const before = h.core.snapshot(true)
    assert.equal(before.updateInstallation?.attempt, 1)
    assert.equal(before.updateHostInstance, h.core.snapshot(true).updateHostInstance)
    await h.core.dispose()
    const host = fakeHost({ pluginManager: manager, profileContext: { dir: h.core.dataDir } })
    replacement = apply(host.ctx, undefined, { dataDir: h.core.dataDir, dshVersion: '0.2.1-alpha.2', githubFetch: github(`${sha}  dsh-remora-0.2.0.tgz\n`) })
    await replacement.ready
    const after = replacement.snapshot(true)
    assert.equal(after.version, before.version)
    assert.notEqual(after.updateHostInstance, before.updateHostInstance)
    assert.equal(after.updateInstallation?.phase, 'cancelled')
    assert.equal(after.update, null)
    await replacement.checkUpdate(true)
    assert.equal((await replacement.installUpdate(true, '0.2.0')).attempt, 2)
  } finally { await replacement?.dispose(); await h.cleanup() }
})

test('chunked downloads cancel the reader as soon as the limit is exceeded', async t => {
  for (const target of ['sums', 'tarball']) await t.test(target, async () => {
    const limit = target === 'sums' ? 64 * 1024 : MAX_TARBALL_BYTES
    const chunkSize = target === 'sums' ? 16 * 1024 : 1024 * 1024
    let reads = 0
    let cancelled = false
    const chunk = new Uint8Array(chunkSize)
    const oversized = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        controller.enqueue(chunk)
        if (reads > limit / chunkSize + 100) controller.close()
      },
      cancel() { cancelled = true },
    }))
    const fetchImpl = github(`${sha}  dsh-remora-0.2.0.tgz\n`)
    const release = (await checkForUpdate('0.1.0', fetchImpl)).latest!
    const temp = await tempDir()
    try {
      await assert.rejects(downloadVerified(release, temp.dir, async url => {
        if ((url.endsWith('SHA256SUMS') && target === 'sums') || (url.endsWith('.tgz') && target === 'tarball')) return oversized()
        return fetchImpl(url)
      }), (error: unknown) => error instanceof UpdateError && error.code === 'too-large')
      assert.equal(cancelled, true)
      assert.ok(reads <= limit / chunkSize + 2, `download consumed ${reads} chunks`)
    } finally { await temp.cleanup() }
  })
})

test('invalid current SemVer, stable channel, asset origins and duplicate checksums are rejected', async () => {
  assert.throws(() => compareVersions('broken', '1.0.0'), UpdateError)
  assert.equal((await checkForUpdate('broken', github(''))).error, 'invalid-version')
  for (const field of [{ draft: true }, { prerelease: true }, { html_url: 'https://evil.test/' }, { assets: [{ name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://evil.test/dsh-remora-0.2.0.tgz' }] }]) {
    const base = await (await github('')('https://api.github.com/repos/Aero123421/dsh-remora/releases/latest')).json()
    assert.equal((await checkForUpdate('0.1.0', async () => Response.json({ ...base, ...field }))).error, 'invalid-release')
  }
  assert.throws(() => expectedHash(`${sha}  file\n${sha}  file`, 'file'), (e: unknown) => e instanceof UpdateError && e.code === 'invalid-checksum')
})

test('asset redirects only accept GitHub asset delivery hosts', async () => {
  const base = github(`${sha}  dsh-remora-0.2.0.tgz\n`)
  const release = (await checkForUpdate('0.1.0', base)).latest!
  const temp = await tempDir()
  try {
    for (const location of ['https://evil.test/asset', 'http://release-assets.githubusercontent.com/asset', 'https://user:password@objects.githubusercontent.com/asset']) {
      await assert.rejects(downloadVerified(release, temp.dir, async () => new Response(null, { status: 302, headers: { location } })), (e: unknown) => e instanceof UpdateError && e.code === 'redirect-refused')
    }
    const requests: string[] = []
    const path = await downloadVerified(release, temp.dir, async (url, init) => {
      assert.equal(init?.redirect, 'manual')
      requests.push(url)
      if (url.startsWith('https://github.com/')) return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/${url.split('/').at(-1)}` } })
      return base(url)
    }, '0.2.1-alpha.2')
    assert.deepEqual(new Uint8Array(await readFile(path)), tarball)
    assert.equal(requests.length, 4)
  } finally { await temp.cleanup() }
})

test('self-disposal retains request ID; replacement mounts before manager settles and never resubmits', async () => {
  const completed = gate<BundleChangeResult>()
  let installs = 0
  let requestId: string | undefined
  let waitedId: string | undefined
  const manager: UpdatePluginManager = {
    listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, enabled: false, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz' }],
    installBundle: async (_spec, options) => { installs++; requestId = options.requestId; return completed.promise },
    waitForInstall: async id => { waitedId = id; return completed.promise },
  }
  const h = await updateCore(manager)
  let replacement: ReturnType<typeof apply> | undefined
  try {
    const pending = h.core.installUpdate(true, '0.2.0')
    await until(() => installs === 1)
    await h.core.dispose()
    replacement = apply(fakeHost({ pluginManager: manager, profileContext: { dir: h.core.dataDir } }).ctx, undefined, { dataDir: h.core.dataDir, dshVersion: '0.2.1-alpha.2', githubFetch: github(`${sha}  dsh-remora-0.2.0.tgz\n`) })
    await replacement.ready
    await until(() => waitedId !== undefined)
    assert.equal(waitedId, requestId)
    await replacement.checkUpdate(true)
    assert.equal((await replacement.installUpdate(true, '0.2.0')).phase, 'installing')
    assert.equal(installs, 1)
    completed.resolve(success())
    await pending
    await until(() => replacement!.snapshot(true).updateInstallation?.phase === 'restart-required')
    assert.equal((await replacement.reconcileUpdate())?.phase, 'restart-required')
    assert.equal(installs, 1)
  } finally { completed.resolve(success()); await replacement?.dispose(); await h.cleanup() }
})

test('null waitForInstall stays unknown until installed and executing versions both match', async () => {
  const { JsonDocument } = await import('../src/core/storage.ts')
  const { newInstallRequestId, updateReceiptSpec } = await import('../src/core/updates.ts')
  const temp = await tempDir()
  let version = 'other'
  let installs = 0
  const receipt = await JsonDocument.open(join(temp.dir, '.dsh-remora-updates'), updateReceiptSpec)
  await receipt.update(() => ({ attempt: 1, version: PLUGIN_VERSION, requestId: newInstallRequestId(), phase: 'installing' }))
  const manager: UpdatePluginManager = {
    listBundles: async () => [{ name: 'dsh-remora', installed: true, enabled: true, version }],
    waitForInstall: async () => null,
    installBundle: async () => { installs++; return success() },
  }
  const core = apply(fakeHost({ pluginManager: manager, profileContext: { dir: temp.dir } }).ctx, undefined, { dataDir: temp.dir })
  try {
    await core.ready
    assert.equal((await core.reconcileUpdate())?.phase, 'unknown')
    assert.equal(installs, 0)
    version = PLUGIN_VERSION
    assert.equal((await core.reconcileUpdate())?.phase, 'confirmed')
    assert.equal(installs, 0)
  } finally { await core.dispose(); await temp.cleanup() }
})

test('read-only and developer installations are manual; no download or install begins', async () => {
  for (const bundle of [{ installed: false }, { readOnlyReason: 'management-required' as const }, { source: '/developer/checkout' }]) {
    let installs = 0
    let requests = 0
    const base = github('')
    const h = await updateCore({
      listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', enabled: true, installed: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz', ...bundle }],
      installBundle: async () => { installs++; return success() },
    }, async url => { requests++; return base(url) })
    try {
      assert.equal((await h.core.installUpdate(true, '0.2.0')).phase, 'failed')
      assert.equal(installs, 0)
      assert.equal(requests, 2)
    } finally { await h.cleanup() }
  }
})

test('lost install response is discoverable through status and CF forwarding stays remote', async () => {
  let installs = 0
  const h = await updateCore({
    listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, enabled: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz' }],
    installBundle: async () => { installs++; return success() },
  })
  try {
    const forwarded = await rpc(h.host.routes, 'update-install', { version: '0.2.0' }, { peer: '127.0.0.1', host: 'public.example', origin: 'https://public.example', headers: { 'x-forwarded-for': '192.0.2.1' } })
    assert.equal(forwarded.ok, false)
    assert.equal(installs, 0)
    await h.core.installUpdate(true, '0.2.0') // The original browser never receives this reply.
    const receipt = await rpc<UpdateInstallation>(h.host.routes, 'update-reconcile')
    assert.equal(receipt.ok && receipt.value.phase, 'restart-required')
    assert.ok(receipt.ok && receipt.value.requestId)
    await rpc(h.host.routes, 'update-install', { version: '0.2.0' })
    assert.equal(installs, 1)
  } finally { await h.cleanup() }
})

test('pre-install interruption remains retryable after restart and manager absence has a manual reason', async () => {
  const { JsonDocument } = await import('../src/core/storage.ts')
  const { newInstallRequestId, updateReceiptSpec } = await import('../src/core/updates.ts')
  const temp = await tempDir()
  const receipt = await JsonDocument.open(join(temp.dir, '.dsh-remora-updates'), updateReceiptSpec)
  await receipt.update(() => ({ attempt: 1, version: '0.2.0', requestId: newInstallRequestId(), phase: 'downloading' }))
  const core = apply(fakeHost({ profileContext: { dir: temp.dir } }).ctx, undefined, { dataDir: temp.dir, dshVersion: '0.2.1-alpha.2', githubFetch: github('') })
  try {
    await core.ready
    assert.equal(core.snapshot(true).updateInstallation?.phase, 'failed')
    assert.equal(core.snapshot(true).updateInstallation?.error, 'interrupted-before-install')
    assert.equal((await core.checkUpdate(true)).installUnavailable, 'manager-unavailable')
  } finally { await core.dispose(); await temp.cleanup() }
})

test('a changed release is rejected before any download or install', async () => {
  let reads = 0
  let installs = 0
  const base = github('')
  const h = await updateCore({
    listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, enabled: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz' }],
    installBundle: async () => { installs++; return success() },
  }, async url => {
    reads++
    const response = await base(url)
    if (reads === 3) return Response.json({ ...await response.json(), id: 456 })
    return response
  })
  try {
    assert.equal((await h.core.installUpdate(true, '0.2.0')).error, 'candidate-changed')
    assert.equal(installs, 0)
    assert.equal(reads, 4)
  } finally { await h.cleanup() }
})

test('a cancelled removal restores the previous source only when the plugin is gone', async t => {
  for (const label of ['absent', 'still listed', 'list unreadable'] as const) await t.test(label, async () => {
    let removed = false
    const specs: string[] = []
    const h = await updateCore({
      listBundles: async () => {
        if (label === 'list unreadable' && removed) throw new Error('list failed')
        return removed && label === 'absent' ? [] : [installedBundle]
      },
      installBundle: async (spec) => {
        specs.push(spec)
        if (specs.length === 1) return alreadyInstalled()
        return { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.1.2' }
      },
      removeBundle: async () => {
        removed = true
        return { changed: false, application: 'cancelled', stage: 'remove', target: 'dsh-remora' }
      },
    })
    try {
      const result = await h.core.installUpdate(true, '0.2.0')
      if (label === 'absent') {
        assert.equal(specs.length, 2)
        assert.equal(specs[1], installedBundle.source)
        assert.equal(result.phase, 'failed')
        assert.equal(result.error, 'previous-restored')
        assert.equal(result.installedVersion, '0.1.2')
      } else if (label === 'still listed') {
        assert.equal(specs.length, 1)
        assert.equal(result.phase, 'cancelled')
        assert.equal(result.error, undefined)
      } else {
        assert.equal(specs.length, 1)
        assert.equal(result.phase, 'failed')
        assert.equal(result.error, 'presence-unknown')
      }
    } finally { await h.cleanup() }
  })
})

test('a failed restore receipt save is logged and kept on the update', async () => {
  let removed = false
  const specs: string[] = []
  const h = await updateCore({
    listBundles: async () => removed ? [] : [installedBundle],
    installBundle: async (spec) => {
      specs.push(spec)
      if (specs.length === 1) return alreadyInstalled()
      if (specs.length === 2) return { changed: false, application: 'failed', stage: 'install', target: 'dsh-remora', error: { code: 'operation-error' } }
      return { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.1.2' }
    },
    removeBundle: async () => {
      removed = true
      return { changed: true, application: 'applied', stage: 'remove', target: 'dsh-remora' }
    },
  })
  const receipt: StoredDocument<UpdateInstallation | null> = Reflect.get(h.core, 'updateReceipt')
  const save = receipt.update.bind(receipt)
  let blocked = 0
  receipt.update = async change => {
    const next = change(receipt.value)
    if (next?.restoreRequestId && next.phase === 'installing') {
      blocked++
      throw new Error('receipt write failed')
    }
    return save(change)
  }
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.equal(blocked, 1)
    assert.equal(specs.length, 3)
    assert.equal(specs[2], installedBundle.source)
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'restore-receipt-failed')
    assert.equal(result.installedVersion, '0.1.2')
    assert.ok(h.host.warnings.some(entry => String(entry[0]).includes('could not save the restore request id')))
    const raw = JSON.parse(await readFile(join(h.core.dataDir, '.dsh-remora-updates', 'update-receipt.json'), 'utf8')) as { data: UpdateInstallation }
    assert.equal(raw.data.error, 'restore-receipt-failed')
    assert.equal(raw.data.installedVersion, '0.1.2')
    assert.equal(typeof raw.data.restoreRequestId, 'string')
  } finally { receipt.update = save; await h.cleanup() }
})

test('candidate peers are checked against prerelease DSH and unknown compatibility blocks install', async () => {
  const base = github('')
  for (const runtime of ['0.2.1-alpha.2', '0.2.2', null]) {
    const result = await checkForUpdate('0.1.0', base, 123, runtime)
    assert.equal(result.installUnavailable, runtime === '0.2.1-alpha.2' ? undefined : runtime === null ? 'compatibility-unknown' : 'incompatible-dsh')
  }
  const missing = await checkForUpdate('0.1.0', async (url, init) => url.startsWith('https://raw.') ? new Response('', { status: 404 }) : base(url), 123, '0.2.1-alpha.2')
  assert.equal(missing.error, 'compatibility-unknown')
  const mismatched = await checkForUpdate('0.1.0', async url => url.startsWith('https://raw.') ? Response.json({ name: 'dsh-remora', version: '9.0.0' }) : base(url), 123, '0.2.1-alpha.2')
  assert.equal(mismatched.error, 'invalid-manifest')
  const omittedRuntime = await checkForUpdate('0.1.0', base, 123)
  assert.equal(omittedRuntime.newer, true)
  assert.equal(omittedRuntime.installUnavailable, 'compatibility-unknown')
  assert.equal((await checkForUpdate('0.1.0', base, 123, 'not-a-version')).installUnavailable, 'compatibility-unknown')
})

test('unbounded DSH peer ranges are refused, and a 0.2 ceiling is accepted', async () => {
  const runtime = '0.2.1-alpha.2'
  const refused = ['*', 'x', '>=0', '', '<99', '^0', '<0.3.0-0', '>=0.2.1-alpha.2', '>=0.2.1 <0.4.0', '>=0.2.1-alpha.2 <0.3.0']
  for (const peer of refused) {
    const fetchImpl = async (url: string) => {
      if (url.startsWith('https://raw.githubusercontent.com/')) return Response.json({ name: 'dsh-remora', version: '0.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh': peer } })
      return github('')(url)
    }
    const result = await checkForUpdate('0.1.0', fetchImpl, 123, runtime)
    assert.equal(result.installUnavailable, 'compatibility-unknown', peer)
  }
  const accepted = ['>=0.2.1-alpha.2 <0.2.2-0', '>=0.2.1-alpha.2 <=0.2.2-alpha.2', '>=0.2.1-alpha.2 <0.3.0-0', '^0.2.1']
  for (const peer of accepted) {
    const fetchImpl = async (url: string) => {
      if (url.startsWith('https://raw.githubusercontent.com/')) return Response.json({ name: 'dsh-remora', version: '0.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh': peer } })
      return github('')(url)
    }
    assert.equal((await checkForUpdate('0.1.0', fetchImpl, 123, '0.2.1-alpha.3')).installUnavailable, undefined, peer)
  }
  const temp = await tempDir()
  try {
    const sums = `${sha}  dsh-remora-0.2.0.tgz\n`
    const release = (await checkForUpdate('0.1.0', github(sums), 123, runtime)).latest!
    const base = github(sums)
    await assert.rejects(downloadVerified(release, temp.dir, base), (error: unknown) => error instanceof UpdateError && error.code === 'compatibility-unknown')
    await assert.rejects(downloadVerified(release, temp.dir, base, null), (error: unknown) => error instanceof UpdateError && error.code === 'compatibility-unknown')
    await assert.rejects(downloadVerified(release, temp.dir, base, '0.2.2'), (error: unknown) => error instanceof UpdateError && error.code === 'incompatible-dsh')
    for (const peer of refused) {
      const archive = packageArchive({ peerDependencies: { '@deepseek-ai/dsh': peer } })
      const digest = createHash('sha256').update(archive).digest('hex')
      const fetchImpl = async (url: string) => url.endsWith('.tgz') ? new Response(archive) : github(`${digest}  dsh-remora-0.2.0.tgz\n`)(url)
      const ranged = (await checkForUpdate('0.1.0', github(`${digest}  dsh-remora-0.2.0.tgz\n`), 123, runtime)).latest!
      await assert.rejects(downloadVerified(ranged, temp.dir, fetchImpl, runtime), (error: unknown) => error instanceof UpdateError && error.code === 'compatibility-unknown', peer)
    }
    const ceiling = packageArchive({ peerDependencies: { '@deepseek-ai/dsh': '>=0.2.1-alpha.2 <0.3.0-0' } })
    const ceilingDigest = createHash('sha256').update(ceiling).digest('hex')
    const ceilingFetch = async (url: string) => url.endsWith('.tgz') ? new Response(ceiling) : github(`${ceilingDigest}  dsh-remora-0.2.0.tgz\n`)(url)
    const ceilingRelease = (await checkForUpdate('0.1.0', github(`${ceilingDigest}  dsh-remora-0.2.0.tgz\n`), 123, runtime)).latest!
    assert.equal(typeof await downloadVerified(ceilingRelease, temp.dir, ceilingFetch, '0.2.1-alpha.3'), 'string')
  } finally { await temp.cleanup() }
})

test('local release tarballs are updateable; directory links and custom archives stay manual', async () => {
  const { writeFile, symlink, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const temp = await tempDir()
  const tgz = join(temp.dir, 'dsh-remora-0.1.2.tgz')
  await writeFile(tgz, 'installed release archive')
  const core = apply(fakeHost({ profileContext: { dir: temp.dir }, pluginManager: {
    listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, enabled: false, source: pathToFileURL(tgz).href }],
    installBundle: async (_path: string, options: { enabled: boolean }) => { assert.equal(options.enabled, false); return success() },
  } }).ctx, undefined, { dataDir: temp.dir, dshVersion: '0.2.1-alpha.2', githubFetch: github(`${sha}  dsh-remora-0.2.0.tgz\n`) })
  try {
    await core.ready
    assert.equal((await core.checkUpdate(true)).installUnavailable, undefined)
    assert.equal((await core.installUpdate(true, '0.2.0')).phase, 'restart-required')
    const linked = join(temp.dir, 'linked')
    const directory = join(temp.dir, 'directory', 'dsh-remora-0.1.2.tgz')
    await mkdir(linked)
    await mkdir(directory, { recursive: true })
    const link = join(linked, 'dsh-remora-0.1.2.tgz')
    await symlink(tgz, link)
    const custom = join(temp.dir, 'custom.tgz')
    await writeFile(custom, 'custom archive')
    for (const source of [directory, link, custom]) {
      const h = await updateCore({
        listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, enabled: true, source }],
        installBundle: async () => { throw new Error('manual sources must never install') },
      })
      try {
        assert.equal((await h.core.checkUpdate(false)).installUnavailable, 'manual-source')
        assert.equal((await h.core.installUpdate(true, '0.2.0')).error, 'manual-source')
      } finally { await h.cleanup() }
    }
  } finally { await core.dispose(); await temp.cleanup() }
})


test('timeouts and symlinked update storage fail before installer handoff', async () => {
  const { symlink } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const base = github(`${sha}  dsh-remora-0.2.0.tgz\n`)
  const release = (await checkForUpdate('0.1.0', base)).latest!
  const temp = await tempDir()
  const outside = await tempDir()
  try {
    await assert.rejects(downloadVerified(release, temp.dir, async () => { throw new DOMException('timed out', 'TimeoutError') }), { name: 'TimeoutError' })
    await symlink(outside.dir, join(temp.dir, 'updates'), 'dir')
    await assert.rejects(downloadVerified(release, temp.dir, base, '0.2.1-alpha.2'), (e: unknown) => e instanceof UpdateError && e.code === 'unsafe-storage')
  } finally { await temp.cleanup(); await outside.cleanup() }
})

test('OFF during the awaited installing receipt write prevents manager invocation', async () => {
  const resume = gate<void>()
  let writing = false
  let installs = 0
  const h = await updateCore({
    listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, enabled: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz' }],
    installBundle: async () => { installs++; return success() },
  })
  // Delay this owned receipt writer only; other documents and Host instances keep running.
  const receipt: StoredDocument<UpdateInstallation | null> = Reflect.get(h.core, 'updateReceipt')
  const save = receipt.update.bind(receipt)
  receipt.update = async change => {
    if (change(receipt.value)?.phase === 'installing') { writing = true; await resume.promise }
    return save(change)
  }
  try {
    const pending = h.core.installUpdate(true, '0.2.0')
    await until(() => writing)
    await h.core.dispose()
    resume.resolve()
    const result = await pending
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'unloading')
    assert.equal(installs, 0)
    const recorded = await receipt.refresh()
    assert.equal(recorded?.requestId, result.requestId)
    assert.equal(recorded?.phase, 'failed')
  } finally { resume.resolve(); receipt.update = save; await h.cleanup() }
})

test('two profiles share auth data but never inherit each other\'s unresolved or restart receipt', async () => {
  const shared = await tempDir()
  const profileA = await tempDir()
  const profileB = await tempDir()
  const manager: UpdatePluginManager = {
    listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, enabled: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz' }],
    installBundle: async () => success(),
    waitForInstall: async () => null,
  }
  const options = { dataDir: shared.dir, dshVersion: '0.2.1-alpha.2', githubFetch: github(`${sha}  dsh-remora-0.2.0.tgz\n`) }
  const a = apply(fakeHost({ pluginManager: manager, profileContext: { dir: profileA.dir } }).ctx, undefined, options)
  let b: ReturnType<typeof apply> | undefined
  try {
    await a.ready
    await a.checkUpdate(true)
    const installedA = await a.installUpdate(true, '0.2.0')
    assert.equal(installedA.phase, 'restart-required')
    const receiptA: StoredDocument<UpdateInstallation | null> = Reflect.get(a, 'updateReceipt')
    await receiptA.update(current => current ? { ...current, phase: 'unknown' } : current)
    // An old home-level receipt belongs to no current profile and is ignored.
    const { JsonDocument } = await import('../src/core/storage.ts')
    const { updateReceiptSpec } = await import('../src/core/updates.ts')
    await (await JsonDocument.open(shared.dir, updateReceiptSpec)).update(() => installedA)
    b = apply(fakeHost({ pluginManager: manager, profileContext: { dir: profileB.dir } }).ctx, undefined, options)
    await b.ready
    assert.equal(b.snapshot(true).updateInstallation, null)
    await b.checkUpdate(true)
    const installedB = await b.installUpdate(true, '0.2.0')
    assert.equal(installedB.phase, 'restart-required')
    assert.notEqual(installedB.requestId, installedA.requestId)
    assert.equal((await receiptA.refresh())?.phase, 'unknown')
    const receiptB: StoredDocument<UpdateInstallation | null> = Reflect.get(b, 'updateReceipt')
    assert.notEqual(receiptB.path, receiptA.path)
    assert.equal(a.dataDir, b.dataDir)
  } finally { await b?.dispose(); await a.dispose(); await shared.cleanup(); await profileA.cleanup(); await profileB.cleanup() }
})

test('checksum-matching archives with wrong identity/version/bundle/peers never reach manager', async t => {
  for (const overrides of [{ name: 'other-package' }, { version: '0.1.0' }, { dsh: { bundle: { patch: './other.patch.yml' } } }, { peerDependencies: { '@deepseek-ai/dsh': '>=0.3.0' } }, { peerDependencies: {} }]) await t.test(JSON.stringify(overrides), async () => {
    const archive = packageArchive(overrides)
    const digest = createHash('sha256').update(archive).digest('hex')
    let installs = 0
    const base = github(`${digest}  dsh-remora-0.2.0.tgz\n`)
    const h = await updateCore({
      listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, enabled: false, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz' }],
      installBundle: async () => { installs++; return success() },
    }, async url => url.endsWith('.tgz') ? new Response(archive) : base(url))
    try {
      const result = await h.core.installUpdate(true, '0.2.0')
      assert.equal(result.phase, 'failed')
      assert.ok(['invalid-manifest', 'incompatible-dsh', 'compatibility-unknown'].includes(result.error!))
      assert.equal(installs, 0)
      assert.equal((await h.core.auditEntries()).find(entry => entry.action === 'update:0.2.0')?.outcome, 'error')
    } finally { await h.cleanup() }
  })
})

test('a newer candidate and a second Client cannot overwrite an unresolved operation', async () => {
  let newer = false
  let installs = 0
  const base = github(`${sha}  dsh-remora-0.2.0.tgz\n`)
  const archive = packageArchive({ version: '0.2.1' })
  const digest = createHash('sha256').update(archive).digest('hex')
  const h = await updateCore({
    listBundles: async () => [{ name: 'dsh-remora', version: '0.1.2', installed: true, enabled: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz' }],
    installBundle: async () => { installs++; throw new Error('lost result after manager admission') },
    waitForInstall: async () => null,
  }, async url => {
    if (!newer) return base(url)
    if (url.endsWith('/releases/latest') || url.startsWith('https://raw.')) {
      const metadata = JSON.parse(JSON.stringify(await (await base(url)).json()).replaceAll('0.2.0', '0.2.1'))
      if (url.endsWith('/releases/latest')) metadata.id = 124
      return Response.json(metadata)
    }
    return new Response(url.endsWith('.tgz') ? archive : `${digest}  dsh-remora-0.2.1.tgz\n`)
  })
  try {
    const original = await h.core.installUpdate(true, '0.2.0')
    assert.equal(original.phase, 'unknown')
    newer = true
    assert.equal((await h.core.checkUpdate(true)).latest?.version, '0.2.1')
    const [newClient, oldClient] = await Promise.all([
      rpc<UpdateInstallation>(h.host.routes, 'update-install', { version: '0.2.1' }),
      rpc<UpdateInstallation>(h.host.routes, 'update-install', { version: '0.2.0' }),
    ])
    assert.equal(newClient.ok, false)
    if (!newClient.ok) assert.equal(newClient.error.code, 'remora/update-in-progress')
    assert.equal(oldClient.ok && oldClient.value.requestId, original.requestId)
    assert.equal(h.core.snapshot(true).updateInstallation?.requestId, original.requestId)
    assert.equal(h.core.snapshot(true).updateInstallation?.attempt, original.attempt)
    assert.equal(installs, 1)
    assert.equal((await h.core.reconcileUpdate())?.requestId, original.requestId)
  } finally { await h.cleanup() }
})

test('an externally installed newer version blocks a downgrade and shows restart pending', async () => {
  let installs = 0
  const h = await updateCore({
    listBundles: async () => [{ name: 'dsh-remora', version: '0.3.0', installed: true, enabled: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.3.0/dsh-remora-0.3.0.tgz' }],
    installBundle: async () => { installs++; return success() },
  })
  try {
    const check = await h.core.checkUpdate(false)
    assert.equal(check.latest?.version, '0.2.0')
    assert.equal(check.newer, false)
    assert.equal(check.installedVersion, '0.3.0')
    assert.equal(check.restartRequired, true)
    await assert.rejects(h.core.installUpdate(true, '0.2.0'))
    assert.equal(installs, 0)
  } finally { await h.cleanup() }
})

const packageRun = (exitCode: number) => ({ exitCode, output: '', truncated: false, logPath: '/logs/install' })

test('a thrown removal, or a non-stop-profile failure that still removed the bundle, restores the previous source', async t => {
  for (const label of ['remove throws', 'not-removable but absent'] as const) await t.test(label, async () => {
    let removed = false
    const specs: string[] = []
    const h = await updateCore({
      listBundles: async () => removed ? [] : [installedBundle],
      installBundle: async (spec) => {
        specs.push(spec)
        if (specs.length === 1) return alreadyInstalled()
        return { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.1.2' }
      },
      removeBundle: async () => {
        removed = true
        if (label === 'remove throws') throw new Error('remove exploded')
        return { changed: false, application: 'failed', stage: 'remove', target: 'dsh-remora', error: { code: 'not-removable' } }
      },
    })
    try {
      const result = await h.core.installUpdate(true, '0.2.0')
      assert.equal(specs.length, 2)
      assert.equal(specs[1], installedBundle.source)
      assert.equal(result.phase, 'failed')
      assert.equal(result.error, 'previous-restored')
      assert.equal(result.installedVersion, '0.1.2')
    } finally { await h.cleanup() }
  })
})

test('a thrown removal that leaves the bundle listed does not install the previous source', async () => {
  let installs = 0
  const h = await updateCore({
    listBundles: async () => [installedBundle],
    installBundle: async () => { installs++; return alreadyInstalled() },
    removeBundle: async () => { throw new Error('remove exploded') },
  })
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.equal(installs, 1)
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'install-failed')
  } finally { await h.cleanup() }
})

test('previous-restored is reported only when the bundle name, version and package result match', async t => {
  const cases: { label: string; third: BundleChangeResult; listedVersion: string; error: string }[] = [
    { label: 'matching package result', third: { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.1.2', packageResult: packageRun(0) }, listedVersion: '9.9.9', error: 'previous-restored' },
    { label: 'wrong version', third: { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.2.0', packageResult: packageRun(0) }, listedVersion: '0.1.2', error: 'restore-failed' },
    { label: 'package exit code', third: { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.1.2', packageResult: packageRun(1) }, listedVersion: '0.1.2', error: 'restore-failed' },
    { label: 'omitted fields and the list shows the previous version', third: { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora' }, listedVersion: '0.1.2', error: 'previous-restored' },
    { label: 'omitted fields and the list shows another version', third: { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora' }, listedVersion: '0.2.0', error: 'restore-failed' },
  ]
  for (const item of cases) await t.test(item.label, async () => {
    let removed = false
    let installs = 0
    const h = await updateCore({
      listBundles: async () => {
        if (!removed || installs < 3) return removed ? [] : [installedBundle]
        return [{ ...installedBundle, version: item.listedVersion }]
      },
      installBundle: async () => {
        installs++
        if (installs === 1) return alreadyInstalled()
        if (installs === 2) return { changed: false, application: 'failed', stage: 'install', target: 'dsh-remora', error: { code: 'operation-error' } }
        return item.third
      },
      removeBundle: async () => {
        removed = true
        return { changed: true, application: 'applied', stage: 'remove', target: 'dsh-remora' }
      },
    })
    try {
      const result = await h.core.installUpdate(true, '0.2.0')
      assert.equal(installs, 3)
      assert.equal(result.phase, 'failed')
      assert.equal(result.error, item.error)
      if (item.error === 'previous-restored') assert.equal(result.installedVersion, '0.1.2')
    } finally { await h.cleanup() }
  })
})

test('an overridden install after removal restores the previous source only when the plugin is gone', async t => {
  for (const gone of [true, false]) await t.test(gone ? 'absent' : 'still listed', async () => {
    let removed = false
    const specs: string[] = []
    const h = await updateCore({
      listBundles: async () => removed && gone ? [] : [installedBundle],
      installBundle: async (spec) => {
        specs.push(spec)
        if (specs.length === 1) return alreadyInstalled()
        if (specs.length === 2) return { ...success(), application: 'overridden' }
        return { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.1.2' }
      },
      removeBundle: async () => {
        removed = true
        return { changed: true, application: 'applied', stage: 'remove', target: 'dsh-remora' }
      },
    })
    try {
      const result = await h.core.installUpdate(true, '0.2.0')
      if (gone) {
        assert.equal(specs.length, 3)
        assert.equal(specs[2], installedBundle.source)
        assert.equal(result.phase, 'failed')
        assert.equal(result.error, 'previous-restored')
      } else {
        assert.equal(specs.length, 2)
        assert.equal(result.phase, 'overridden')
      }
    } finally { await h.cleanup() }
  })
})

test('a restart during restore follows the saved restore request id', async () => {
  const restoreHeld = gate<BundleChangeResult>()
  let removed = false
  const specs: string[] = []
  let restoreId = ''
  let originalId = ''
  const manager: UpdatePluginManager = {
    listBundles: async () => removed ? [] : [installedBundle],
    installBundle: async (spec, options) => {
      specs.push(spec)
      if (specs.length === 1) {
        originalId = options.requestId
        return alreadyInstalled()
      }
      if (specs.length === 2) return { changed: false, application: 'failed', stage: 'install', target: spec, error: { code: 'operation-error' } }
      restoreId = options.requestId
      return restoreHeld.promise
    },
    removeBundle: async () => {
      removed = true
      return { changed: true, application: 'applied', stage: 'remove', target: 'dsh-remora' }
    },
    waitForInstall: async id => id === restoreId
      ? { changed: true, application: 'applied', stage: 'install', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.1.2' }
      : { changed: false, application: 'failed', stage: 'install', target: 'dsh-remora', error: { code: 'operation-error' } },
  }
  const h = await updateCore(manager)
  const pending = h.core.installUpdate(true, '0.2.0')
  let replacement: ReturnType<typeof apply> | undefined
  try {
    await until(() => specs.length === 3)
    const raw = JSON.parse(await readFile(join(h.core.dataDir, '.dsh-remora-updates', 'update-receipt.json'), 'utf8')) as { data: UpdateInstallation }
    assert.equal(raw.data.phase, 'installing')
    assert.equal(raw.data.requestId, originalId)
    assert.equal(raw.data.restoreRequestId, restoreId)
    assert.equal(raw.data.restoreRequestId === raw.data.requestId, false)
    assert.equal(raw.data.restoreVersion, '0.1.2')
    assert.equal(specs[2], installedBundle.source)
    await h.core.dispose()
    replacement = apply(fakeHost({ pluginManager: manager, profileContext: { dir: h.core.dataDir } }).ctx, undefined, { dataDir: h.core.dataDir, dshVersion: '0.2.1-alpha.2', githubFetch: github(`${sha}  dsh-remora-0.2.0.tgz\n`) })
    await replacement.ready
    const settled = await replacement.reconcileUpdate()
    assert.equal(settled?.phase, 'failed')
    assert.equal(settled?.error, 'previous-restored')
    assert.equal(settled?.installedVersion, '0.1.2')
  } finally {
    restoreHeld.resolve({ changed: true, application: 'applied', stage: 'install', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.1.2' })
    await pending.catch(() => undefined)
    await replacement?.dispose()
    await h.cleanup()
  }
})

test('a lost restore result stays unknown instead of the original failed install', async () => {
  const { JsonDocument } = await import('../src/core/storage.ts')
  const { newInstallRequestId, updateReceiptSpec } = await import('../src/core/updates.ts')
  const temp = await tempDir()
  const requestId = newInstallRequestId()
  const restoreRequestId = newInstallRequestId()
  const receipt = await JsonDocument.open(join(temp.dir, '.dsh-remora-updates'), updateReceiptSpec)
  await receipt.update(() => ({ attempt: 1, version: '0.2.0', requestId, phase: 'installing', restoreRequestId, restoreVersion: '0.1.2' }))
  let installs = 0
  const manager: UpdatePluginManager = {
    listBundles: async () => [],
    installBundle: async () => { installs++; return success() },
    waitForInstall: async id => id === requestId
      ? { changed: false, application: 'failed', stage: 'install', target: 'dsh-remora', error: { code: 'operation-error' } }
      : null,
  }
  const core = apply(fakeHost({ pluginManager: manager, profileContext: { dir: temp.dir } }).ctx, undefined, { dataDir: temp.dir, dshVersion: '0.2.1-alpha.2' })
  try {
    await core.ready
    const settled = await core.reconcileUpdate()
    assert.equal(settled?.phase, 'unknown')
    assert.equal(settled?.restoreRequestId, restoreRequestId)
    assert.equal(settled?.error, undefined)
    assert.equal(installs, 0)
  } finally { await core.dispose(); await temp.cleanup() }
})

test('external upgrade during receipt I/O is rechecked immediately before manager invocation', async () => {
  let installedVersion = '0.1.2'
  let installs = 0
  const h = await updateCore({
    listBundles: async () => [{ name: 'dsh-remora', version: installedVersion, installed: true, enabled: true, source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz' }],
    installBundle: async () => { installs++; return success() },
  })
  const receipt: StoredDocument<UpdateInstallation | null> = Reflect.get(h.core, 'updateReceipt')
  const save = receipt.update.bind(receipt)
  receipt.update = async change => {
    const result = await save(change)
    if (result?.phase === 'installing') installedVersion = '0.3.0'
    return result
  }
  try {
    const result = await h.core.installUpdate(true, '0.2.0')
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'installed-version-current')
    assert.equal(installs, 0)
  } finally { receipt.update = save; await h.cleanup() }
})

test('a secondary Host with an actual occupied hub lock observes the update without starting another install', async () => {
  const downloaded = gate<void>()
  let downloads = 0
  let installs = 0
  const base = github(`${sha}  dsh-remora-0.2.0.tgz\n`)
  const fetchImpl = async (url: string) => {
    if (url.endsWith('.tgz')) { downloads++; await downloaded.promise }
    return base(url)
  }
  const manager: UpdatePluginManager = { listBundles: async () => [installedBundle], installBundle: async () => { installs++; return success() } }
  const h = await updateCore(manager, fetchImpl)
  const hub = new FakeHub({ port: 0, owner: [makePasskey('ed25519').credential] })
  let secondary: ReturnType<typeof apply> | undefined
  let pending: Promise<UpdateInstallation> | undefined
  try {
    await hub.listen()
    await h.core.startPairing(hub.origin, true)
    await until(() => h.core.internals.link.connected, 5_000)
    const secondHost = fakeHost({ profileContext: { dir: h.core.dataDir }, pluginManager: manager })
    secondary = apply(secondHost.ctx, undefined, { dataDir: h.core.dataDir, dshVersion: '0.2.1-alpha.2', githubFetch: fetchImpl })
    await secondary.ready
    assert.equal(h.core.snapshot(true).hub.lock, 'held')
    assert.equal(secondary.snapshot(true).hub.lock, 'other')
    await secondary.checkUpdate(true)
    pending = h.core.installUpdate(true, '0.2.0')
    await until(() => downloads === 1)
    const observed = await secondary.reconcileUpdate()
    assert.equal(observed?.phase, 'downloading')
    const duplicate = await rpc<UpdateInstallation>(secondHost.routes, 'update-install', { version: '0.2.0' })
    assert.equal(duplicate.ok, true)
    if (duplicate.ok) assert.equal(duplicate.value.requestId, observed?.requestId)
    downloaded.resolve()
    assert.equal((await pending).phase, 'restart-required')
    assert.equal(downloads, 1)
    assert.equal(installs, 1)
    assert.equal((await secondary.reconcileUpdate())?.phase, 'restart-required')
  } finally {
    downloaded.resolve()
    await pending?.catch(() => undefined)
    await secondary?.dispose()
    await hub.close()
    await h.cleanup()
  }
})

test('a live-owner observer cannot rewind a completed receipt to installing while checking the bundle list', async () => {
  const completed = gate<BundleChangeResult>()
  const observed = gate<void>()
  let installs = 0
  let listing = false
  const h = await updateCore({ listBundles: async () => [installedBundle], installBundle: async () => { installs++; return completed.promise } })
  const pending = h.core.installUpdate(true, '0.2.0')
  let replacement: ReturnType<typeof apply> | undefined
  try {
    await until(() => installs === 1)
    const observer: UpdatePluginManager = {
      listBundles: async () => { listing = true; await observed.promise; return [installedBundle] },
      installBundle: async () => { throw new Error('observer must not install') },
    }
    replacement = apply(fakeHost({ pluginManager: observer, profileContext: { dir: h.core.dataDir } }).ctx, undefined, { dataDir: h.core.dataDir, dshVersion: '0.2.1-alpha.2' })
    await replacement.ready
    await until(() => listing)
    completed.resolve(success())
    assert.equal((await pending).phase, 'restart-required')
    observed.resolve()
    assert.equal((await replacement.reconcileUpdate())?.phase, 'restart-required')
    assert.equal(installs, 1)
  } finally {
    completed.resolve(success())
    observed.resolve()
    await pending.catch(() => undefined)
    await replacement?.dispose()
    await h.cleanup()
  }
})
