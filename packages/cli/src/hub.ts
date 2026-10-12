/** Authorized access to the hub: access tokens with automatic refresh, and the HTTP API. */
import { ENDPOINTS, findOperation, validateParams, type OperationParams, type OperationResults } from '@dsh-remora/protocol'
import type { Ctx } from './ctx.ts'
import { loadProfile, normalizeHubUrl } from './config.ts'
import { CliError, EXIT, fromHttpError, missingScope, notLoggedIn, usageError } from './errors.ts'
import { refresh, toAccess } from './oauth.ts'
import { openTokenStore, type StoredTokens, type TokenStore } from './tokens.ts'
import { withTokenLock } from './token-lock.ts'

export type Audience = 'api' | 'mcp'
export type OpId = keyof OperationParams & keyof OperationResults

/** Refresh this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000

export async function resolveHubUrl(ctx: Ctx, flag: string | undefined): Promise<string | null> {
  const raw = flag ?? ctx.env.REMORA_HUB_URL ?? (await loadProfile(ctx)).hubUrl
  return raw ? normalizeHubUrl(raw) : null
}

export class Hub {
  readonly ctx: Ctx
  readonly url: string
  readonly store: TokenStore | null
  tokens: StoredTokens | null
  /** A fixed bearer token from `REMORA_TOKEN` (personal token, CI). Never refreshed. */
  readonly staticToken: string | null

  constructor(ctx: Ctx, url: string, store: TokenStore | null, tokens: StoredTokens | null, staticToken: string | null = null) {
    this.ctx = ctx
    this.url = url
    this.store = store
    this.tokens = tokens
    this.staticToken = staticToken
  }

  /** Which slot of `tokens.access` holds the token for an audience. */
  key(audience: Audience): string {
    return this.tokens?.resources[audience] ? audience : 'default'
  }

  async token(audience: Audience, forceRefresh = false, rejectedToken?: string): Promise<string> {
    if (this.staticToken) return this.staticToken
    if (!this.tokens) throw notLoggedIn()
    const used = rejectedToken ?? this.tokens.access[this.key(audience)]?.token
    const fresh = (t: StoredTokens, key: string) => {
      const current = t.access[key]
      return current && (current.expiresAt === null || current.expiresAt - EXPIRY_MARGIN_MS > this.ctx.now()) ? current.token : null
    }
    if (!forceRefresh) {
      const token = fresh(this.tokens, this.key(audience))
      if (token) return token
    }
    return withTokenLock(this.ctx, this.url, async () => {
      // Read only after taking the lock: another process or MCP request may
      // have rotated the refresh token while this request was waiting.
      const tokens = this.store ? await this.store.load(this.url) : this.tokens
      if (!tokens) throw notLoggedIn()
      this.tokens = tokens
      const key = this.key(audience)
      const token = fresh(tokens, key)
      if (token && (!forceRefresh || token !== used)) return token
      const response = await refresh(this.ctx, tokens, tokens.resources[audience])
      const next: StoredTokens = {
        ...tokens,
        access: { ...tokens.access, [key]: toAccess(this.ctx, response) },
        refreshToken: response.refresh_token ?? tokens.refreshToken,
        scope: response.scope ?? tokens.scope,
      }
      if (this.store) await this.store.save(next)
      this.tokens = next
      return response.access_token
    })
  }

  /** fetch with the bearer token; on 401 refresh once and retry. */
  async authorizedFetch(audience: Audience, url: string, init: RequestInit): Promise<Response> {
    const attempt = async (token: string) => {
      try {
        return await this.ctx.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } })
      } catch (error) {
        if ((error as Error).name === 'TimeoutError') throw new CliError('ハブの応答がありません（タイムアウト）。', EXIT.unavailable, { code: 'timeout' })
        const cause = (error as { cause?: { code?: string } }).cause
        throw new CliError(`ハブに接続できません（${this.url}）: ${cause?.code ?? (error as Error).message}`, EXIT.unavailable, { code: 'network' })
      }
    }
    const token = await this.token(audience)
    let response = await attempt(token)
    if (response.status === 401 && !this.staticToken && this.tokens?.refreshToken) {
      await response.body?.cancel().catch(() => {})
      response = await attempt(await this.token(audience, true, token))
    }
    return response
  }

  /** Call an operation through the HTTP API. Parameters are validated locally first. */
  async op<K extends OpId>(operation: K, params: OperationParams[K], timeoutMs = 30_000): Promise<OperationResults[K]> {
    const issues = validateParams(operation, params)
    if (issues.length > 0) throw usageError(`${operation} の入力が不正です: ${issues.map(i => `${i.path} ${i.message}`).join('; ')}`)
    const needed = findOperation(operation)?.scope
    if (needed && this.tokens && !this.tokens.scope.split(/\s+/).includes(needed)) throw missingScope(needed)
    const response = await this.authorizedFetch('api', this.url + ENDPOINTS.ops + operation, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let body: unknown = null
    try { body = text ? JSON.parse(text) : null } catch { /* not JSON */ }
    if (!response.ok) {
      const error = fromHttpError(response.status, body)
      // `hub:/connections` → a link the user can open.
      if (error.detail.fix?.startsWith('hub:/')) error.detail.fix = this.url + error.detail.fix.slice(4)
      throw error
    }
    if (body === null || typeof body !== 'object') throw new CliError('ハブの応答が JSON ではありません。', EXIT.failure, { code: 'bad_response' })
    return body as OperationResults[K]
  }
}

/** Open the hub for a command that needs a login. */
export async function openHub(ctx: Ctx, hubFlag: string | undefined): Promise<Hub> {
  const url = await resolveHubUrl(ctx, hubFlag)
  if (!url) throw notLoggedIn()
  const staticToken = ctx.env.REMORA_TOKEN?.trim()
  if (staticToken) return new Hub(ctx, url, null, null, staticToken)
  const store = await openTokenStore(ctx)
  const tokens = await store.load(url)
  if (!tokens) throw notLoggedIn(`remora login ${url} でログインしてください。`)
  return new Hub(ctx, url, store, tokens)
}
