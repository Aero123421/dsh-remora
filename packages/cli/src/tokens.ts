/**
 * Token storage. Uses the OS keychain through OS commands (no native addons):
 *
 * - macOS: `security` (login keychain, generic password)
 * - Linux: `secret-tool` (libsecret / Secret Service) when installed and a D-Bus session exists
 * - Windows: PowerShell DPAPI (`ConvertFrom-SecureString`, current-user scope) into a file in the config dir
 *
 * When none works, falls back to a 0600 file in the config dir and warns once.
 * `REMORA_TOKEN_STORE=file|keychain|auto` (default auto) overrides the choice.
 * Values are base64 encoded so they survive every command's text handling.
 */
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from './ctx.ts'
import { configDir, writePrivate } from './config.ts'

export interface AccessToken { token: string; expiresAt: number | null }

/** Everything kept per hub. Secret: lives only in the token store, never printed. */
export interface StoredTokens {
  hubUrl: string
  clientId: string
  scope: string
  issuer: string
  tokenEndpoint: string
  revocationEndpoint?: string
  /** RFC 8707 resource indicators discovered at login (RFC 9728). Absent = one token for everything. */
  resources: { api?: string; mcp?: string }
  refreshToken: string | null
  /** Access tokens by audience key: `api`, `mcp` or `default`. */
  access: Record<string, AccessToken>
}

export type BackendName = 'macos-keychain' | 'libsecret' | 'windows-dpapi' | 'file'

export interface SecretBackend {
  readonly name: BackendName
  get(account: string): Promise<string | null>
  set(account: string, value: string): Promise<void>
  delete(account: string): Promise<void>
}

const SERVICE = 'remora-cli'
const CLEARED = 'null'

export const BACKEND_LABEL: Readonly<Record<BackendName, string>> = {
  'macos-keychain': 'macOS のキーチェーン',
  'libsecret': 'Secret Service（libsecret）',
  'windows-dpapi': 'Windows DPAPI（現在のユーザーで暗号化したファイル）',
  'file': '設定フォルダーのファイル（権限 0600、暗号化なし）',
}

function fileName(account: string, ext: string): string {
  return `tokens-${createHash('sha256').update(account).digest('hex').slice(0, 16)}.${ext}`
}

export class FileBackend implements SecretBackend {
  readonly name = 'file'
  readonly dir: string
  constructor(dir: string) { this.dir = dir }
  path(account: string): string { return join(this.dir, fileName(account, 'json')) }
  async get(account: string): Promise<string | null> {
    try { return (await readFile(this.path(account), 'utf8')).trim() || null } catch { return null }
  }
  async set(account: string, value: string): Promise<void> { await writePrivate(this.path(account), value) }
  async delete(account: string): Promise<void> { await rm(this.path(account), { force: true }) }
}

export class MacKeychainBackend implements SecretBackend {
  readonly name = 'macos-keychain'
  readonly ctx: Pick<Ctx, 'exec'>
  constructor(ctx: Pick<Ctx, 'exec'>) { this.ctx = ctx }
  async get(account: string): Promise<string | null> {
    const r = await this.ctx.exec('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
    return r.code === 0 ? r.stdout.trim() || null : null
  }
  async set(account: string, value: string): Promise<void> {
    // `security -i` reads the command from stdin so the secret never appears in argv.
    // Account (a URL origin) and value (base64) contain no quotes.
    const r = await this.ctx.exec('security', ['-i'], { input: `add-generic-password -U -s ${SERVICE} -a "${account}" -l "Remora CLI" -w "${value}"\n` })
    if (r.code !== 0) throw new Error(`security: ${r.stderr.trim()}`)
  }
  async delete(account: string): Promise<void> {
    await this.ctx.exec('security', ['delete-generic-password', '-s', SERVICE, '-a', account])
  }
}

export class LibsecretBackend implements SecretBackend {
  readonly name = 'libsecret'
  readonly ctx: Pick<Ctx, 'exec'>
  constructor(ctx: Pick<Ctx, 'exec'>) { this.ctx = ctx }
  async get(account: string): Promise<string | null> {
    const r = await this.ctx.exec('secret-tool', ['lookup', 'service', SERVICE, 'account', account], { timeoutMs: 15_000 })
    return r.code === 0 ? r.stdout.trim() || null : null
  }
  async set(account: string, value: string): Promise<void> {
    const r = await this.ctx.exec('secret-tool', ['store', '--label=Remora CLI', 'service', SERVICE, 'account', account], { input: value, timeoutMs: 15_000 })
    if (r.code !== 0) throw new Error(`secret-tool: ${r.stderr.trim() || `exit ${r.code}`}`)
  }
  async delete(account: string): Promise<void> {
    await this.ctx.exec('secret-tool', ['clear', 'service', SERVICE, 'account', account], { timeoutMs: 15_000 })
  }
}

function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}

const PROTECT = "$ErrorActionPreference='Stop'; $p=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString -String $p -AsPlainText -Force; ConvertFrom-SecureString -SecureString $s"
const UNPROTECT = "$ErrorActionPreference='Stop'; $e=[Console]::In.ReadToEnd().Trim(); $s=ConvertTo-SecureString -String $e; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }"

