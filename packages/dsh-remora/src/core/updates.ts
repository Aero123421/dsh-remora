/**
 * Update check against GitHub Releases (`Aero123421/dsh-remora`). The plugin
 * is not on npm; each release carries `dsh-remora-<version>.tgz` and
 * `SHA256SUMS`.
 *
 * Installing: the tarball is downloaded, its SHA-256 checked against
 * `SHA256SUMS`, saved under the data directory and handed to DSH's own
 * plugin manager (`pluginManager.installBundle(<absolute path>)`) — the same
 * path as Plugins → Add plugin with a local file. When that service is not
 * available the tab shows the manual steps instead.
 */
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { satisfies, valid, validRange } from 'semver'
import { lstat, mkdir, mkdtemp } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { writeAtomic, asObject, type DocumentSpec } from './storage.ts'

export const RELEASES_REPO = 'Aero123421/dsh-remora'
export const MAX_TARBALL_BYTES = 20 * 1024 * 1024

export interface ReleaseInfo {
  id: number
  version: string
  name: string
  notes: string
  url: string
  publishedAt: string | null
  tarball: { name: string; url: string } | null
  sums: string | null
}

export interface UpdateCheck {
  current: string
  checkedAt: number
  latest: ReleaseInfo | null
  newer: boolean
  error?: string
  installUnavailable?: string
}

/** The subset of DSH 0.2.1-alpha.2's direct Host service used for self-updates. */
import type { BundleInfo, ChangeResult, InstallBundleOptions, PluginInstallRequestId } from '@deepseek-ai/dsh-plugin-manager/types'
export type { PluginInstallRequestId } from '@deepseek-ai/dsh-plugin-manager/types'
export type BundleChangeResult = ChangeResult
export function newInstallRequestId(): PluginInstallRequestId { return randomUUID() as PluginInstallRequestId }
export interface UpdatePluginManager {
  listBundles(): Promise<Pick<BundleInfo, 'name' | 'enabled' | 'installed' | 'readOnlyReason' | 'version' | 'source'>[]>
  installBundle(spec: string, options: InstallBundleOptions): Promise<ChangeResult>
  waitForInstall?(requestId: PluginInstallRequestId): Promise<ChangeResult | null>
}

export interface UpdateInstallation {
  /** Increases within the Host instance so polling cannot replace a newer attempt. */
  attempt: number
  requestId?: PluginInstallRequestId
  version: string
  phase: 'downloading' | 'installing' | 'unknown' | 'confirmed' | BundleChangeResult['application']
  installedVersion?: string
  stage?: BundleChangeResult['stage']
  error?: string
}

/** Only the non-secret operation receipt survives self-disposal and DSH restart. */
export const updateReceiptSpec: DocumentSpec<UpdateInstallation | null> = {
  file: 'update-receipt.json', version: 1, migrations: [], initial: () => null,
  parse(data) {
    if (data === null) return null
    const value = asObject(data, 'update receipt')
    if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1 || typeof value.version !== 'string' || !parseVersion(value.version) ||
        typeof value.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId) ||
        !['downloading', 'installing', 'unknown', 'confirmed', 'applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(String(value.phase))) {
      throw new Error('invalid update receipt')
    }
    const result: UpdateInstallation = { attempt: Number(value.attempt), version: value.version, requestId: value.requestId as PluginInstallRequestId, phase: value.phase as UpdateInstallation['phase'] }
    if (typeof value.installedVersion === 'string' && parseVersion(value.installedVersion)) result.installedVersion = value.installedVersion
    if (value.stage === 'install' || value.stage === 'enable' || value.stage === 'remove') result.stage = value.stage
    if (typeof value.error === 'string') result.error = value.error.slice(0, 200)
    return result
  },
}

/** HTTP/RPC completion alone is not evidence that DSH applied the requested version. */
export function installationResult(result: BundleChangeResult, operation: UpdateInstallation): UpdateInstallation {
  const state: UpdateInstallation = { ...operation, phase: result.application, stage: result.stage }
  if (result.version) state.installedVersion = result.version
  if (result.error) state.error = result.error.code
  const successful = result.application === 'applied' || result.application === 'restart-required'
  if (successful && (result.error || (result.packageResult && result.packageResult.exitCode !== 0))) {
    state.phase = 'failed'
    state.error ??= result.packageResult?.kind ?? 'package-failed'
  } else if (successful && (result.bundle !== 'dsh-remora' || result.version !== operation.version)) {
    state.phase = 'failed'
    state.error = 'installed-version-mismatch'
  } else if (!['applied', 'restart-required', 'overridden', 'failed', 'cancelled'].includes(result.application)) {
    state.phase = 'failed'
    state.error = 'invalid-result'
  }
  return state
}

