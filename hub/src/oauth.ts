/**
 * OAuth 2.1 for ChatGPT, Claude, the CLI and other clients, built on
 * `@cloudflare/workers-oauth-provider`'s role API:
 *
 * - one authorization server (issuer = hub origin) with two resources and
 *   separate audiences: `<origin>/mcp` and `<origin>/api/v1/ops`;
 * - CIMD on, advertised for Claude (`client_id_metadata_document_supported`
 *   plus `none` token auth), with a known-client allowlist by default;
 * - DCR off unless `ENABLE_DCR=true`, and then rate-limited;
 * - the CLI as the pre-registered public client `remora-cli`;
 * - RFC 8628 device authorization implemented here: the owner's approval
 *   runs the library's `completeAuthorization()` with a hub-held PKCE pair,
 *   and the device's poll redeems that code at the library's own token
 *   endpoint, so every token is issued, stored and validated by the library.
 */
import {
  AuthorizationError, CimdFetchError, OAuthAuthorizationServer, OAuthResourceServer,
  type AuthRequest, type OAuthHelpers, type OAuthResourceAuth,
} from '@cloudflare/workers-oauth-provider'
import { getSession } from './auth.ts'
import { ACCESS_TOKEN_TTL_S, RATE_LIMITS, REFRESH_TOKEN_IDLE_TTL_S, REFRESH_TOKEN_TTL_S, dcrEnabled, hubOrigin } from './config.ts'
import { bodyText, clientIp, html, json, readForm, redirect, sameOrigin } from './http.ts'
import { countingKv, hubStub } from './meter.ts'
import type { ClientKind } from './types.ts'
import { flash, h, page, raw, type Raw } from './ui/layout.ts'
import { randomToken } from './util.ts'
import { CLI_CLIENT_ID, ENDPOINTS, SCOPES, resourceIndicators, formatUserCode, normalizeUserCode, sha256, toBase64Url } from './vendor/protocol/index.ts'

export interface TokenProps {
  clientId: string
  clientName: string
}

/** What a protected handler learns about its caller. */
export interface ApiCaller {
  props: TokenProps
  auth: OAuthResourceAuth
}

export type ProtectedHandler = (request: Request, env: Env, ctx: ExecutionContext, caller: ApiCaller) => Promise<Response>

export const OFFLINE_ACCESS = 'offline_access'
export const DEFAULT_SCOPES = ['dsh.read', 'dsh.content', 'dsh.tasks']
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
/** The CLI's registered redirect; any loopback port matches (RFC 8252 §7.3). The device flow reuses it without redirecting. */
export const CLI_REDIRECT_URIS = ['http://127.0.0.1/callback', 'http://localhost/callback']

export interface KnownClient {
  name: string
  matches(clientId: string, redirectUri: string): boolean
}

const CLAUDE_HOSTED_CALLBACKS = new Set(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'])

/**
 * Clients allowed by default. Sources (checked 2026-10-12):
 * - ChatGPT: CIMD client id `https://chatgpt.com/oauth/client.json` (OpenAI Apps SDK auth docs).
 * - Claude Code: CIMD client id `https://claude.ai/oauth/claude-code-client-metadata`
 *   (claude.com/docs/connectors/building/authentication, "Callback URLs").
 * - Claude (web, Desktop, mobile, Cowork): Anthropic hosts a CIMD document on claude.ai but
 *   does not publish its exact URL; the callback is `https://claude.ai/api/mcp/auth_callback`.
 *   We accept any https client id on claude.ai whose redirect is that callback (or the
 *   claude.com variant). The redirect check is what matters: tokens can only go there.
 */
export const KNOWN_CLIENTS: readonly KnownClient[] = [
  { name: 'ChatGPT', matches: clientId => clientId === 'https://chatgpt.com/oauth/client.json' },
  { name: 'Claude Code', matches: clientId => clientId === 'https://claude.ai/oauth/claude-code-client-metadata' },
  {
    name: 'Claude',
    matches: (clientId, redirectUri) => {
      try {
        return new URL(clientId).hostname === 'claude.ai' && CLAUDE_HOSTED_CALLBACKS.has(redirectUri)
      } catch {
        return false
      }
    },
  },
]

export function isCimdClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' && url.pathname !== '/' && url.pathname !== ''
  } catch {
    return false
  }
}

