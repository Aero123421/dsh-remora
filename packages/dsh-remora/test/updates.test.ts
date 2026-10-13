import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { checkForUpdate, compareVersions, downloadVerified, expectedHash, MAX_TARBALL_BYTES, UpdateError, type BundleChangeResult, type UpdateInstallation, type UpdatePluginManager } from '../src/core/updates.ts'
import { apply } from '../src/index.ts'
import { PLUGIN_VERSION } from '../src/dsh.ts'
import { fakeHost, rpc, tempDir, until } from './helpers.ts'

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
    { name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://example.test/first.tgz' },
    { name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://example.test/second.tgz' },
  ] }))
  assert.equal(duplicated.error, 'invalid-release')
})

const tarball = new TextEncoder().encode('fake tarball bytes')
const sha = createHash('sha256').update(tarball).digest('hex')

function github(sums: string) {
  return async (url: string) => {
    if (url.endsWith('/releases/latest')) {
      return Response.json({
        tag_name: 'v0.2.0', name: 'v0.2.0', body: 'Notes', html_url: 'https://github.com/Aero123421/dsh-remora/releases/tag/v0.2.0',
        assets: [
          { name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://example.test/dsh-remora-0.2.0.tgz' },
          { name: 'SHA256SUMS', browser_download_url: 'https://example.test/SHA256SUMS' },
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
    const path = await downloadVerified(check.latest!, t.dir, github(`${sha}  dsh-remora-0.2.0.tgz\n`))
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

async function updateCore(manager: UpdatePluginManager, fetchImpl = github(`${sha}  dsh-remora-0.2.0.tgz\n`)) {
  const temp = await tempDir()
  const host = fakeHost({ pluginManager: manager })
  const core = apply(host.ctx, undefined, { dataDir: temp.dir, githubFetch: fetchImpl })
  await core.ready
  await core.checkUpdate(true)
  return { core, host, cleanup: async () => { await core.dispose(); await temp.cleanup() } }
}

test('installation waits for DSH, preserves disabled selection, joins duplicate requests and reports restart separately', async () => {
  const completed = gate<BundleChangeResult>()
  let installs = 0
  let options: { enabled: boolean } | undefined
  const h = await updateCore({
    listBundles: async () => [{ name: 'dsh-remora', enabled: false }],
    installBundle: async (_spec, selected) => { installs++; options = selected; return completed.promise },
  })
  try {
    let returned = false
    const first = rpc<UpdateInstallation>(h.host.routes, 'update-install', { version: '0.2.0' }).then(value => { returned = true; return value })
    await until(() => installs === 1)
    assert.equal(returned, false)
    assert.equal(h.core.snapshot(true).updateInstallation?.phase, 'installing')
    assert.deepEqual(options, { enabled: false })
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
    { label: 'package failure', result: { ...success(), packageResult: { exitCode: 1, kind: 'build-blocked' } }, phase: 'failed', error: 'build-blocked' },
  ]
  for (const item of cases) await t.test(item.label, async () => {
    const h = await updateCore({ listBundles: async () => [{ name: 'dsh-remora', enabled: true }], installBundle: async () => item.result })
    try {
      const result = await h.core.installUpdate(true, '0.2.0')
      assert.equal(result.phase, item.phase)
      assert.equal(result.error, item.error)
      assert.equal((await h.core.auditEntries()).find(entry => entry.action === 'update:0.2.0')?.outcome, 'error')
    } finally { await h.cleanup() }
  })
})

test('missing bundle selection and rejected installer calls fail visibly', async t => {
  for (const missing of [false, true]) await t.test(missing ? 'unknown selection' : 'rejected installer', async () => {
    let installs = 0
    const h = await updateCore({
      listBundles: async () => missing ? [] : [{ name: 'dsh-remora', enabled: true }],
      installBundle: async () => { installs++; throw new Error('pnpm unavailable') },
    })
    try {
      const result = await h.core.installUpdate(true, '0.2.0')
      assert.equal(result.phase, 'failed')
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
    assert.equal(requests, 1)
  } finally { await h.cleanup() }
})

test('unloading during the download prevents starting DSH installation', async () => {
  const resume = gate<void>()
  let downloading = false
  let installs = 0
  const fetchImpl = github(`${sha}  dsh-remora-0.2.0.tgz\n`)
  const h = await updateCore({
    listBundles: async () => [{ name: 'dsh-remora', enabled: true }],
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

test('same-version Host reloads have distinct update identities and reset transient attempt history', async () => {
  const manager: UpdatePluginManager = {
    listBundles: async () => [{ name: 'dsh-remora', enabled: true }],
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
    const host = fakeHost({ pluginManager: manager })
    replacement = apply(host.ctx, undefined, { dataDir: h.core.dataDir, githubFetch: github(`${sha}  dsh-remora-0.2.0.tgz\n`) })
    await replacement.ready
    const after = replacement.snapshot(true)
    assert.equal(after.version, before.version)
    assert.notEqual(after.updateHostInstance, before.updateHostInstance)
    assert.equal(after.updateInstallation, null)
    assert.equal(after.update, null)
    await replacement.checkUpdate(true)
    assert.equal((await replacement.installUpdate(true, '0.2.0')).attempt, 1)
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
