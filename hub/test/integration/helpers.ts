/**
 * Test helpers: a software WebAuthn authenticator (ES256, "none"
 * attestation), an Ed25519 DSH host, cookie handling and a fake host
 * WebSocket that answers request frames.
 */
import { exports } from 'cloudflare:workers'
import { expect } from 'vitest'
import { fromBase64Url, hostAuthMessage, pairPollMessage, rotateKeyMessage, toBase64Url, type HubFrame } from '../../src/vendor/protocol/index.ts'

export const ORIGIN = 'https://hub.example.com'
export const SETUP_TOKEN = 'test-setup-token-0123456789'

const SELF = (exports as unknown as { default: Fetcher }).default

/**
 * Fetch from the hub. Pages render in the request's language; these tests were
 * written against the Japanese pages, so Accept-Language defaults to `ja`.
 */
export async function hubFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has('accept-language')) headers.set('accept-language', 'ja')
  const response = await SELF.fetch(new Request(`${ORIGIN}${path}`, { redirect: 'manual', ...init, headers }))
  if (response.headers.get('content-type')?.includes('text/html')) assertNoNestedForms(await response.clone().text(), path)
  return response
}

/**
 * Browsers drop a <form> start tag inside another form, so the inner buttons
 * submit the outer form (a "Deny" button once ran the command it was meant to
 * refuse). Every page the tests fetch is checked.
 */
export function assertNoNestedForms(html: string, where: string): void {
  let depth = 0
  for (const match of html.matchAll(/<(\/?)form\b/gi)) {
    depth += match[1] ? -1 : 1
    if (depth > 1) throw new Error(`nested <form> on ${where} at offset ${match.index}`)
  }
}

// --- minimal CBOR encoder ------------------------------------------------------------

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>

function head(major: number, value: number): number[] {
  if (value < 24) return [(major << 5) | value]
  if (value < 256) return [(major << 5) | 24, value]
  if (value < 65536) return [(major << 5) | 25, value >> 8, value & 255]
  return [(major << 5) | 26, (value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
}

export function cbor(value: Cbor): Uint8Array {
  const out: number[] = []
  const write = (item: Cbor): void => {
    if (typeof item === 'number') out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)))
    else if (typeof item === 'string') {
      const bytes = new TextEncoder().encode(item)
      out.push(...head(3, bytes.length), ...bytes)
    } else if (item instanceof Uint8Array) out.push(...head(2, item.length), ...item)
    else if (Array.isArray(item)) {
      out.push(...head(4, item.length))
      item.forEach(write)
    } else {
      out.push(...head(5, item.size))
      for (const [key, val] of item) {
        write(key)
        write(val)
      }
    }
  }
  write(value)
  return new Uint8Array(out)
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

const sha256 = async (data: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data))

function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    let body = bytes.slice(start)
    if ((body[0] ?? 0) & 0x80) body = concat(new Uint8Array([0]), body)
    return concat(new Uint8Array([0x02, body.length]), body)
  }
  const r = integer(raw.slice(0, 32))
  const s = integer(raw.slice(32))
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s)
}

/** A platform authenticator that always verifies the user. */
export class SoftAuthenticator {
  private keys?: CryptoKeyPair
  credentialId = crypto.getRandomValues(new Uint8Array(16))
  counter = 0
  userHandle: Uint8Array | null = null

  get id(): string {
    return toBase64Url(this.credentialId)
  }

