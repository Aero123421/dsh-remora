/**
 * OAuth 2.1 for the CLI as the public client `remora-cli`:
 * authorization code + PKCE (S256) with a loopback redirect, RFC 8628 device
 * authorization for SSH sessions, refresh, and RFC 7009 revocation.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CLI_CLIENT_ID, ENDPOINTS, resourceIndicators } from '@dsh-remora/protocol'
import type { Ctx } from './ctx.ts'
import { isAllowedEndpoint } from './config.ts'
import { CliError, EXIT } from './errors.ts'
import type { AccessToken, StoredTokens } from './tokens.ts'

/**
 * Least privilege by default: list, start, wait and read each task's own final
 * reply. `dsh.content` (transcripts, diffs, deliverables, full questions) is
 * added with `remora login --content`.
 */
export const DEFAULT_SCOPE = 'dsh.read dsh.tasks offline_access'
export const CONTENT_SCOPE = 'dsh.content'

export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  device_authorization_endpoint?: string
  revocation_endpoint?: string
  code_challenge_methods_supported?: string[]
  grant_types_supported?: string[]
  scopes_supported?: string[]
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in?: number
  refresh_token?: string
  scope?: string
}

export function b64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

function network(hubUrl: string, error: unknown): CliError {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  const reason = cause?.code ?? cause?.message ?? (error as Error).message
  return new CliError(`ハブに接続できません（${hubUrl}）: ${reason}`, EXIT.unavailable, { code: 'network' })
}

async function getJson(ctx: Ctx, url: string): Promise<{ status: number; body: unknown }> {
  const response = await ctx.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  let body: unknown = null
  try { body = await response.json() } catch { /* not JSON */ }
  return { status: response.status, body }
}

/** RFC 8414 discovery at `ENDPOINTS.authorizationServerMetadata`, with the issuer checked against the hub. */
export async function discover(ctx: Ctx, hubUrl: string): Promise<AuthServerMetadata> {
  let result
  try {
    result = await getJson(ctx, hubUrl + ENDPOINTS.authorizationServerMetadata)
  } catch (error) {
    throw network(hubUrl, error)
  }
  const meta = result.body as Partial<AuthServerMetadata> | null
  if (result.status !== 200 || !meta || typeof meta !== 'object') {
    throw new CliError(`ハブの OAuth メタデータを取得できません（HTTP ${result.status}）。URL がハブのものか確認してください。`, EXIT.unavailable, { code: 'metadata' })
  }
  if (typeof meta.issuer !== 'string' || meta.issuer.replace(/\/$/, '') !== hubUrl) {
    throw new CliError(`OAuth メタデータの issuer（${String(meta.issuer)}）がハブの URL（${hubUrl}）と一致しません。`, EXIT.failure, { code: 'issuer_mismatch' })
  }
  const authorization = meta.authorization_endpoint ?? hubUrl + ENDPOINTS.authorize
  const token = meta.token_endpoint ?? hubUrl + ENDPOINTS.token
  const revocation = meta.revocation_endpoint ?? hubUrl + ENDPOINTS.revocation
  const endpoints = [authorization, token, meta.device_authorization_endpoint, revocation].filter((e): e is string => typeof e === 'string')
  for (const endpoint of endpoints) {
    if (!isAllowedEndpoint(endpoint)) throw new CliError(`OAuth メタデータのエンドポイントが https ではありません: ${endpoint}`, EXIT.failure, { code: 'metadata' })
  }
  const methods = meta.code_challenge_methods_supported
  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw new CliError('ハブが PKCE（S256）に対応していません。', EXIT.failure, { code: 'metadata' })
  }
  return { ...meta, issuer: meta.issuer, authorization_endpoint: authorization, token_endpoint: token, revocation_endpoint: revocation } as AuthServerMetadata
}

/**
 * Audience-bound tokens (RFC 8707): one for the HTTP API, one for MCP. The
 * hub's RFC 9728 protected resource metadata (path-inserted, e.g.
 * `/.well-known/oauth-protected-resource/mcp`) is the source of truth; the
 * contract's `resourceIndicators()` is the fallback.
 */
export async function discoverResources(ctx: Ctx, hubUrl: string): Promise<Required<StoredTokens['resources']>> {
  const fallback = resourceIndicators(hubUrl)
  const probe = async (expected: string): Promise<string> => {
    try {
      const { status, body } = await getJson(ctx, `${hubUrl}${ENDPOINTS.protectedResourceMetadata}${new URL(expected).pathname}`)
      const resource = (body as { resource?: unknown } | null)?.resource
      return status === 200 && typeof resource === 'string' && isAllowedEndpoint(resource) ? resource : expected
    } catch {
      return expected
    }
  }
  const [api, mcp] = await Promise.all([probe(fallback.api), probe(fallback.mcp)])
  return { api, mcp }
}

