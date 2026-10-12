/**
 * `remora self-update`: fetch the latest (or a given) GitHub release, verify
 * the asset for this install against `SHA256SUMS`, and replace it atomically.
 *
 * Two install forms:
 * - `script`: `remora.mjs` run by Node.js 22.19+ through a launcher (the
 *   primary form; `RELEASE_ASSETS.cliScript`);
 * - `binary`: the standalone executable for this OS/arch (`RELEASE_ASSETS.cli`).
 *
 * On Windows a running file cannot be overwritten but can be renamed, so it is
 * moved aside to `<file>.old` first and removed on a later start.
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { RELEASE_ASSETS } from '@dsh-remora/protocol'
import type { Ctx } from './ctx.ts'
import { CliError, EXIT } from './errors.ts'

export const REPOSITORY = 'Aero123421/dsh-remora'
export const DEFAULT_RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases`

export type InstallForm = 'script' | 'binary'

export function assetName(platform: string, arch: string, form: InstallForm = 'binary'): string {
  return form === 'script' ? RELEASE_ASSETS.cliScript : RELEASE_ASSETS.cli(platform, arch)
}

/** A `remora.mjs` inside a source checkout (`packages/cli/dist`) is updated with git, not here. */
export function isDevCheckout(scriptPath: string): boolean {
  return /[\\/]packages[\\/]cli[\\/]dist[\\/][^\\/]+$/.test(scriptPath)
}

/** Which form is running, and the file that holds it. */
export function installOf(ctx: Pick<Ctx, 'isSea' | 'execPath' | 'scriptPath'>): { form: InstallForm; path: string | null } {
  if (ctx.isSea) return { form: 'binary', path: ctx.execPath }
  const script = ctx.scriptPath
  return { form: 'script', path: script && /\.mjs$/i.test(script) && !isDevCheckout(script) ? script : null }
}

interface ReleaseAsset { name: string; browser_download_url: string; size?: number }
export interface Release { tag_name: string; name?: string; html_url?: string; assets: ReleaseAsset[] }

function headers(ctx: Ctx): Record<string, string> {
  const h: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'remora-cli', 'x-github-api-version': '2022-11-28' }
  const token = ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN
  if (token) h.authorization = `Bearer ${token}`
  return h
}

async function get(ctx: Ctx, url: string, accept?: string): Promise<Response> {
  let response: Response
  try {
    response = await ctx.fetch(url, { headers: { ...headers(ctx), ...(accept ? { accept } : {}) }, redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) })
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause
    throw new CliError(`ダウンロードできません（${new URL(url).host}）: ${cause?.code ?? (error as Error).message}`, EXIT.unavailable, { code: 'network', hint: 'プロキシの内側では NODE_USE_ENV_PROXY=1 と HTTPS_PROXY を設定してください。' })
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new CliError(`取得できませんでした（HTTP ${response.status}）: ${url}`, response.status === 404 ? EXIT.notFound : EXIT.unavailable, { code: 'http_error', status: response.status })
  }
  return response
}

export async function fetchRelease(ctx: Ctx, version: string | undefined): Promise<Release> {
  const api = (ctx.env.REMORA_RELEASES_API ?? DEFAULT_RELEASES_API).replace(/\/$/, '')
  const tag = version ? (version.startsWith('v') ? version : `v${version}`) : undefined
  let response: Response
  try {
    response = await get(ctx, tag ? `${api}/tags/${encodeURIComponent(tag)}` : `${api}/latest`)
  } catch (error) {
    if (error instanceof CliError && error.detail.status === 404) {
      throw new CliError(tag ? `リリース ${tag} が見つかりません。` : `${REPOSITORY} のリリースが見つかりません（まだ公開されていない可能性があります）。`, EXIT.notFound, { code: 'no_release' })
    }
    throw error
  }
  const release = await response.json() as Release
  if (!release || typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) throw new CliError('リリース情報が不正です。', EXIT.failure)
  return release
}

/** Parse `sha256sum` output: `<hex>  <name>` or `<hex> *<name>`. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (m) sums.set(basename(m[2] as string), (m[1] as string).toLowerCase())
  }
  return sums
}

export function versionOf(tag: string): string {
  return tag.replace(/^v/, '')
}

/** Download `url` to `path` while hashing; returns the hex digest. */
async function download(ctx: Ctx, url: string, path: string): Promise<string> {
  const response = await get(ctx, url, 'application/octet-stream')
  if (!response.body) throw new CliError('ダウンロードが空でした。', EXIT.failure)
  const hash = createHash('sha256')
  const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
  source.on('data', (chunk: Buffer) => hash.update(chunk))
  await pipeline(source, createWriteStream(path, { mode: 0o755 }))
  return hash.digest('hex')
}