export class WindowsDpapiBackend implements SecretBackend {
  readonly name = 'windows-dpapi'
  readonly ctx: Pick<Ctx, 'exec'>
  readonly dir: string
  constructor(ctx: Pick<Ctx, 'exec'>, dir: string) { this.ctx = ctx; this.dir = dir }
  path(account: string): string { return join(this.dir, fileName(account, 'dpapi')) }
  async get(account: string): Promise<string | null> {
    let encrypted: string
    try { encrypted = (await readFile(this.path(account), 'utf8')).trim() } catch { return null }
    const r = await this.ctx.exec('powershell.exe', powershellArgs(UNPROTECT), { input: encrypted, timeoutMs: 30_000 })
    return r.code === 0 ? r.stdout.trim() || null : null
  }
  async set(account: string, value: string): Promise<void> {
    const r = await this.ctx.exec('powershell.exe', powershellArgs(PROTECT), { input: value, timeoutMs: 30_000 })
    const encrypted = r.stdout.trim()
    if (r.code !== 0 || !/^[0-9a-f]+$/i.test(encrypted)) throw new Error(`powershell: ${r.stderr.trim() || `exit ${r.code}`}`)
    await writePrivate(this.path(account), encrypted)
  }
  async delete(account: string): Promise<void> { await rm(this.path(account), { force: true }) }
}

export async function hasCommand(ctx: Pick<Ctx, 'exec' | 'platform'>, command: string): Promise<boolean> {
  const r = await ctx.exec(ctx.platform === 'win32' ? 'where' : 'which', [command])
  return r.code === 0
}

/** The keychain backend for this OS, or null when it is not usable here. */
export async function keychainBackend(ctx: Pick<Ctx, 'exec' | 'platform' | 'env'>): Promise<SecretBackend | null> {
  const dir = configDir(ctx.env, ctx.platform)
  if (ctx.platform === 'darwin') return await hasCommand(ctx, 'security') ? new MacKeychainBackend(ctx) : null
  if (ctx.platform === 'win32') return new WindowsDpapiBackend(ctx, dir)
  if (!ctx.env.DBUS_SESSION_BUS_ADDRESS) return null
  return await hasCommand(ctx, 'secret-tool') ? new LibsecretBackend(ctx) : null
}

function encode(tokens: StoredTokens): string { return Buffer.from(JSON.stringify(tokens), 'utf8').toString('base64') }
function decode(value: string): StoredTokens | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as StoredTokens
    return typeof parsed === 'object' && parsed !== null && typeof parsed.hubUrl === 'string' ? parsed : null
  } catch {
    return null
  }
}

export interface TokenStore {
  load(hubUrl: string): Promise<StoredTokens | null>
  /** Saves and returns where the tokens went. */
  save(tokens: StoredTokens): Promise<BackendName>
  clear(hubUrl: string): Promise<void>
  /** Where the last load/save found or put the tokens. */
  readonly location: BackendName | null
}

export class LayeredTokenStore implements TokenStore {
  readonly keychain: SecretBackend | null
  readonly file: FileBackend
  readonly warn: (line: string) => void
  location: BackendName | null = null
  private warned = false
  constructor(keychain: SecretBackend | null, file: FileBackend, warn: (line: string) => void) {
    this.keychain = keychain
    this.file = file
    this.warn = warn
  }

  async load(hubUrl: string): Promise<StoredTokens | null> {
    // A fallback file is the last successful save. The keychain may still
    // contain an older refresh token after a failed write or read-back.
    const value = await this.file.get(hubUrl)
    if (value === CLEARED) { this.location = null; return null }
    const fallback = value ? decode(value) : null
    if (fallback) { this.location = 'file'; return fallback }
    if (this.keychain) {
      const value = await this.keychain.get(hubUrl).catch(() => null)
      const tokens = value ? decode(value) : null
      if (tokens) { this.location = this.keychain.name; return tokens }
    }
    this.location = null
    return null
  }

  async save(tokens: StoredTokens): Promise<BackendName> {
    const value = encode(tokens)
    // Warn when tokens first land in the file, not on every refresh afterwards.
    const previousFile = await this.file.get(tokens.hubUrl)
    if (previousFile !== null && previousFile !== CLEARED) this.warned = true
    if (this.keychain) {
      try {
        await this.keychain.set(tokens.hubUrl, value)
        // Read back: some tools exit 0 without storing anything.
        if (await this.keychain.get(tokens.hubUrl) !== value) throw new Error('read-back mismatch')
        await this.file.delete(tokens.hubUrl)
        this.location = this.keychain.name
        return this.location
      } catch (error) {
        this.fallbackWarning(`${BACKEND_LABEL[this.keychain.name]}に保存できませんでした（${(error as Error).message}）。`)
      }
    } else {
      this.fallbackWarning('OS のキーチェーンが使えません。')
    }
    await this.file.set(tokens.hubUrl, value)
    this.location = 'file'
    return 'file'
  }

  async clear(hubUrl: string): Promise<void> {
    if (this.keychain) await this.keychain.delete(hubUrl).catch(() => {})
    // A locked keychain can refuse deletion. Keep a nonsecret tombstone so
    // an old entry cannot log the user back in when it becomes readable again.
    await this.file.set(hubUrl, CLEARED)
    this.location = null
  }

  private fallbackWarning(reason: string): void {
    if (this.warned) return
    this.warned = true
    this.warn(`警告: ${reason}トークンを ${this.file.dir} のファイル（権限 0600、暗号化なし）に保存します。`)
  }
}

export async function openTokenStore(ctx: Pick<Ctx, 'exec' | 'platform' | 'env' | 'err'>): Promise<LayeredTokenStore> {
  const dir = configDir(ctx.env, ctx.platform)
  const mode = ctx.env.REMORA_TOKEN_STORE ?? 'auto'
  const file = new FileBackend(dir)
  if (mode === 'file') {
    // Chosen explicitly: no warning.
    const store = new LayeredTokenStore(null, file, () => {})
    return store
  }
  const keychain = await keychainBackend(ctx)
  return new LayeredTokenStore(keychain, file, line => ctx.err(line))
}