export class OAuthError extends Error {
  readonly error: string
  readonly status: number
  constructor(error: string, description: string | undefined, status: number) {
    super(description ? `${error}: ${description}` : error)
    this.error = error
    this.status = status
  }
}

/** POST a form to a token-style endpoint. */
export async function postForm(ctx: Ctx, url: string, form: Record<string, string | readonly string[] | undefined>): Promise<unknown> {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined) continue
    for (const item of typeof value === 'string' ? [value] : value) body.append(key, item)
  }
  let response: Response
  try {
    response = await ctx.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw network(new URL(url).origin, error)
  }
  let json: unknown = null
  const text = await response.text()
  try { json = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!response.ok) {
    const e = json as { error?: unknown; error_description?: unknown } | null
    throw new OAuthError(typeof e?.error === 'string' ? e.error : `http_${response.status}`, typeof e?.error_description === 'string' ? e.error_description : undefined, response.status)
  }
  return json
}

function asTokenResponse(value: unknown): TokenResponse {
  const t = value as Partial<TokenResponse> | null
  if (!t || typeof t.access_token !== 'string' || typeof t.token_type !== 'string' || t.token_type.toLowerCase() !== 'bearer') {
    throw new CliError('ハブのトークン応答が不正です。', EXIT.failure, { code: 'token_response' })
  }
  return t as TokenResponse
}

export function toAccess(ctx: Pick<Ctx, 'now'>, t: TokenResponse): AccessToken {
  return { token: t.access_token, expiresAt: typeof t.expires_in === 'number' ? ctx.now() + t.expires_in * 1000 : null }
}

export interface LoginOptions {
  scope: string
  resources: StoredTokens['resources']
  timeoutMs: number
  openBrowser: boolean
}