export function clientKind(clientId: string): ClientKind {
  if (clientId === CLI_CLIENT_ID) return 'cli'
  return isCimdClientId(clientId) ? 'cimd' : 'dcr'
}

export function knownClientName(clientId: string, redirectUri: string): string | null {
  return KNOWN_CLIENTS.find(client => client.matches(clientId, redirectUri))?.name ?? null
}

/** The hub's policy on who may even reach the consent page. */
export function clientPolicy(clientId: string, redirectUri: string, settings: { allowOtherClients: boolean; dcr: boolean }): { allowed: true } | { allowed: false; reason: 'not-allowlisted' | 'dcr-disabled' } {
  const kind = clientKind(clientId)
  if (kind === 'cli') return { allowed: true }
  if (kind === 'cimd') return knownClientName(clientId, redirectUri) !== null || settings.allowOtherClients ? { allowed: true } : { allowed: false, reason: 'not-allowlisted' }
  return settings.dcr ? { allowed: true } : { allowed: false, reason: 'dcr-disabled' }
}

// --- construction (per origin) ---------------------------------------------------

interface OAuthSetup {
  server: OAuthAuthorizationServer<Env>
  mcp: OAuthResourceServer<Env, TokenProps>
  api: OAuthResourceServer<Env, TokenProps>
  mcpResource: string
  apiResource: string
}

const setups = new Map<string, OAuthSetup>()
let protectedHandlers: { mcp: ProtectedHandler; api: ProtectedHandler } | null = null

/** Called once by index.ts so this module does not import the MCP and REST handlers. */
export function registerProtectedHandlers(handlers: { mcp: ProtectedHandler; api: ProtectedHandler }): void {
  protectedHandlers = handlers
}

/** The env the library sees: its KV writes are counted for the free-tier meter. */
export function oauthEnv(env: Env): Env {
  return { ...env, OAUTH_KV: countingKv(env.OAUTH_KV) }
}

export function resourcesFor(origin: string): { mcp: string; api: string } {
  return resourceIndicators(origin)
}

export function oauthFor(origin: string, env: Env): OAuthSetup {
  const dcr = dcrEnabled(env)
  const key = `${origin}|${dcr}`
  const cached = setups.get(key)
  if (cached) return cached
  const resources = resourcesFor(origin)
  const server = new OAuthAuthorizationServer<Env>({
    issuer: origin,
    authorizeEndpoint: ENDPOINTS.authorize,
    tokenEndpoint: ENDPOINTS.token,
    resources: [resources.mcp, resources.api],
    // Clients that omit `resource` are MCP clients in practice.
    defaultResource: resources.mcp,
    scopesSupported: [...SCOPES, OFFLINE_ACCESS],
    clientIdMetadataDocumentEnabled: true,
    ...(dcr ? { clientRegistrationEndpoint: '/oauth/register' } : {}),
    clientRegistrationCallback: async ({ request }) => {
      const [max, window] = RATE_LIMITS.dcr
      if (!(await hubStub(env).hit(`dcr:${clientIp(request)}`, max, window))) return { code: 'access_denied', description: 'Too many registrations; try again later.', status: 429 }
      return undefined
    },
    accessTokenTTL: ACCESS_TOKEN_TTL_S,
    refreshTokenTTL: REFRESH_TOKEN_TTL_S,
    refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_S,
    onError: ({ code, internal }) => {
      console.warn('oauth error', code, internal?.category, internal?.reason)
    },
  })
  const viaServer = (env: Env) => (resource: string, token: string) => server.validateToken<TokenProps>(resource, token, oauthEnv(env))
  const handlerFor = (name: 'mcp' | 'api') => ({
    fetch(request: Request, env: Env, ctx: ExecutionContext & { props: TokenProps; auth: OAuthResourceAuth }) {
      if (!protectedHandlers) throw new Error('protected handlers are not registered')
      return protectedHandlers[name](request, env, ctx, { props: ctx.props, auth: ctx.auth })
    },
  })
  const mcp = new OAuthResourceServer<Env, TokenProps>({
    resourceMetadata: { resource: resources.mcp, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: 'Remora (DSH remote control)' },
    requiredScopes: DEFAULT_SCOPES,
    validateToken: viaServer,
    handler: handlerFor('mcp'),
  })
  const api = new OAuthResourceServer<Env, TokenProps>({
    resourceMetadata: { resource: resources.api, authorization_servers: [origin], bearer_methods_supported: ['header'], resource_name: 'Remora HTTP API' },
    requiredScopes: DEFAULT_SCOPES,
    // Personal tokens issued on the hub are accepted here (not at /mcp), next to OAuth tokens.
    validateToken: env => async (resource, token) => {
      if (token.startsWith('rmr_pat_')) {
        const pat = await hubStub(env).validatePersonalToken(token)
        if (!pat) return null
        return { props: { clientId: `pat:${pat.id}`, clientName: `個人トークン: ${pat.name}` }, audience: resource, scope: pat.scopes, expiresAt: Math.floor(pat.expiresAt / 1000), clientId: `pat:${pat.id}`, userId: 'owner' }
      }
      return viaServer(env)(resource, token)
    },
    handler: handlerFor('api'),
  })
  const setup = { server, mcp, api, mcpResource: resources.mcp, apiResource: resources.api }
  setups.set(key, setup)
  return setup
}