type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: RequestRedirect }) => Promise<Response>

function parseVersion(version: string): { core: string[]; pre: string | null } | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version)
  if (!match) return null
  const pre = match[4] ?? null
  if (pre?.split('.').some(id => /^0\d+$/.test(id))) return null
  return { core: [match[1]!, match[2]!, match[3]!], pre }
}

function compareNumeric(a: string, b: string): number {
  return a.length !== b.length ? a.length - b.length : a === b ? 0 : a < b ? -1 : 1
}

/** Semver precedence: >0 when a is newer than b. Invalid versions are metadata errors. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) throw new UpdateError('invalid-version', 'invalid semantic version')
  for (let i = 0; i < 3; i++) {
    const order = compareNumeric(x.core[i]!, y.core[i]!)
    if (order !== 0) return order
  }
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1
  if (y.pre === null) return -1
  const xs = x.pre.split('.')
  const ys = y.pre.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const p = xs[i]
    const q = ys[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && p !== q) return compareNumeric(p, q)
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

export async function checkForUpdate(current: string, fetchImpl: FetchLike = fetch, now = Date.now(), runtimeVersion?: string | null): Promise<UpdateCheck> {
  try {
    if (!parseVersion(current)) throw new UpdateError('invalid-version', 'invalid current version')
    const response = await fetchImpl(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `dsh-remora/${current}` },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    })
    if (response.status === 404) return { current, checkedAt: now, latest: null, newer: false }
    if (!response.ok) return { current, checkedAt: now, latest: null, newer: false, error: `github-${response.status}` }
    const body = JSON.parse(new TextDecoder().decode(await readLimited(response, 256 * 1024))) as {
      id?: unknown; draft?: unknown; prerelease?: unknown; tag_name?: unknown; name?: unknown; body?: unknown; html_url?: unknown; published_at?: unknown
      assets?: { name?: unknown; browser_download_url?: unknown }[]
    }
    if (!body || !Number.isSafeInteger(body.id) || Number(body.id) < 1 || typeof body.tag_name !== 'string' || !parseVersion(body.tag_name) || body.tag_name !== body.tag_name.trim()) {
      return { current, checkedAt: now, latest: null, newer: false, error: 'invalid-release' }
    }
    if (body.draft !== false || body.prerelease !== false) throw new UpdateError('invalid-release', 'not a stable public release')
    const version = body.tag_name.replace(/^v/, '')
    if (parseVersion(version)?.pre) throw new UpdateError('invalid-release', 'prerelease is not a stable update')
    if (!Array.isArray(body.assets)) throw new UpdateError('invalid-release', 'missing release assets')
    const assets = body.assets
    const asset = (match: (name: string) => boolean) => {
      const found = assets.filter(item => item && typeof item.name === 'string' && match(item.name))
      if (found.length === 1 && typeof found[0]!.browser_download_url !== 'string') throw new UpdateError('invalid-release', 'missing asset URL')
      if (found.length > 1) throw new UpdateError('invalid-release', 'duplicate release assets')
      return found[0] ? { name: found[0].name as string, url: found[0].browser_download_url as string } : null
    }
    const tarball = asset(name => name === `dsh-remora-${version}.tgz`)
    const sums = asset(name => name === 'SHA256SUMS')
    for (const item of [tarball, sums]) if (item) validateAssetUrl(item.url, body.tag_name, item.name)
    if (typeof body.html_url === 'string' && body.html_url !== `https://github.com/${RELEASES_REPO}/releases/tag/${body.tag_name}`) throw new UpdateError('invalid-release', 'unexpected release URL')
    const latest: ReleaseInfo = {
      id: Number(body.id), version,
      name: typeof body.name === 'string' && body.name !== '' ? body.name : `v${version}`,
      notes: typeof body.body === 'string' ? body.body.slice(0, 20_000) : '',
      url: typeof body.html_url === 'string' ? body.html_url : `https://github.com/${RELEASES_REPO}/releases`,
      publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
      tarball,
      sums: sums?.url ?? null,
    }
    const check: UpdateCheck = { current, checkedAt: now, latest, newer: compareVersions(version, current) > 0 }
    if (!tarball || !sums) check.installUnavailable = 'no-assets'
    if (runtimeVersion !== undefined) {
      const manifestResponse = await fetchImpl(`https://raw.githubusercontent.com/${RELEASES_REPO}/${encodeURIComponent(body.tag_name)}/packages/dsh-remora/package.json`, {
        signal: AbortSignal.timeout(15_000), redirect: 'error',
      })
      if (!manifestResponse.ok) throw new UpdateError('compatibility-unknown', 'candidate manifest is unavailable')
      const manifest: unknown = JSON.parse(new TextDecoder().decode(await readLimited(manifestResponse, 64 * 1024)))
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new UpdateError('invalid-manifest', 'candidate manifest is malformed')
      const record = asObject(manifest, 'candidate manifest')
      if (record.name !== 'dsh-remora' || record.version !== version || !record.dsh || typeof record.dsh !== 'object' || !('bundle' in record.dsh)) {
        throw new UpdateError('invalid-manifest', 'candidate manifest does not describe this bundle')
      }
      const peers = record.peerDependencies && typeof record.peerDependencies === 'object' && !Array.isArray(record.peerDependencies) ? asObject(record.peerDependencies, 'candidate peers') : {}
      const range = peers['@deepseek-ai/dsh']
      if (typeof range !== 'string' || !validRange(range) || !runtimeVersion || !valid(runtimeVersion)) check.installUnavailable = 'compatibility-unknown'
      else if (!satisfies(runtimeVersion, range, { includePrerelease: true })) check.installUnavailable = 'incompatible-dsh'
    }
    return check
  } catch (error) {
    return { current, checkedAt: now, latest: null, newer: false, error: error instanceof UpdateError ? error.code : error instanceof SyntaxError ? 'invalid-release' : (error as Error).name === 'TimeoutError' ? 'timeout' : 'network' }
  }
}

export class UpdateError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'UpdateError'
    this.code = code
  }
}

async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > limit) {
    await response.body?.cancel()
    throw new UpdateError('too-large', 'the download is too large')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new UpdateError('too-large', 'the download is too large')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

/** Find `<hex>  <name>` in a SHA256SUMS file. */
export function expectedHash(sums: string, name: string): string | null {
  let found: string | null = null
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match && match[2] === name) {
      if (found) throw new UpdateError('invalid-checksum', 'duplicate checksum')
      found = match[1]!.toLowerCase()
    }
  }
  return found
}