const PAGE = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>Remora</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body>`

function resourceList(resources: StoredTokens['resources']): string[] {
  return [resources.api, resources.mcp].filter((r): r is string => typeof r === 'string')
}

/** Authorization code + PKCE with a loopback redirect on a random port. */
export async function loginWithBrowser(ctx: Ctx, meta: AuthServerMetadata, options: LoginOptions): Promise<TokenResponse> {
  const { verifier, challenge } = pkcePair()
  const state = b64url(randomBytes(24))
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void }
  const result = new Promise<string>((resolve, reject) => { settle = { resolve, reject } })
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const send = (status: number, html: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    }
    if (url.pathname !== '/callback') { send(404, PAGE('見つかりません', '')); return }
    // A request without our state is not the answer to our request: ignore it and keep waiting.
    if (url.searchParams.get('state') !== state) { send(400, PAGE('ログインできません', 'state が一致しません。remora login をやり直してください。')); return }
    const iss = url.searchParams.get('iss')
    if (iss !== null && iss.replace(/\/$/, '') !== meta.issuer.replace(/\/$/, '')) {
      send(400, PAGE('ログインできません', '発行元が一致しません。'))
      settle.reject(new CliError('認可応答の発行元（iss）がハブと一致しません。', EXIT.auth, { code: 'issuer_mismatch' }))
      return
    }
    const error = url.searchParams.get('error')
    if (error) {
      send(400, PAGE('ログインできませんでした', 'このタブを閉じて、ターミナルを確認してください。'))
      const description = url.searchParams.get('error_description')
      settle.reject(new CliError(error === 'access_denied' ? 'ログインが拒否されました。' : `ログインできませんでした: ${error}${description ? `（${description}）` : ''}`, EXIT.auth, { code: error }))
      return
    }
    const code = url.searchParams.get('code')
    if (!code) { send(400, PAGE('ログインできません', 'code がありません。')); return }
    send(200, PAGE('ログインしました', 'このタブを閉じて、ターミナルに戻ってください。'))
    settle.resolve(code)
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const url = new URL(meta.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CLI_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', options.scope)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  for (const resource of resourceList(options.resources)) url.searchParams.append('resource', resource)

  let timer: NodeJS.Timeout | undefined
  try {
    ctx.err('次の URL をブラウザで開いてログインしてください:')
    ctx.err(`  ${url.toString()}`)
    if (options.openBrowser) {
      const opened = await ctx.openBrowser(url.toString()).catch(() => false)
      ctx.err(opened ? 'ブラウザを開きました。承認を待っています…' : 'ブラウザを開けませんでした。上の URL を手で開いてください。')
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CliError(`${Math.round(options.timeoutMs / 1000)} 秒以内にログインが終わりませんでした。`, EXIT.timeout, { code: 'timeout', hint: 'ブラウザが使えない環境では remora login --device を使ってください。' })), options.timeoutMs)
    })
    const code = await Promise.race([result, timeout])
    const api = options.resources.api
    try {
      return asTokenResponse(await postForm(ctx, meta.token_endpoint, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: CLI_CLIENT_ID,
        code_verifier: verifier,
        resource: api,
      }))
    } catch (error) {
      if (error instanceof OAuthError) throw new CliError(`トークンを受け取れませんでした: ${error.message}`, EXIT.auth, { code: error.error })
      throw error
    }
  } finally {
    if (timer) clearTimeout(timer)
    server.closeAllConnections()
    server.close()
  }
}

interface DeviceAuthorization {
  device_code: string
  user_code: string
  verification_uri?: string
  verification_uri_complete?: string
  expires_in: number
  interval?: number
}

/** RFC 8628 device authorization grant. */
export async function loginWithDevice(ctx: Ctx, hubUrl: string, meta: AuthServerMetadata, options: Omit<LoginOptions, 'openBrowser'>): Promise<TokenResponse> {
  const endpoint = meta.device_authorization_endpoint ?? hubUrl + ENDPOINTS.deviceAuthorization
  let device: DeviceAuthorization
  try {
    device = await postForm(ctx, endpoint, { client_id: CLI_CLIENT_ID, scope: options.scope, resource: resourceList(options.resources) }) as DeviceAuthorization
  } catch (error) {
    if (error instanceof OAuthError) throw new CliError(`デバイスコードを発行できませんでした: ${error.message}`, error.status === 404 ? EXIT.notAvailable : EXIT.auth, { code: error.error })
    throw error
  }
  if (!device || typeof device.device_code !== 'string' || typeof device.user_code !== 'string') {
    throw new CliError('ハブのデバイスコード応答が不正です。', EXIT.failure, { code: 'device_response' })
  }
  const verify = device.verification_uri && isAllowedEndpoint(device.verification_uri) ? device.verification_uri : hubUrl + ENDPOINTS.deviceVerify
  ctx.err(`別の端末のブラウザで ${verify} を開き、次のコードを入力してください:`)
  ctx.err('')
  ctx.err(`    ${device.user_code}`)
  ctx.err('')
  if (device.verification_uri_complete && isAllowedEndpoint(device.verification_uri_complete)) ctx.err(`（コード入りの URL: ${device.verification_uri_complete}）`)
  ctx.err('承認を待っています…')

  let interval = Math.max(1, device.interval ?? 5) * 1000
  const deadline = ctx.now() + Math.min(device.expires_in * 1000, options.timeoutMs)
  for (;;) {
    await ctx.sleep(interval)
    if (ctx.now() > deadline) throw new CliError('デバイスコードの期限が切れました。remora login --device をやり直してください。', EXIT.timeout, { code: 'expired_token' })
    try {
      return asTokenResponse(await postForm(ctx, meta.token_endpoint, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: CLI_CLIENT_ID,
        resource: options.resources.api,
      }))
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error
      if (error.error === 'authorization_pending') continue
      if (error.error === 'slow_down') { interval += 5000; continue }
      if (error.error === 'access_denied') throw new CliError('ログインが拒否されました。', EXIT.auth, { code: 'access_denied' })
      if (error.error === 'expired_token') throw new CliError('デバイスコードの期限が切れました。remora login --device をやり直してください。', EXIT.timeout, { code: 'expired_token' })
      throw new CliError(`ログインできませんでした: ${error.message}`, EXIT.auth, { code: error.error })
    }
  }
}

/** Exchange the refresh token for a new access token, optionally for one resource. */
export async function refresh(ctx: Ctx, tokens: StoredTokens, resource: string | undefined): Promise<TokenResponse> {
  if (!tokens.refreshToken) throw new CliError('ログインの期限が切れました。', EXIT.auth, { code: 'expired', hint: 'remora login でログインし直してください。' })
  try {
    return asTokenResponse(await postForm(ctx, tokens.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
      resource,
    }))
  } catch (error) {
    if (error instanceof OAuthError && (error.error === 'invalid_grant' || error.status === 401)) {
      throw new CliError('ログインの期限が切れたか、取り消されました。', EXIT.auth, { code: 'invalid_grant', hint: 'remora login でログインし直してください。' })
    }
    throw error
  }
}

/** RFC 7009. Best effort: returns false when the hub has no revocation endpoint or refused. */
export async function revoke(ctx: Ctx, tokens: StoredTokens): Promise<boolean> {
  if (!tokens.revocationEndpoint) return false
  const endpoint = tokens.revocationEndpoint
  const send = async (token: string, hint: string) => {
    try {
      await postForm(ctx, endpoint, { token, token_type_hint: hint, client_id: tokens.clientId })
      return true
    } catch {
      return false
    }
  }
  let ok = true
  if (tokens.refreshToken) ok = await send(tokens.refreshToken, 'refresh_token') && ok
  for (const access of Object.values(tokens.access)) ok = await send(access.token, 'access_token') && ok
  return ok
}
