import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { Ctx } from './ctx.ts'
import { usageError } from './errors.ts'

/** Where the CLI keeps its settings (hub URL). Tokens go to the OS keychain, falling back to a 0600 file here. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.REMORA_CONFIG_DIR) return env.REMORA_CONFIG_DIR
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'remora')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'remora')
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'remora')
}

/** The saved profile (`config.json`). Never contains secrets. */
export interface Profile {
  hubUrl?: string
  /** Scopes requested at the last login. */
  scope?: string
}

export function profilePath(ctx: Pick<Ctx, 'env' | 'platform'>): string {
  return join(configDir(ctx.env, ctx.platform), 'config.json')
}

export async function loadProfile(ctx: Pick<Ctx, 'env' | 'platform'>): Promise<Profile> {
  try {
    const value = JSON.parse(await readFile(profilePath(ctx), 'utf8')) as unknown
    return typeof value === 'object' && value !== null ? value as Profile : {}
  } catch {
    return {}
  }
}

/** Write a file atomically with owner-only permissions. */
export async function writePrivate(path: string, content: string): Promise<void> {
  const dir = join(path, '..')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, content, { mode: 0o600 })
  await chmod(tmp, 0o600).catch(() => {})
  await rename(tmp, path)
}

export async function saveProfile(ctx: Pick<Ctx, 'env' | 'platform'>, profile: Profile): Promise<void> {
  await writePrivate(profilePath(ctx), `${JSON.stringify(profile, null, 2)}\n`)
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** Accept `https://hub.example.com[/...]` (http only for loopback) and return its origin. */
export function normalizeHubUrl(input: string): string {
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`)
  } catch {
    throw usageError(`ハブの URL が正しくありません: ${input}`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw usageError('ハブの URL は https で指定してください（http はローカルのテスト用ハブだけ使えます）。')
  }
  if (url.username || url.password) throw usageError('ハブの URL に認証情報を含めないでください。')
  return url.origin
}

export function isAllowedEndpoint(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))
  } catch {
    return false
  }
}
