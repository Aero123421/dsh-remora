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
    { name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.2.0/first.tgz' },
    { name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.2.0/second.tgz' },
  ] }))
  assert.equal(duplicated.error, 'invalid-release')
})

const tarball = new TextEncoder().encode('fake tarball bytes')
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
    const host = fakeHost({ pluginManager: manager })
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
    })
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
    replacement = apply(fakeHost({ pluginManager: manager }).ctx, undefined, { dataDir: h.core.dataDir, dshVersion: '0.2.1-alpha.2', githubFetch: github(`${sha}  dsh-remora-0.2.0.tgz\n`) })
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
  const receipt = await JsonDocument.open(temp.dir, updateReceiptSpec)
  await receipt.update(() => ({ attempt: 1, version: PLUGIN_VERSION, requestId: newInstallRequestId(), phase: 'installing' }))
  const manager: UpdatePluginManager = {
    listBundles: async () => [{ name: 'dsh-remora', installed: true, enabled: true, version }],
    waitForInstall: async () => null,
    installBundle: async () => { installs++; return success() },
  }
  const core = apply(fakeHost({ pluginManager: manager }).ctx, undefined, { dataDir: temp.dir })
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
  const receipt = await JsonDocument.open(temp.dir, updateReceiptSpec)
  await receipt.update(() => ({ attempt: 1, version: '0.2.0', requestId: newInstallRequestId(), phase: 'downloading' }))
  const core = apply(fakeHost().ctx, undefined, { dataDir: temp.dir, dshVersion: '0.2.1-alpha.2', githubFetch: github('') })
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
})

test('local release tarballs are updateable; directory links and custom archives stay manual', async () => {
  const { writeFile, symlink, mkdir } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const temp = await tempDir()
  const tgz = join(temp.dir, 'dsh-remora-0.1.2.tgz')
  await writeFile(tgz, 'installed release archive')
  const core = apply(fakeHost({ pluginManager: {
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
    await assert.rejects(downloadVerified(release, temp.dir, base), (e: unknown) => e instanceof UpdateError && e.code === 'unsafe-storage')
  } finally { await temp.cleanup(); await outside.cleanup() }
})