function validateAssetUrl(value: string, tag: string, name: string): void {
  const url = new URL(value)
  const path = `/${RELEASES_REPO}/releases/download/${encodeURIComponent(tag)}/${name}`
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== path) {
    throw new UpdateError('invalid-release', 'unexpected release asset URL')
  }
}

async function fetchAsset(url: string, signal: AbortSignal, fetchImpl: FetchLike): Promise<Response> {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetchImpl(url, { signal, redirect: 'manual' })
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (!location) throw new UpdateError('redirect-refused', 'redirect has no location')
    const next = new URL(location, url)
    if (next.protocol !== 'https:' || next.port || next.username || next.password || next.hash ||
        !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) {
      throw new UpdateError('redirect-refused', 'unexpected asset redirect')
    }
    url = next.href
  }
  throw new UpdateError('redirect-refused', 'too many redirects')
}

/** Inspect the bounded archive in memory; never extract files or execute package code. */
export function packageManifest(bytes: Uint8Array): unknown {
  try {
    const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 })
    let manifest: unknown
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512)
      if (header.every(byte => byte === 0)) break
      const name = header.subarray(0, 100).toString().replace(/\0.*$/, '')
      const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '')
      const sizeText = header.subarray(124, 136).toString().replace(/\0.*$/, '').trim()
      if (!/^[0-7]+$/.test(sizeText)) throw new Error('invalid tar size')
      const size = Number.parseInt(sizeText, 8)
      if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length) throw new Error('truncated tar')
      if ((prefix ? `${prefix}/${name}` : name) === 'package/package.json') {
        if (manifest !== undefined || ![0, 48].includes(header[156]!) || size > 64 * 1024) throw new Error('invalid package manifest entry')
        manifest = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString())
      }
      offset += 512 + Math.ceil(size / 512) * 512
    }
    if (manifest === undefined) throw new Error('missing package manifest')
    return manifest
  } catch { throw new UpdateError('invalid-archive', 'invalid plugin archive') }
}