/** Put `fresh` where `target` is. Atomic rename on POSIX; move-aside on Windows. */
export async function replaceBinary(target: string, fresh: string, platform: NodeJS.Platform): Promise<void> {
  if (platform !== 'win32') {
    await rename(fresh, target)
    return
  }
  const old = `${target}.old`
  await rm(old, { force: true }).catch(() => {})
  await rename(target, old)
  try {
    await rename(fresh, target)
  } catch (error) {
    await rename(old, target).catch(() => {})
    throw error
  }
  // Fails while the old binary is still running; cleanupOldBinary removes it next time.
  await rm(old, { force: true }).catch(() => {})
}

/** Remove a `<exe>.old` left by a Windows self-update. Best effort. */
export async function cleanupOldBinary(execPath: string): Promise<void> {
  await rm(`${execPath}.old`, { force: true }).catch(() => {})
}

export interface UpdateOutcome {
  current: string
  latest: string
  form: InstallForm
  asset: string
  updated: boolean
  target?: string
  sha256?: string
}

export interface UpdateOptions {
  version?: string
  check: boolean
  force: boolean
  /** Override the file to replace (tests, unusual installs). Defaults to the running binary or script; a `.mjs` target means the script form. */
  target?: string
  currentVersion: string
}

export async function selfUpdate(ctx: Ctx, options: UpdateOptions): Promise<UpdateOutcome> {
  const running = installOf(ctx)
  const form: InstallForm = options.target ? (/\.mjs$/i.test(options.target) ? 'script' : 'binary') : running.form
  const release = await fetchRelease(ctx, options.version)
  const latest = versionOf(release.tag_name)
  const name = assetName(ctx.platform, ctx.arch, form)
  const outcome: UpdateOutcome = { current: options.currentVersion, latest, form, asset: name, updated: false }
  if (options.check) return outcome
  if (latest === options.currentVersion && !options.force) return outcome
  const asset = release.assets.find(a => a.name === name)
  if (!asset) {
    const hint = form === 'script' ? '古いリリースには remora.mjs がありません。単体実行ファイル版を入れ直すか、--version で新しい版を指定してください。' : undefined
    throw new CliError(`このリリース（${release.tag_name}）には ${name} がありません。`, EXIT.notFound, { code: 'no_asset', ...(hint ? { hint } : {}) })
  }
  const sumsAsset = release.assets.find(a => a.name === RELEASE_ASSETS.checksums)
  if (!sumsAsset) throw new CliError(`このリリース（${release.tag_name}）には ${RELEASE_ASSETS.checksums} がないため、検証できません。`, EXIT.failure, { code: 'no_checksums' })

  const target = options.target ?? running.path
  if (!target) {
    throw new CliError('インストールされた remora として動いていないため、自己更新できません（ソースから使っている場合は git pull と pnpm build）。', EXIT.usage, { code: 'not_installed' })
  }
  await stat(target).catch(() => { throw new CliError(`置き換えるファイルが見つかりません: ${target}`, EXIT.failure) })

  const sums = parseSums(await (await get(ctx, sumsAsset.browser_download_url, 'application/octet-stream')).text())
  const expected = sums.get(name)
  if (!expected) throw new CliError(`${RELEASE_ASSETS.checksums} に ${name} の行がありません。`, EXIT.failure, { code: 'no_checksum' })

  const fresh = join(dirname(target), `.${basename(target)}.${process.pid}.download`)
  try {
    const actual = await download(ctx, asset.browser_download_url, fresh)
    if (actual !== expected) throw new CliError(`ダウンロードしたファイルのハッシュが ${RELEASE_ASSETS.checksums} と一致しません（期待 ${expected}、実際 ${actual}）。更新を中止しました。`, EXIT.failure, { code: 'checksum_mismatch' })
    await chmod(fresh, 0o755)
    await replaceBinary(target, fresh, ctx.platform)
  } finally {
    await rm(fresh, { force: true }).catch(() => {})
  }
  return { ...outcome, updated: true, target, sha256: expected }
}