// --- the CLI client --------------------------------------------------------------------

let cliRegistered = false

/**
 * `createClient()` mints random ids, so the fixed public client `remora-cli`
 * is written in the library's KV client-record format (the same fields
 * `createClient()` stores for a public client).
 */
export async function ensureCliClient(env: Env): Promise<void> {
  if (cliRegistered) return
  const key = `client:${CLI_CLIENT_ID}`
  if (!(await env.OAUTH_KV.get(key))) {
    await countingKv(env.OAUTH_KV).put(key, JSON.stringify({
      clientId: CLI_CLIENT_ID,
      redirectUris: CLI_REDIRECT_URIS,
      clientName: 'Remora CLI',
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      registrationDate: Math.floor(Date.now() / 1000),
      tokenEndpointAuthMethod: 'none',
      authMethodExplicit: true,
    }))
  }
  cliRegistered = true
}

// --- routing -----------------------------------------------------------------------------

/** Handles /oauth/*, /.well-known/oauth-*, and the /device page. Returns null for other paths. */
export async function handleOAuth(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url)
  const origin = hubOrigin(request, env)
  const setup = oauthFor(origin, env)
  const libEnv = oauthEnv(env)
  const path = url.pathname

  if (path === ENDPOINTS.authorizationServerMetadata) {
    const response = await setup.server.fetch(request, libEnv, ctx)
    if (!response.ok) return response
    const metadata = (await response.json()) as Record<string, unknown>
    metadata.device_authorization_endpoint = `${origin}${ENDPOINTS.deviceAuthorization}`
    metadata.revocation_endpoint = `${origin}${ENDPOINTS.revocation}`
    const grants = Array.isArray(metadata.grant_types_supported) ? (metadata.grant_types_supported as string[]) : []
    metadata.grant_types_supported = [...new Set([...grants, DEVICE_GRANT])]
    return json(metadata, { headers: { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' } })
  }
  if (path === ENDPOINTS.protectedResourceMetadata) {
    // Clients that probe the origin-level document get the MCP resource's.
    const rewritten = new Request(`${origin}${ENDPOINTS.protectedResourceMetadata}${ENDPOINTS.mcp}`, request)
    return setup.mcp.fetch(rewritten, env, ctx)
  }
  if (path === `${ENDPOINTS.protectedResourceMetadata}${ENDPOINTS.mcp}`) return setup.mcp.fetch(request, env, ctx)
  if (path.startsWith(`${ENDPOINTS.protectedResourceMetadata}/api/`)) return setup.api.fetch(request, env, ctx)

  if (path === ENDPOINTS.authorize) return request.method === 'POST' ? authorizePost(request, env, setup) : authorizeGet(request, env, setup)
  if (path === ENDPOINTS.deviceAuthorization) return deviceAuthorization(request, env, setup)
  if (path === ENDPOINTS.deviceVerify) return request.method === 'POST' ? devicePost(request, env, setup) : deviceGet(request, env)

  if (path === ENDPOINTS.revocation) return revoke(request, env, ctx, setup, origin)
  if (path === ENDPOINTS.token && request.method === 'POST') {
    const [max, window] = RATE_LIMITS.token
    if (!(await hubStub(env).hit(`token:${clientIp(request)}`, max, window))) return json({ error: 'slow_down', error_description: 'Too many token requests.' }, { status: 429 })
    const form = new URLSearchParams(await bodyText(request.clone()))
    if (form.get('client_id') === CLI_CLIENT_ID) await ensureCliClient(env)
    if (form.get('grant_type') === DEVICE_GRANT) return deviceToken(form, env, ctx, setup, origin)
    return setup.server.fetch(request, libEnv, ctx)
  }
  if (path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-')) return setup.server.fetch(request, libEnv, ctx)
  return null
}

/**
 * RFC 7009 revocation. The library serves revocation on its token endpoint
 * (a request with `token` and no `grant_type`), so the body is forwarded there
 * unchanged; client authentication and the always-200 answer are the library's.
 */
async function revoke(request: Request, env: Env, ctx: ExecutionContext, setup: OAuthSetup, origin: string): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
  const [max, window] = RATE_LIMITS.token
  if (!(await hubStub(env).hit(`token:${clientIp(request)}`, max, window))) return json({ error: 'slow_down', error_description: 'Too many requests.' }, { status: 429 })
  const body = await bodyText(request)
  const form = new URLSearchParams(body)
  if (form.has('grant_type') || !form.get('token')) return json({ error: 'invalid_request', error_description: 'Send token (and token_type_hint) without grant_type.' }, { status: 400 })
  if (form.get('client_id') === CLI_CLIENT_ID) await ensureCliClient(env)
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' })
  const authorization = request.headers.get('authorization')
  if (authorization) headers.set('authorization', authorization)
  return setup.server.fetch(new Request(`${origin}${ENDPOINTS.token}`, { method: 'POST', headers, body }), oauthEnv(env), ctx)
}

function oauthApi(setup: OAuthSetup, env: Env): OAuthHelpers {
  return setup.server.getOAuthApi(oauthEnv(env))
}

function errorPage(title: string, message: string, status = 400): Response {
  return html(page({ title, narrow: true, body: h`<h1>${title}</h1><p class="lead">${message}</p><p><a class="button" href="/">ホームへ</a></p>` }), { status })
}

const SCOPE_LABEL: Readonly<Record<string, string>> = {
  'dsh.read': '一覧と状態を見る（ホスト、ワークスペース、セッション、要対応）',
  'dsh.content': '会話の本文・差分・成果物を読む',
  'dsh.tasks': 'タスクを依頼する・追加指示・取り消し・質問への回答',
  'dsh.admin': '危険な操作（リモート全権でのみ、パスキー確認つき）',
  offline_access: 'ログインを保つ（更新トークン）',
}

function scopeChoices(requested: string[]): Raw {
  const asked = requested.filter(scope => (SCOPES as readonly string[]).includes(scope))
  const defaults = asked.length > 0 ? asked : DEFAULT_SCOPES
  return h`<fieldset class="scopes"><legend>許可する範囲</legend>
${SCOPES.map(scope => h`<label class="check"><input type="checkbox" name="scope" value="${scope}"${raw(defaults.includes(scope) ? ' checked' : '')}> <span><code>${scope}</code> ${SCOPE_LABEL[scope] ?? ''}</span></label>`)}
${requested.includes(OFFLINE_ACCESS) ? h`<input type="hidden" name="scope" value="${OFFLINE_ACCESS}"><p class="muted">${SCOPE_LABEL[OFFLINE_ACCESS] ?? ''}</p>` : ''}
</fieldset>`
}

async function authorizeGet(request: Request, env: Env, setup: OAuthSetup): Promise<Response> {
  const url = new URL(request.url)
  if (url.searchParams.get('client_id') === CLI_CLIENT_ID) await ensureCliClient(env)
  const oauth = oauthApi(setup, env)
  let authRequest: AuthRequest
  try {
    authRequest = await oauth.parseAuthRequest(request)
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (error.redirectTo) return redirect(error.redirectTo, {}, 302)
      return errorPage('接続できません', `認可リクエストが正しくありません: ${error.description}`)
    }
    if (error instanceof CimdFetchError) return errorPage('接続できません', 'クライアントのメタデータ文書を取得できませんでした。')
    throw error
  }
  const hub = hubStub(env)
  const state = await hub.state()
  const policy = clientPolicy(authRequest.clientId, authRequest.redirectUri, { allowOtherClients: state.allowOtherClients, dcr: dcrEnabled(env) })
  if (!policy.allowed) {
    return errorPage('このクライアントは許可されていません', policy.reason === 'dcr-disabled'
      ? '動的クライアント登録（DCR）はこのハブでは無効です。'
      : '既知のクライアント（ChatGPT、Claude、Claude Code、Remora CLI）以外は既定で拒否します。必要なら設定で「その他のクライアントを許可」をオンにしてください。', 403)
  }
  const session = await getSession(request, env)
  if (!session) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`)
  const details = await oauth.describeConsent(authRequest)
  const known = knownClientName(authRequest.clientId, authRequest.redirectUri)
  const consent = await oauth.beginConsent(authRequest)
  const body = h`<h1>接続を許可しますか</h1>
<div class="consent">
  <p class="client-name">${known ?? details.clientName}</p>
  ${details.clientDomain
    ? h`<p>発行元: <strong class="big">${details.clientDomain}</strong>${known ? h` <span class="badge ok">既知のクライアント</span>` : h` <span class="badge warn">許可リスト外</span>`}</p>`
    : h`<p>${authRequest.clientId === CLI_CLIENT_ID ? 'Remora CLI（ハブに組み込みのクライアント）' : '自己申告の名前です（ドメインは確認できません）。'}</p>`}
  <p>トークンの送り先: <strong class="big">${details.redirectHost}</strong></p>
  ${details.redirectIsLoopback ? h`<p class="flash error">送り先はこのパソコン上のアプリです。今ちょうど自分でログインを始めたときだけ許可してください。</p>` : ''}
  <p class="muted">新しいクライアントは、どのホストでも「見るだけ」から始まります。依頼まで許すには、許可したあと「接続」画面で広げてください。</p>
</div>
<form method="post" action="${ENDPOINTS.authorize}" data-reauth>
  <input type="hidden" name="handle" value="${consent.handle}">
  ${scopeChoices(authRequest.scope)}
  <div class="actions">
    <button class="primary" type="submit" name="decision" value="approve">パスキーで確認して許可</button>
    <button type="submit" name="decision" value="deny" data-no-reauth>拒否</button>
  </div>
</form>`
  const headers = consent.headers
  return html(page({ title: '接続の許可', narrow: true, body, scripts: ['/js/webauthn.js'] }), { headers })
}

async function authorizePost(request: Request, env: Env, setup: OAuthSetup): Promise<Response> {
  const origin = hubOrigin(request, env)
  if (!sameOrigin(request, origin)) return errorPage('拒否しました', '別のサイトからの送信は受け付けません。', 403)
  const session = await getSession(request, env)
  if (!session) return errorPage('ログインが必要です', 'もう一度接続をやり直してください。', 403)
  const form = await readForm(request.clone())
  const handle = form.get('handle') ?? ''
  const oauth = oauthApi(setup, env)
  try {
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle)
      return new Response(null, { status: 302, headers: denied.headers })
    }
    if (!session.fresh) return errorPage('パスキーでの確認が必要です', '許可するには、ボタンを押してパスキーで確認してください。', 403)
    const scopes = form.getAll('scope').filter(scope => (SCOPES as readonly string[]).includes(scope) || scope === OFFLINE_ACCESS)
    const approved = await oauth.approveConsent(request, handle, { scope: scopes })
    const state = await hubStub(env).state()
    const policy = clientPolicy(approved.request.clientId, approved.request.redirectUri, { allowOtherClients: state.allowOtherClients, dcr: dcrEnabled(env) })
    if (!policy.allowed) return errorPage('このクライアントは許可されていません', '許可リストが変わりました。', 403)
    const details = await oauth.describeConsent(approved.request)
    const name = knownClientName(approved.request.clientId, approved.request.redirectUri) ?? details.clientName
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: 'owner',
      metadata: { clientName: name },
      scope: approved.request.scope,
      props: { clientId: approved.request.clientId, clientName: name } satisfies TokenProps,
      // Signing the CLI in on one machine must not sign it out on the others.
      revokeExistingGrants: clientKind(approved.request.clientId) !== 'cli',
    })
    await hubStub(env).upsertClient({ clientId: approved.request.clientId, name, kind: clientKind(approved.request.clientId), domain: details.clientDomain ?? null, redirectHost: details.redirectHost })
    approved.headers.set('location', redirectTo)
    return new Response(null, { status: 302, headers: approved.headers })
  } catch (error) {
    if (error instanceof AuthorizationError) return errorPage('接続できません', `認可を完了できませんでした: ${error.description}`)
    throw error
  }
}

// --- device authorization (RFC 8628) ------------------------------------------------------

async function deviceAuthorization(request: Request, env: Env, setup: OAuthSetup): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
  const [max, window] = RATE_LIMITS.deviceAuthorization
  if (!(await hubStub(env).hit(`device:${clientIp(request)}`, max, window))) return json({ error: 'slow_down', error_description: 'Too many requests.' }, { status: 429 })
  const form = await readForm(request)
  if (form.get('client_id') !== CLI_CLIENT_ID) return json({ error: 'invalid_client', error_description: 'Only the Remora CLI may use the device flow.' }, { status: 401 })
  await ensureCliClient(env)
  const requested = (form.get('scope') ?? '').split(/\s+/).filter(Boolean)
  const scope = requested.filter(item => (SCOPES as readonly string[]).includes(item) || item === OFFLINE_ACCESS)
  const resource = form.get('resource') ?? setup.apiResource
  if (resource !== setup.apiResource && resource !== setup.mcpResource) return json({ error: 'invalid_target', error_description: 'Unknown resource.' }, { status: 400 })
  const started = await hubStub(env).deviceStart({ clientId: CLI_CLIENT_ID, scope: scope.length > 0 ? scope : [...DEFAULT_SCOPES, OFFLINE_ACCESS], resource })
  const origin = new URL(setup.mcpResource).origin
  const userCode = formatUserCode(started.userCode)
  return json({
    device_code: started.deviceCode,
    user_code: userCode,
    verification_uri: `${origin}${ENDPOINTS.deviceVerify}`,
    verification_uri_complete: `${origin}${ENDPOINTS.deviceVerify}?code=${encodeURIComponent(userCode)}`,
    expires_in: Math.round((started.expiresAt - Date.now()) / 1000),
    interval: started.interval,
  })
}

async function deviceToken(form: URLSearchParams, env: Env, ctx: ExecutionContext, setup: OAuthSetup, origin: string): Promise<Response> {
  const deviceCode = form.get('device_code')
  const clientId = form.get('client_id')
  if (!deviceCode || clientId !== CLI_CLIENT_ID) return json({ error: 'invalid_request', error_description: 'device_code and client_id are required.' }, { status: 400 })
  const poll = await hubStub(env).devicePoll(deviceCode, clientId)
  switch (poll.status) {
    case 'pending': return json({ error: 'authorization_pending' }, { status: 400 })
    case 'slow_down': return json({ error: 'slow_down' }, { status: 400 })
    case 'denied': return json({ error: 'access_denied' }, { status: 400 })
    case 'expired': return json({ error: 'expired_token' }, { status: 400 })
    case 'invalid': return json({ error: 'invalid_grant' }, { status: 400 })
  }
  // Redeem the code minted at approval through the library's own token endpoint.
  const exchange = new Request(`${origin}${ENDPOINTS.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: poll.authCode,
      redirect_uri: poll.redirectUri,
      client_id: poll.clientId,
      code_verifier: poll.codeVerifier,
      resource: poll.resource,
    }).toString(),
  })
  return setup.server.fetch(exchange, oauthEnv(env), ctx)
}

