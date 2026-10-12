/** Test support: a fake hub on node:http and a Ctx that captures output. */
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { exec as realExec, type Ctx } from '../src/ctx.ts'

export interface TestCtx {
  ctx: Ctx
  out: string[]
  err: string[]
  slept: number[]
  dir: string
  stdout(): string
  stderr(): string
}

export async function testCtx(overrides: Partial<Ctx> & { stdinText?: string; envExtra?: NodeJS.ProcessEnv } = {}): Promise<TestCtx> {
  const dir = await mkdtemp(join(tmpdir(), 'remora-test-'))
  const out: string[] = []
  const err: string[] = []
  const slept: number[] = []
  const base = Date.now()
  let offset = 0
  const { stdinText, envExtra, ...rest } = overrides
  const ctx: Ctx = {
    out: line => { out.push(line) },
    err: line => { err.push(line) },
    errWrite: text => { err.push(text) },
    env: { REMORA_CONFIG_DIR: dir, REMORA_TOKEN_STORE: 'file', ...envExtra },
    platform: 'linux',
    arch: 'x64',
    nodeVersion: 'v22.22.0',
    cwd: dir,
    execPath: process.execPath,
    isSea: false,
    stdin: Readable.from(stdinText === undefined ? [] : [stdinText]),
    stdinIsTTY: stdinText === undefined,
    stderrIsTTY: false,
    fetch: (...args) => fetch(...args),
    now: () => base + (Date.now() - base) + offset,
    sleep: async ms => { slept.push(ms); offset += ms; await new Promise(resolve => setImmediate(resolve)) },
    openBrowser: async () => false,
    exec: realExec,
    confirm: async () => true,
    ...rest,
  }
  return { ctx, out, err, slept, dir, stdout: () => out.join('\n'), stderr: () => err.join('\n') }
}

/** A browser that follows the hub's authorize redirect to the CLI's loopback callback. */
export async function fakeBrowser(url: string): Promise<boolean> {
  const first = await fetch(url, { redirect: 'manual' })
  const location = first.headers.get('location')
  if (!location) return false
  await fetch(location)
  return true
}

type OpHandler = (params: Record<string, unknown>, call: number) => { status?: number; body: unknown } | unknown

export interface FakeHubOptions {
  /** Serve RFC 9728 metadata for /api/v1/ops and /mcp, naming these resources. */
  resources?: { api: string; mcp: string }
  /** Leave revocation_endpoint out of the metadata. */
  noRevocationMeta?: boolean
  /** Refuse MCP 2026-07-28 requests like a hub that only speaks the legacy revisions. */
  legacyOnly?: boolean
  accessTtl?: number
  issuerOverride?: string
  mcpMode?: 'json' | 'sse'
  /** Responses for successive device-code polls, e.g. ['authorization_pending', 'slow_down', 'ok']. */
  devicePolls?: string[]
}

export class FakeHub {
  readonly port: number
  readonly url: string
  readonly options: FakeHubOptions
  server: Server | null = null
  ops: Record<string, OpHandler> = {}
  calls: { op: string; params: Record<string, unknown>; auth: string | null }[] = []
  mcpCalls: { body: unknown; headers: Record<string, string | string[] | undefined> }[] = []
  tokenRequests: Record<string, string>[] = []
  authorizeRequests: URLSearchParams[] = []
  revoked: string[] = []
  validAccess = new Set<string>()
  validRefresh = new Set<string>()
  codes = new Map<string, { challenge: string; redirectUri: string; scope: string }>()
  devicePolls: string[]
  private counter = 0