  async create(options: { challenge: string; rp: { id: string }; user: { id: string } }, origin = ORIGIN) {
    this.keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey('jwk', this.keys.publicKey)) as JsonWebKey
    const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, fromBase64Url(jwk.x as string)], [-3, fromBase64Url(jwk.y as string)]]))
    this.userHandle = fromBase64Url(options.user.id)
    const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }))
    const idLength = new Uint8Array([0, this.credentialId.length])
    const authData = concat(await sha256(options.rp.id), new Uint8Array([0x45, 0, 0, 0, 0]), new Uint8Array(16), idLength, this.credentialId, cose)
    const attestationObject = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: toBase64Url(clientData), attestationObject: toBase64Url(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }

  async get(options: { challenge: string; rpId: string }, origin = ORIGIN) {
    if (!this.keys) throw new Error('no credential')
    this.counter++
    const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }))
    const counter = new Uint8Array([(this.counter >>> 24) & 255, (this.counter >>> 16) & 255, (this.counter >>> 8) & 255, this.counter & 255])
    const authData = concat(await sha256(options.rpId), new Uint8Array([0x05]), counter)
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, concat(authData, await sha256(clientData))))
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(clientData),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(rawToDer(signature)),
        userHandle: this.userHandle ? toBase64Url(this.userHandle) : null,
      },
      clientExtensionResults: {},
    }
  }
}

// --- the owner's browser -------------------------------------------------------------------

export class Browser {
  cookies = new Map<string, string>()

  private store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';')
      const index = (pair ?? '').indexOf('=')
      if (index < 0) continue
      const name = (pair as string).slice(0, index).trim()
      const value = (pair as string).slice(index + 1).trim()
      if (/max-age=0/i.test(header) || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookies.size > 0) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    if ((init.method ?? 'GET') !== 'GET' && !headers.has('origin')) headers.set('origin', ORIGIN)
    const response = await hubFetch(path, { ...init, headers })
    this.store(response)
    return response
  }

  postJson(path: string, body: unknown): Promise<Response> {
    return this.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  postForm(path: string, fields: Record<string, string | string[]>): Promise<Response> {
    const body = new URLSearchParams()
    for (const [key, value] of Object.entries(fields)) for (const item of Array.isArray(value) ? value : [value]) body.append(key, item)
    return this.fetch(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() })
  }
}

export interface Owner {
  browser: Browser
  authenticator: SoftAuthenticator
  recoveryCodes: string[]
}

let shared: Promise<Owner> | null = null

/** The owner for this test file: storage is shared by the tests of one file, and setup runs once. */
export function setupOwner(): Promise<Owner> {
  shared ??= freshOwner()
  return shared
}

async function freshOwner(): Promise<Owner> {
  const browser = new Browser()
  const authenticator = new SoftAuthenticator()
  const options = await browser.postJson('/auth/setup/options', { setupToken: SETUP_TOKEN })
  expect(options.status).toBe(200)
  const { challengeId, options: creation } = (await options.json()) as { challengeId: string; options: { challenge: string; rp: { id: string }; user: { id: string } } }
  const verify = await browser.postJson('/auth/setup/verify', { challengeId, response: await authenticator.create(creation), label: 'test key' })
  expect(verify.status).toBe(200)
  const { recoveryCodes } = (await verify.json()) as { recoveryCodes: string[] }
  return { browser, authenticator, recoveryCodes }
}

export async function login(owner: Owner): Promise<void> {
  const options = await owner.browser.postJson('/auth/login/options', {})
  const { challengeId, options: request } = (await options.json()) as { challengeId: string; options: { challenge: string; rpId: string } }
  const verify = await owner.browser.postJson('/auth/login/verify', { challengeId, response: await owner.authenticator.get(request) })
  expect(verify.status).toBe(200)
}

export async function reauth(owner: Owner): Promise<void> {
  const options = await owner.browser.postJson('/auth/reauth/options', {})
  expect(options.status).toBe(200)
  const { challengeId, options: request } = (await options.json()) as { challengeId: string; options: { challenge: string; rpId: string } }
  const verify = await owner.browser.postJson('/auth/reauth/verify', { challengeId, response: await owner.authenticator.get(request) })
  expect(verify.status).toBe(200)
}

// --- a DSH host -------------------------------------------------------------------------------