async function deviceGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const session = await getSession(request, env)
  if (!session) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`)
  const code = normalizeUserCode(url.searchParams.get('code') ?? '')
  const info = code ? await hubStub(env).deviceLookup(code) : null
  const status = url.searchParams.get('done')
  let body: Raw
  if (status === 'approved') body = h`<h1>許可しました</h1><p class="lead">CLI に戻ってください。数秒でログインが完了します。</p>`
  else if (status === 'denied') body = h`<h1>拒否しました</h1><p class="lead">CLI のログインは失敗します。</p>`
  else if (!info || info.status !== 'pending') {
    body = h`<h1>CLI のログイン</h1>
${code ? flash('コードが見つからないか、期限が切れています。', 'error') : ''}
<p class="lead">ターミナルに表示されたコードを入力してください。</p>
<form method="get" action="${ENDPOINTS.deviceVerify}" class="stack">
  <input name="code" inputmode="text" autocomplete="one-time-code" placeholder="XXXX-XXXX" maxlength="9" required>
  <button class="primary" type="submit">次へ</button>
</form>`
  } else {
    body = h`<h1>CLI のログインを許可しますか</h1>
<div class="consent">
  <p class="client-name">Remora CLI</p>
  <p>コード: <strong class="big code">${formatUserCode(info.userCode)}</strong></p>
  <p class="muted">ターミナルに表示されているコードと一致するか確かめてください。一致しないときは拒否してください。</p>
  <p>範囲: ${info.scope.map(scope => h`<code>${scope}</code> `)}</p>
  <p class="muted">送り先: ${info.resource}</p>