function validateArchive(bytes: Uint8Array, version: string, runtimeVersion?: string | null): void {
  const raw = packageManifest(bytes)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new UpdateError('invalid-manifest', 'invalid archive manifest')
  const manifest = asObject(raw, 'archive manifest')
  const dsh = manifest.dsh && typeof manifest.dsh === 'object' ? asObject(manifest.dsh, 'archive dsh') : {}
  const bundle = dsh.bundle && typeof dsh.bundle === 'object' ? asObject(dsh.bundle, 'archive bundle') : {}
  if (manifest.name !== 'dsh-remora' || manifest.version !== version || bundle.patch !== './cordis.patch.yml') throw new UpdateError('invalid-manifest', 'archive package, version or bundle mismatch')
  const peers = manifest.peerDependencies && typeof manifest.peerDependencies === 'object' ? asObject(manifest.peerDependencies, 'archive peers') : {}
  const range = peers['@deepseek-ai/dsh']
  if (typeof range !== 'string' || !validRange(range) || runtimeVersion === null) throw new UpdateError('compatibility-unknown', 'archive compatibility is unknown')
  if (runtimeVersion !== undefined && (!valid(runtimeVersion) || !satisfies(runtimeVersion, range, { includePrerelease: true }))) throw new UpdateError('incompatible-dsh', 'archive does not support this DSH version')
}

/** Download the release tarball, verify it against SHA256SUMS, and store it. Returns the absolute path. */
export async function downloadVerified(release: ReleaseInfo, dataDir: string, fetchImpl: FetchLike = fetch, runtimeVersion?: string | null): Promise<string> {
  if (!release.tarball || !release.sums) throw new UpdateError('no-assets', 'the release has no tarball or SHA256SUMS')
  if (!parseVersion(release.version) || release.tarball.name !== `dsh-remora-${release.version}.tgz`) throw new UpdateError('bad-name', 'unexpected tarball name')
  const tag = new URL(release.url).pathname.split('/').at(-1)!
  if (tag.replace(/^v/, '') !== release.version) throw new UpdateError('invalid-release', 'tag/version mismatch')
  validateAssetUrl(release.sums, tag, 'SHA256SUMS')
  validateAssetUrl(release.tarball.url, tag, release.tarball.name)
  const sumsResponse = await fetchAsset(release.sums, AbortSignal.timeout(30_000), fetchImpl)
  if (!sumsResponse.ok) throw new UpdateError('download-failed', `SHA256SUMS: ${sumsResponse.status}`)
  const expected = expectedHash(new TextDecoder().decode(await readLimited(sumsResponse, 64 * 1024)), release.tarball.name)
  if (!expected) throw new UpdateError('no-checksum', 'SHA256SUMS does not list the tarball')
  const tarResponse = await fetchAsset(release.tarball.url, AbortSignal.timeout(120_000), fetchImpl)
  if (!tarResponse.ok) throw new UpdateError('download-failed', `tarball: ${tarResponse.status}`)
  const bytes = await readLimited(tarResponse, MAX_TARBALL_BYTES)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new UpdateError('checksum-mismatch', 'the tarball does not match SHA256SUMS')
  validateArchive(bytes, release.version, runtimeVersion)
  if (!/^dsh-remora-[0-9A-Za-z.+-]+\.tgz$/.test(release.tarball.name)) throw new UpdateError('bad-name', 'unexpected tarball name')
  const updatesDir = join(dataDir, 'updates')
  await mkdir(updatesDir, { recursive: true, mode: 0o700 })
  const directory = await lstat(updatesDir)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new UpdateError('unsafe-storage', 'update directory is not an owned directory')
  const path = join(await mkdtemp(join(updatesDir, 'download-')), release.tarball.name)
  await writeAtomic(path, bytes)
  return path
}
