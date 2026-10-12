/** Authorized access to the hub: access tokens with automatic refresh, and the HTTP API. */
import { ENDPOINTS, findOperation, validateParams, type OperationParams, type OperationResults } from '@dsh-remora/protocol'
import type { Ctx } from './ctx.ts'
import { loadProfile, normalizeHubUrl } from './config.ts'
import { CliError, EXIT, fromHttpError, missingScope, notLoggedIn, usageError } from './errors.ts'
import { refresh, toAccess } from './oauth.ts'
import { openTokenStore, type StoredTokens, type TokenStore } from './tokens.ts'

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

  async token(audience: Audience, forceRefresh = false): Promise<string> {
    if (this.staticToken) return this.staticToken
    if (!this.tokens) throw notLoggedIn()
    const key = this.key(audience)
    const fresh = (t: StoredTokens) => {
      const current = t.access[key]
      return current && (current.expiresAt === null || current.expiresAt - EXPIRY_MARGIN_MS > this.ctx.now()) ? current.token : null
    }
    if (!forceRefresh) {
      const token = fresh(this.tokens)
      if (token) return token
    }
    // Another remora process (e.g. a long-running `remora mcp`) may have
    // refreshed — and rotated the refresh token — since we loaded it.
    if (this.store) {
      const latest = await this.store.load(this.url)
      if (latest && latest.refreshToken !== this.tokens.refreshToken) {
        const used = this.tokens.access[key]?.token
        this.tokens = latest
        const token = fresh(latest)
        if (token && token !== used) return token
      }
    }
    const tokens = this.tokens
    const response = await refresh(this.ctx, tokens, tokens.resources[audience])
    tokens.access[key] = toAccess(this.ctx, response)
    if (response.refresh_token) tokens.refreshToken = response.refresh_token
    if (this.store) await this.store.save(tokens)
    return response.access_token
  }

  /** fetch with the bearer token; on 401 refresh once and retry. */
  async authorizedFetch(audience: Audience, url: string, init: RequestInit): Promise<Response> {
    const attempt = async (force: boolean) => {
      const token = await this.token(audience, force)
      try {
        return await this.ctx.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` } })
      } catch (error) {
        if ((error as Error).name === 'TimeoutError') throw new CliError('ハブの応答がありません（タイムアウト）。', EXIT.unavailable, { code: 'timeout' })
        const cause = (error as { cause?: { code?: string } }).cause
        throw new CliError(`ハブに接続できません（${this.url}）: ${cause?.code ?? (error as Error).message}`, EXIT.unavailable, { code: 'network' })
      }
    }
    let response = await attempt(false)
    if (response.status === 401 && !this.staticToken && this.tokens?.refreshToken) {
      await response.body?.cancel().catch(() => {})
      response = await attempt(true)
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
    if (!response.ok) throw fromHttpError(response.status, body)
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