</div>
<form method="post" action="${ENDPOINTS.deviceVerify}" data-reauth>
  <input type="hidden" name="code" value="${info.userCode}">
  <div class="actions">
    <button class="primary" type="submit" name="decision" value="approve">パスキーで確認して許可</button>
    <button type="submit" name="decision" value="deny" data-no-reauth>拒否</button>
  </div>
</form>`
  }
  return html(page({ title: 'CLI のログイン', narrow: true, body, scripts: ['/js/webauthn.js'] }))
}

async function devicePost(request: Request, env: Env, setup: OAuthSetup): Promise<Response> {
  const origin = hubOrigin(request, env)
  if (!sameOrigin(request, origin)) return errorPage('拒否しました', '別のサイトからの送信は受け付けません。', 403)
  const session = await getSession(request, env)
  if (!session) return errorPage('ログインが必要です', 'もう一度やり直してください。', 403)
  const form = await readForm(request)
  const code = normalizeUserCode(form.get('code') ?? '')
  const hub = hubStub(env)
  const info = await hub.deviceLookup(code)
  if (!info || info.status !== 'pending') return redirect(`${ENDPOINTS.deviceVerify}?code=${encodeURIComponent(code)}`)
  if (form.get('decision') !== 'approve') {
    await hub.deviceDecide(code, { approve: false })
    return redirect(`${ENDPOINTS.deviceVerify}?done=denied`)
  }
  if (!session.fresh) return errorPage('パスキーでの確認が必要です', '許可するには、ボタンを押してパスキーで確認してください。', 403)
  await ensureCliClient(env)
  const codeVerifier = randomToken(48)
  const codeChallenge = toBase64Url(await sha256(codeVerifier))
  const redirectUri = CLI_REDIRECT_URIS[0] as string
  const authRequest: AuthRequest = {
    responseType: 'code',
    clientId: CLI_CLIENT_ID,
    redirectUri,
    scope: info.scope,
    state: randomToken(16),
    codeChallenge,
    codeChallengeMethod: 'S256',
    resource: info.resource,
    issuer: origin,
  }
  const { redirectTo } = await oauthApi(setup, env).completeAuthorization({
    request: authRequest,
    userId: 'owner',
    metadata: { clientName: 'Remora CLI', via: 'device' },
    scope: info.scope,
    props: { clientId: CLI_CLIENT_ID, clientName: 'Remora CLI' } satisfies TokenProps,
    // A device login must not sign out the CLI on other machines.
    revokeExistingGrants: false,
  })
  const authCode = new URL(redirectTo).searchParams.get('code')
  if (!authCode) return errorPage('許可できませんでした', '認可コードを発行できませんでした。', 500)
  await hub.deviceDecide(code, { approve: true, authCode, codeVerifier, redirectUri })
  await hub.upsertClient({ clientId: CLI_CLIENT_ID, name: 'Remora CLI', kind: 'cli', domain: null, redirectHost: '127.0.0.1' })
  return redirect(`${ENDPOINTS.deviceVerify}?done=approved`)
}