  constructor(port: number, options: FakeHubOptions = {}) {
    this.port = port
    this.url = `http://127.0.0.1:${port}`
    this.options = options
    this.devicePolls = [...(options.devicePolls ?? ['ok'])]
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => { this.handle(req, res).catch(error => { res.writeHead(500); res.end(String(error)) }) })
    await new Promise<void>(resolve => this.server!.listen(this.port, '127.0.0.1', resolve))
    return this
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve())
  }

  issue(): { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string } {
    const n = ++this.counter
    const access = `at-${n}`
    const refresh = `rt-${n}`
    this.validAccess.add(access)
    this.validRefresh.add(refresh)
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: this.options.accessTtl ?? 3600, scope: 'dsh.read dsh.content dsh.tasks offline_access' }
  }

  private async body(req: IncomingMessage): Promise<string> {
    let text = ''
    for await (const chunk of req) text += chunk
    return text
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  private bearer(req: IncomingMessage): string | null {
    const h = req.headers.authorization
    return h?.startsWith('Bearer ') ? h.slice(7) : null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url)
    const issuer = this.options.issuerOverride ?? this.url
    if (url.pathname === '/healthz') { this.json(res, 200, { ok: true }); return }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      this.json(res, 200, {
        issuer,
        authorization_endpoint: `${this.url}/oauth/authorize`,
        token_endpoint: `${this.url}/oauth/token`,
        device_authorization_endpoint: `${this.url}/oauth/device_authorization`,
        ...(this.options.noRevocationMeta ? {} : { revocation_endpoint: `${this.url}/oauth/revoke` }),
        code_challenge_methods_supported: ['S256'],
      })
      return
    }
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource/')) {
      const path = url.pathname.slice('/.well-known/oauth-protected-resource'.length)
      const r = this.options.resources
      if (r && path === '/api/v1/ops') { this.json(res, 200, { resource: r.api }); return }
      if (r && path === '/mcp') { this.json(res, 200, { resource: r.mcp }); return }
      this.json(res, 404, {}); return
    }
    if (url.pathname === '/oauth/authorize') {
      const q = url.searchParams
      this.authorizeRequests.push(q)
      const redirect = q.get('redirect_uri') ?? ''
      if (q.get('client_id') !== 'remora-cli' || q.get('code_challenge_method') !== 'S256' || !redirect.startsWith('http://127.0.0.1:')) { this.json(res, 400, { error: 'invalid_request' }); return }
      const code = `code-${++this.counter}`
      this.codes.set(code, { challenge: q.get('code_challenge') ?? '', redirectUri: redirect, scope: q.get('scope') ?? '' })
      const back = new URL(redirect)
      back.searchParams.set('code', code)
      back.searchParams.set('state', q.get('state') ?? '')
      back.searchParams.set('iss', issuer)
      res.writeHead(302, { location: back.toString() })
      res.end()
      return
    }
    if (url.pathname === '/oauth/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await this.body(req)))
      this.tokenRequests.push(form)
      if (form.client_id !== 'remora-cli') { this.json(res, 401, { error: 'invalid_client' }); return }
      if (form.grant_type === 'authorization_code') {
        const entry = this.codes.get(form.code ?? '')
        const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url')
        if (!entry || entry.challenge !== challenge || entry.redirectUri !== form.redirect_uri) { this.json(res, 400, { error: 'invalid_grant' }); return }
        this.codes.delete(form.code ?? '')
        this.json(res, 200, this.issue())
        return
      }
      if (form.grant_type === 'refresh_token') {
        if (!this.validRefresh.has(form.refresh_token ?? '')) { this.json(res, 400, { error: 'invalid_grant' }); return }
        this.validRefresh.delete(form.refresh_token ?? '')
        this.json(res, 200, this.issue())
        return
      }
      if (form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const next = this.devicePolls.shift() ?? 'ok'
        if (next === 'ok') this.json(res, 200, this.issue())
        else this.json(res, 400, { error: next })
        return
      }
      this.json(res, 400, { error: 'unsupported_grant_type' })
      return
    }
    if (url.pathname === '/oauth/device_authorization' && req.method === 'POST') {
      const form = new URLSearchParams(await this.body(req))
      this.tokenRequests.push(Object.fromEntries(form))
      this.json(res, 200, { device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_uri: `${this.url}/device`, verification_uri_complete: `${this.url}/device?code=ABCD-EFGH`, expires_in: 600, interval: 1 })
      return
    }
    if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
      const form = new URLSearchParams(await this.body(req))
      const token = form.get('token') ?? ''
      this.revoked.push(token)
      this.validAccess.delete(token)
      this.validRefresh.delete(token)
      res.writeHead(200); res.end(); return
    }
    if (url.pathname.startsWith('/api/v1/ops/') && req.method === 'POST') {
      const op = url.pathname.slice('/api/v1/ops/'.length)
      const auth = this.bearer(req)
      const params = JSON.parse(await this.body(req) || '{}') as Record<string, unknown>
      this.calls.push({ op, params, auth })
      if (!auth || !this.validAccess.has(auth)) { this.json(res, 401, { error: { code: 'denied', message: 'invalid token' } }); return }
      const handler = this.ops[op]
      if (!handler) { this.json(res, 404, { error: { code: 'not_found', message: `unknown operation ${op}` } }); return }
      const count = this.calls.filter(c => c.op === op).length
      const result = handler(params, count) as { status?: number; body?: unknown } | Record<string, unknown>
      if (result && typeof result === 'object' && 'status' in result && typeof result.status === 'number') this.json(res, result.status, result.body)
      else this.json(res, 200, result)
      return
    }
    if (url.pathname === '/mcp' && req.method === 'POST') {
      const auth = this.bearer(req)
      const body = JSON.parse(await this.body(req)) as Record<string, unknown>
      this.mcpCalls.push({ body, headers: req.headers })
      if (!auth || !this.validAccess.has(auth)) { this.json(res, 401, { error: 'invalid_token' }); return }
      if (body.id === undefined) { res.writeHead(202); res.end(); return }
      const params = (body.params ?? {}) as Record<string, unknown>
      const declared = ((params._meta ?? {}) as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion']
      if (declared !== undefined) {
        const bad = (code: number, message: string) => { this.json(res, 400, { jsonrpc: '2.0', id: body.id, error: { code, message } }) }
        if (this.options.legacyOnly || declared !== '2026-07-28') { bad(-32022, 'Unsupported protocol version'); return }
        if (req.headers['mcp-protocol-version'] !== declared || req.headers['mcp-method'] !== body.method) { bad(-32020, 'Header mismatch'); return }
        if (body.method === 'tools/call' && req.headers['mcp-name'] !== params.name) { bad(-32020, 'Header mismatch: Mcp-Name'); return }
      }
      let result: unknown
      if (body.method === 'server/discover' && declared !== undefined) result = { resultType: 'complete', supportedVersions: ['2026-07-28', '2025-06-18'], capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'remora-hub', version: '0.0.2' } } }
      else if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remora-hub', version: '0.0.1' } }
      else if (body.method === 'tools/list') {
        const cursor = (body.params as { cursor?: string } | undefined)?.cursor
        result = cursor
          ? { tools: [{ name: 'dsh_task_start', description: 'Send a prompt', annotations: { readOnlyHint: false } }] }
          : { tools: [{ name: 'dsh_status', description: 'Summarize', annotations: { readOnlyHint: true } }], nextCursor: 'p2' }
      } else if (body.method === 'tools/call') result = { content: [{ type: 'text', text: 'ok' }] }
      else { this.json(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }); return }
      const reply = { jsonrpc: '2.0', id: body.id, result }
      if (this.options.mcpMode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(': keepalive\n\n')
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`)
        const text = JSON.stringify(reply)
        // Split one event's data across writes to exercise the parser.
        res.write(`data: ${text.slice(0, 10)}`)
        await new Promise(resolve => setTimeout(resolve, 5))
        res.end(`${text.slice(10)}\n\n`)
      } else {
        this.json(res, 200, reply)
      }
      return
    }
    this.json(res, 404, { error: 'not found' })
  }
}

/** Log a CLI into a fake hub without a browser by seeding the file token store. */
export async function seedLogin(t: TestCtx, hub: FakeHub, opts: { expiresIn?: number; scope?: string } = {}): Promise<void> {
  const { saveProfile } = await import('../src/config.ts')
  const { openTokenStore } = await import('../src/tokens.ts')
  const issued = hub.issue()
  const store = await openTokenStore(t.ctx)
  await store.save({
    hubUrl: hub.url,
    clientId: 'remora-cli',
    scope: opts.scope ?? issued.scope,
    issuer: hub.url,
    tokenEndpoint: `${hub.url}/oauth/token`,
    revocationEndpoint: `${hub.url}/oauth/revoke`,
    resources: {},
    refreshToken: issued.refresh_token,
    access: { default: { token: issued.access_token, expiresAt: t.ctx.now() + (opts.expiresIn ?? 3600) * 1000 } },
  })
  await saveProfile(t.ctx, { hubUrl: hub.url })
}
