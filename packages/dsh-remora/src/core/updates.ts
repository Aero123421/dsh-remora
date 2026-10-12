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
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeAtomic } from './storage.ts'

export const RELEASES_REPO = 'Aero123421/dsh-remora'
export const MAX_TARBALL_BYTES = 20 * 1024 * 1024

export interface ReleaseInfo {
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
}

type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>

function parseVersion(version: string): { core: number[]; pre: string | null } | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim())
  if (!match) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null }
}

/** Semver precedence: >0 when a is newer than b. Unparsable versions compare as equal. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if ((x.core[i] as number) !== (y.core[i] as number)) return (x.core[i] as number) - (y.core[i] as number)
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
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

export async function checkForUpdate(current: string, fetchImpl: FetchLike = fetch, now = Date.now()): Promise<UpdateCheck> {
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `dsh-remora/${current}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 404) return { current, checkedAt: now, latest: null, newer: false }
    if (!response.ok) return { current, checkedAt: now, latest: null, newer: false, error: `github-${response.status}` }
    const body = await response.json() as {
      tag_name?: unknown; name?: unknown; body?: unknown; html_url?: unknown; published_at?: unknown
      assets?: { name?: unknown; browser_download_url?: unknown }[]
    }
    const version = String(body.tag_name ?? '').replace(/^v/, '')
    const assets = Array.isArray(body.assets) ? body.assets : []
    const asset = (match: (name: string) => boolean) => {
      const found = assets.find(item => typeof item.name === 'string' && match(item.name) && typeof item.browser_download_url === 'string')
      return found ? { name: found.name as string, url: found.browser_download_url as string } : null
    }
    const tarball = asset(name => name === `dsh-remora-${version}.tgz`)
    const sums = asset(name => name === 'SHA256SUMS')
    const latest: ReleaseInfo = {
      version,
      name: typeof body.name === 'string' && body.name !== '' ? body.name : `v${version}`,
      notes: typeof body.body === 'string' ? body.body.slice(0, 20_000) : '',
      url: typeof body.html_url === 'string' ? body.html_url : `https://github.com/${RELEASES_REPO}/releases`,
      publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
      tarball,
      sums: sums?.url ?? null,
    }
    return { current, checkedAt: now, latest, newer: compareVersions(version, current) > 0 }
  } catch (error) {
    return { current, checkedAt: now, latest: null, newer: false, error: (error as Error).name === 'TimeoutError' ? 'timeout' : 'network' }
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
  if (declared > limit) throw new UpdateError('too-large', 'the download is too large')
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > limit) throw new UpdateError('too-large', 'the download is too large')
  return buffer
}

/** Find `<hex>  <name>` in a SHA256SUMS file. */
export function expectedHash(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim())
    if (match && match[2] === name) return (match[1] as string).toLowerCase()
  }
  return null
}

/** Download the release tarball, verify it against SHA256SUMS, and store it. Returns the absolute path. */
export async function downloadVerified(release: ReleaseInfo, dataDir: string, fetchImpl: FetchLike = fetch): Promise<string> {
  if (!release.tarball || !release.sums) throw new UpdateError('no-assets', 'the release has no tarball or SHA256SUMS')
  const sumsResponse = await fetchImpl(release.sums, { signal: AbortSignal.timeout(30_000) })
  if (!sumsResponse.ok) throw new UpdateError('download-failed', `SHA256SUMS: ${sumsResponse.status}`)
  const expected = expectedHash(new TextDecoder().decode(await readLimited(sumsResponse, 64 * 1024)), release.tarball.name)
  if (!expected) throw new UpdateError('no-checksum', 'SHA256SUMS does not list the tarball')
  const tarResponse = await fetchImpl(release.tarball.url, { signal: AbortSignal.timeout(120_000) })
  if (!tarResponse.ok) throw new UpdateError('download-failed', `tarball: ${tarResponse.status}`)
  const bytes = await readLimited(tarResponse, MAX_TARBALL_BYTES)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== expected) throw new UpdateError('checksum-mismatch', 'the tarball does not match SHA256SUMS')
  if (!/^dsh-remora-[0-9A-Za-z.+-]+\.tgz$/.test(release.tarball.name)) throw new UpdateError('bad-name', 'unexpected tarball name')
  const path = join(dataDir, 'updates', release.tarball.name)
  await writeAtomic(path, bytes)
  return path
}