export class FakeHost {
  keys!: CryptoKeyPair
  publicKey = ''
  hostId = ''
  socket: WebSocket | null = null
  frames: HubFrame[] = []
  closes: { code: number; reason: string }[] = []
  private waiting: ((frame: HubFrame) => void)[] = []
  /** Answers request frames; return undefined to stay silent. */
  respond: (frame: Extract<HubFrame, { t: 'request' }>) => unknown = () => ({ ok: true, result: {} })
  /** Key rotation like the plugin: prove a new key, switch to it on commit and reconnect. `bad-proof` signs wrongly. */
  rotation: 'follow' | 'bad-proof' | 'ignore' = 'follow'
  private lastHello: Parameters<FakeHost['connect']>[0] = {}
  private nextKeys: CryptoKeyPair | null = null

  static async create(): Promise<FakeHost> {
    const host = new FakeHost()
    host.keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    host.publicKey = toBase64Url(new Uint8Array((await crypto.subtle.exportKey('raw', host.keys.publicKey)) as ArrayBuffer))
    return host
  }

  async sign(message: string): Promise<string> {
    return toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, this.keys.privateKey, new TextEncoder().encode(message))))
  }

  /** Pair through the HTTP flow with the owner approving. */
  async pair(owner: Owner, name = 'test-pc'): Promise<void> {
    const start = await hubFetch('/pair/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: this.publicKey, name, pluginVersion: '0.0.1', protocol: 1 }) })
    expect(start.status).toBe(200)
    const started = (await start.json()) as { pairingId: string; userCode: string }
    const pending = await this.poll(started.pairingId)
    expect(pending.status).toBe('pending')
    await reauth(owner)
    const approve = await owner.browser.postForm('/pair', { code: started.userCode, decision: 'approve' })
    expect(approve.status).toBe(303)
    const approved = await this.poll(started.pairingId)
    expect(approved.status).toBe('approved')
    this.hostId = approved.hostId as string
  }

  async poll(pairingId: string): Promise<Record<string, unknown>> {
    const response = await hubFetch('/pair/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingId, signature: await this.sign(pairPollMessage(ORIGIN, pairingId)) }) })
    return (await response.json()) as Record<string, unknown>
  }

  async connect(hello: Partial<{ operations: string[]; ceiling: unknown; killSwitch: boolean; protocol: number }> = {}, options: { badSignature?: boolean } = {}): Promise<void> {
    this.lastHello = hello
    const response = await hubFetch(`/ws/host/${this.hostId}`, { headers: { upgrade: 'websocket' } })
    expect(response.status).toBe(101)
    const socket = response.webSocket as WebSocket
    socket.accept()
    this.socket = socket
    socket.addEventListener('close', event => {
      this.closes.push({ code: event.code, reason: event.reason })
    })
    socket.addEventListener('message', event => {
      const frame = JSON.parse(String(event.data)) as HubFrame
      this.frames.push(frame)
      const waiter = this.waiting.shift()
      if (waiter) waiter(frame)
      if (frame.t === 'request') {
        const answer = this.respond(frame) as { ok: boolean; result?: unknown; error?: unknown } | undefined
        if (answer) socket.send(JSON.stringify({ t: 'response', id: frame.id, ...answer }))
      }
      if (frame.t === 'rotate-key' && this.rotation !== 'ignore') void this.proveNewKey(socket, frame.nonce, frame.issuedAt)
      if (frame.t === 'rotate-key-commit' && this.nextKeys) void this.switchKeys()
    })
    const challenge = await this.next('challenge')
    if (challenge.t !== 'challenge') throw new Error('expected a challenge')
    socket.send(JSON.stringify({
      t: 'hello', protocol: hello.protocol ?? 1, hostId: this.hostId, name: 'test-pc', plugin: { version: '0.0.1' }, dsh: { version: '0.2.1' },
      operations: hello.operations ?? ['workspaces.list', 'sessions.list', 'session.get', 'session.read', 'skills.list', 'task.start', 'task.get', 'task.wait', 'attention.list', 'attention.respond', 'task.cancel', 'task.steer', 'command.run', 'model.select'],
      ceiling: hello.ceiling ?? { level: 'request' }, killSwitch: hello.killSwitch ?? false,
    }))
    const message = hostAuthMessage(challenge.origin, this.hostId, challenge.nonce, challenge.issuedAt)
    socket.send(JSON.stringify({ t: 'auth', nonce: challenge.nonce, signature: options.badSignature ? await this.sign('wrong') : await this.sign(message) }))
  }

  private async proveNewKey(socket: WebSocket, nonce: string, issuedAt: number): Promise<void> {
    const next = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const publicKey = toBase64Url(new Uint8Array((await crypto.subtle.exportKey('raw', next.publicKey)) as ArrayBuffer))
    const message = new TextEncoder().encode(rotateKeyMessage(ORIGIN, this.hostId, nonce, issuedAt, publicKey))
    const signature = toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, this.keys.privateKey, message)))
    const newSignature = toBase64Url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, (this.rotation === 'bad-proof' ? this.keys : next).privateKey, message)))
    this.nextKeys = next
    socket.send(JSON.stringify({ t: 'rotate-key-proof', nonce, publicKey, signature, newSignature }))
  }

  private async switchKeys(): Promise<void> {
    const next = this.nextKeys as CryptoKeyPair
    this.nextKeys = null
    this.keys = next
    this.publicKey = toBase64Url(new Uint8Array((await crypto.subtle.exportKey('raw', next.publicKey)) as ArrayBuffer))
    this.socket?.close(1000, 'reconnecting with the new key')
    await this.connect(this.lastHello)
  }

  /** Resolve with the next frame of the given type (already received or future). */
  next(type: HubFrame['t'], timeoutMs = 5000): Promise<HubFrame> {
    const found = this.frames.find(frame => frame.t === type && !(frame as { consumed?: boolean }).consumed)
    if (found) {
      ;(found as { consumed?: boolean }).consumed = true
      return Promise.resolve(found)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs)
      const check = (frame: HubFrame) => {
        if (frame.t === type) {
          clearTimeout(timer)
          ;(frame as { consumed?: boolean }).consumed = true
          resolve(frame)
        } else {
          this.waiting.push(check)
        }
      }
      this.waiting.push(check)
    })
  }

  sendEvent(events: unknown[]): void {
    this.socket?.send(JSON.stringify({ t: 'event', events }))
  }
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Wait until `check` passes or the time runs out. */
export async function eventually<T>(check: () => Promise<T>, timeoutMs = 3000): Promise<T> {
  const until = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < until) {
    try {
      return await check()
    } catch (error) {
      last = error
      await sleep(50)
    }
  }
  throw last
}

/** Sign the CLI in with authorization code + PKCE and return an access token for `resource`. */
export async function cliToken(owner: Owner, resource: string, scopes = ['dsh.read', 'dsh.content', 'dsh.tasks']): Promise<string> {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const redirectUri = 'http://127.0.0.1:53111/callback'
  const query = new URLSearchParams({ response_type: 'code', client_id: 'remora-cli', redirect_uri: redirectUri, scope: scopes.join(' '), state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource })
  const page = await (await owner.browser.fetch(`/oauth/authorize?${query}`)).text()
  const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1]
  if (!handle) throw new Error('no consent handle')
  await reauth(owner)
  const approved = await owner.browser.postForm('/oauth/authorize', { handle, decision: 'approve', scope: scopes })
  const code = new URL(approved.headers.get('location') as string).searchParams.get('code') as string
  const token = await hubFetch('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: 'remora-cli', code_verifier: verifier, resource }).toString() })
  return ((await token.json()) as { access_token: string }).access_token
}

let rpc = 0
/** Call one MCP tool (modern, stateless form) and return the JSON-RPC result. */
export async function mcpTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] }> {
  const response = await hubFetch('/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }),
  })
  const body = (await response.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] } }
  return body.result
}
