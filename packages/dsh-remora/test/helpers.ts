import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confirmationChallenge, toBase64Url, type Confirmation, type OwnerCredential } from '@dsh-remora/protocol'
import type { FetchRoute, HostContext } from '../src/dsh.ts'

const peers = new WeakMap<Request, string>()

export async function tempDir(prefix = 'remora-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

// Minimal CBOR encoder for COSE keys in tests.
function head(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length]
  if (length < 256) return [(major << 5) | 24, length]
  return [(major << 5) | 25, length >> 8, length & 0xff]
}
export function cbor(value: number | Uint8Array | Map<number, number | Uint8Array>): Uint8Array {
  const out: number[] = []
  const write = (item: number | Uint8Array | Map<number, number | Uint8Array>) => {
    if (typeof item === 'number') out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)))
    else if (item instanceof Uint8Array) { out.push(...head(2, item.length)); out.push(...item) }
    else { out.push(...head(5, item.size)); for (const [k, v] of item) { write(k); write(v) } }
  }
  write(value)
  return new Uint8Array(out)
}

export interface Passkey {
  credential: OwnerCredential
  privateKey: KeyObject
  algorithm: number
}

export function makePasskey(kind: 'es256' | 'ed25519', credentialId = `cred-${kind}`): Passkey {
  if (kind === 'es256') {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const jwk = publicKey.export({ format: 'jwk' })
    const cose = cbor(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x as string, 'base64url')], [-3, Buffer.from(jwk.y as string, 'base64url')]]))
    return { credential: { credentialId, publicKey: toBase64Url(cose), algorithm: -7 }, privateKey, algorithm: -7 }
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' })
  const cose = cbor(new Map<number, number | Uint8Array>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x as string, 'base64url')]]))
  return { credential: { credentialId, publicKey: toBase64Url(cose), algorithm: -8 }, privateKey, algorithm: -8 }
}

export interface AssertionOptions {
  hubOrigin: string
  rpId: string
  hostId: string
  requestId: string
  operation: string
  params: unknown
  issuedAt: number
  flags?: number
  origin?: string
  type?: string
  challengeOverride?: string
  rpIdForHash?: string
}

/** Build a WebAuthn-shaped confirmation as a browser + authenticator would. */
export async function makeConfirmation(passkey: Passkey, options: AssertionOptions): Promise<Confirmation> {
  const challenge = options.challengeOverride ?? await confirmationChallenge({
    hubOrigin: options.hubOrigin, hostId: options.hostId, requestId: options.requestId,
    operation: options.operation, params: options.params, issuedAt: options.issuedAt,
  })
  const clientData = Buffer.from(JSON.stringify({ type: options.type ?? 'webauthn.get', challenge, origin: options.origin ?? options.hubOrigin, crossOrigin: false }))
  const authData = Buffer.concat([
    createHash('sha256').update(options.rpIdForHash ?? options.rpId).digest(),
    Buffer.from([options.flags ?? 0x05]),
    Buffer.from([0, 0, 0, 1]),
  ])
  const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()])
  const signature = passkey.algorithm === -7 ? sign('sha256', signed, passkey.privateKey) : sign(null, signed, passkey.privateKey)
  return {
    issuedAt: options.issuedAt,
    assertion: {
      credentialId: passkey.credential.credentialId,
      authenticatorData: toBase64Url(authData),
      clientDataJSON: toBase64Url(clientData),
      signature: toBase64Url(new Uint8Array(signature)),
    },
  }
}

export interface FakeHost {
  ctx: HostContext
  routes: Map<string, FetchRoute>
  disposers: (() => void | Promise<void>)[]
  dispose(): void
  warnings: unknown[][]
}

export function fakeHost(services: Record<string, unknown> = {}): FakeHost {
  const routes = new Map<string, FetchRoute>()
  const disposers: (() => void | Promise<void>)[] = []
  const warnings: unknown[][] = []
  type Listener = Parameters<HostContext['on']>[1]
  const listeners = new Map<string, Listener[]>()
  const ctx: HostContext = {
    connection: { fetch: { register: route => { routes.set(route.path, { ...route, fetch: async request => {
      const socket = new Socket()
      Object.defineProperty(socket, 'remoteAddress', { value: peers.get(request) ?? '127.0.0.1' })
      const incoming = new IncomingMessage(socket)
      const outgoing = new ServerResponse(incoming)
      let response: Response | undefined
      const run = async (index: number): Promise<void> => {
        const listener = listeners.get('connection/request')?.[index]
        if (listener) await listener(incoming, outgoing, () => run(index + 1))
        else response = await route.fetch(request)
      }
      await run(0)
      if (!response) throw new Error('request waterfall did not delegate')
      return response
    } }) } } },
    get: service => services[service],
    effect: setup => { disposers.push(setup()) },
    on: (_event, listener, options) => {
      const list = listeners.get(_event) ?? []
      if (options?.prepend) list.unshift(listener)
      else list.push(listener)
      listeners.set(_event, list)
      const dispose = () => { const index = list.indexOf(listener); if (index >= 0) list.splice(index, 1) }
      disposers.push(dispose)
      return dispose
    },
    logger: { info: () => {}, warn: (...args) => { warnings.push(args) } },
  }
  return { ctx, routes, disposers, warnings, dispose: () => { for (const d of disposers.splice(0)) d() } }
}

export async function rpc<T = unknown>(routes: Map<string, FetchRoute>, method: string, payload: unknown = {}, init: { peer?: string; contentType?: string; envelopeMethod?: string; host?: string; origin?: string; headers?: Record<string, string> } = {}): Promise<{ ok: true; value: T } | { ok: false; error: { code: string; details: { detail?: string } } }> {
  const response = await rawRpc(routes, method, payload, init)
  const body = await response.json() as { result: { ok: true; value: T } | { ok: false; error: { code: string; details: { detail?: string } } } }
  return body.result
}

export async function rawRpc(routes: Map<string, FetchRoute>, method: string, payload: unknown = {}, init: { peer?: string; contentType?: string; envelopeMethod?: string; host?: string; origin?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const route = routes.get(`/api/remora/${method}`)
  if (!route) throw new Error(`no route for ${method}`)
  const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: init.envelopeMethod ?? `remora/${method}`, payload })
  const headers: Record<string, string> = { 'content-type': init.contentType ?? 'application/json', host: init.host ?? '127.0.0.1:5173', ...init.headers }
  if (init.origin !== undefined) headers.origin = init.origin
  const request = new Request(`http://dsh.internal/api/remora/${method}`, { method: 'POST', headers, body })
  peers.set(request, init.peer ?? '127.0.0.1')
  return route.fetch(request)
}

export async function until(check: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** A clock whose timers only fire when `advance` is called. */
export function manualClock(start = 1_000_000) {
  let now = start
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: (handle: unknown) => { timers.delete(handle as number) },
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at
      timers.delete(due[0])
      due[1].fn()
    }
    now = target
  }
  return { clock, advance }
}
