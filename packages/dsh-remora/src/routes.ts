/**
 * Settings-tab RPC over DSH's authenticated connection
 * (`ctx.connection.fetch.register`). DSH Web keeps its own settings forms in
 * memory when opened from another device, so Remora saves through these
 * routes instead. Envelope matches DSH's client RPC:
 *   request  { type: 'client-request', rpcId, method, payload }
 *   response { type: 'server-response', rpcId, result: { ok, value | error } }
 *
 * Changes that widen remote access (raising the ceiling, full access,
 * turning the kill switch off, pairing, adding workspaces, placements or
 * allowed commands …) are accepted only from a browser on this PC; see
 * `isLocalRequest`. Narrowing changes are accepted from anywhere.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { HostContext } from './dsh.ts'
import type { RemoraCore } from './core/remora.ts'
import { RpcError } from './core/rpc-error.ts'
import { UpdateError } from './core/updates.ts'
import { PairingError } from './core/pairing.ts'

export { RpcError } from './core/rpc-error.ts'

export const RPC_NAMESPACE = 'remora'

export interface CallInfo {
  /** The browser reached DSH Web through a loopback address on this PC. */
  local: boolean
}

type Method = (payload: unknown, info: CallInfo) => unknown | Promise<unknown>

const peerAddress = new AsyncLocalStorage<string | undefined>()

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  return isLoopbackHostname(address.startsWith('::ffff:') ? address.slice(7) : address)
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true
  const parts = host.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function hostnameOf(authority: string): string | null {
  try { return new URL(`http://${authority}`).hostname } catch { return null }
}

/**
 * Whether a settings request comes from a browser on this PC. DSH's own
 * fence already rejected Hosts other than loopback, the bind address and
 * configured `trustedHosts`; here only a loopback socket peer, Host (and loopback Origin,
 * when sent) without any reverse-proxy forwarding header counts as local.
 * An SSH port forward to the loopback port also counts: whoever holds that
 * tunnel already has a shell on this PC.
 */
export function isLocalRequest(request: Request, address = peerAddress.getStore()): boolean {
  if (!isLoopbackAddress(address)) return false
  const headers = request.headers
  for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip']) {
    if (headers.get(name) !== null) return false
  }
  const host = headers.get('host')
  const hostName = host === null ? null : hostnameOf(host)
  if (hostName === null || !isLoopbackHostname(hostName)) return false
  const origin = headers.get('origin')
  if (origin !== null) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false
    } catch {
      return false
    }
  }
  return true
}

function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)[key] : undefined
}

function bool(payload: unknown, key: string): boolean {
  const value = field(payload, key)
  if (typeof value !== 'boolean') throw new RpcError('invalid-payload', key)
  return value
}

export function createMethods(core: RemoraCore): Record<string, Method> {
  const withReady = (method: Method): Method => async (payload, info) => {
    await core.ready
    await core.syncState()
    return method(payload, info)
  }
  const methods: Record<string, Method> = {
    state: (_, { local }) => core.snapshot(local),
    catalog: () => core.catalog(),
    audit: async () => ({ entries: await core.auditEntries(200) }),
    clients: () => ({ clients: core.clients() }),
    'kill-switch': async (payload, { local }) => {
      await core.setKillSwitch(bool(payload, 'on'), local)
      return core.snapshot(local)
    },
    permission: async (payload, { local }) => {
      const level = field(payload, 'level')
      if (level !== 'view' && level !== 'request' && level !== 'full') throw new RpcError('invalid-payload', 'level')
      const overrides = field(payload, 'overrides')
      if (overrides !== undefined && (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides))) throw new RpcError('invalid-payload', 'overrides')
      const confirmFull = field(payload, 'confirmFull') === true
      await core.setPermission({ level, ...(overrides ? { overrides: overrides as Record<string, boolean> } : {}), confirmFull }, local)
      return core.snapshot(local)
    },
    'full-access-extend': async (_, { local }) => {
      await core.extendFullAccess(local)
      return core.snapshot(local)
    },
    settings: async (payload, { local }) => {
      await core.updateSettings(payload, local)
      return core.snapshot(local)
    },
    answers: async (payload, { local }) => {
      await core.setAnswers(payload, local)
      return core.snapshot(local)
    },
    'placement-add': async (payload, { local }) => {
      await core.addPlacement(field(payload, 'path'), local)
      return core.snapshot(local)
    },
    'placement-remove': async (payload, { local }) => {
      await core.removePlacement(field(payload, 'placementId'), local)
      return core.snapshot(local)
    },
    'pairing-start': async (payload, { local }) => {
      const hubUrl = field(payload, 'hubUrl')
      if (typeof hubUrl !== 'string' || hubUrl.length > 2000) throw new RpcError('invalid-payload', 'hubUrl')
      await core.startPairing(hubUrl, local)
      return core.snapshot(local)
    },
    'pairing-cancel': (_, { local }) => {
      core.cancelPairing()
      return core.snapshot(local)
    },
    unpair: async (_, { local }) => {
      await core.unpair(local)
      return core.snapshot(local)
    },
    'owner-credentials': async (payload, { local }) => {
      await core.resolveCredentialChange(bool(payload, 'accept'), local)
      return core.snapshot(local)
    },
    'question-mode': async (_, { local }) => {
      await core.switchQuestionMode(local)
      return core.snapshot(local)
    },
    reconnect: async (_, { local }) => {
      await core.reconnect()
      return core.snapshot(local)
    },
    'update-check': async payload => core.checkUpdate(field(payload, 'force') === true),
    'update-install': async (_, { local }) => core.installUpdate(local),
  }
  return Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, withReady(method)]))
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

function errorCode(error: unknown): { code: string; detail?: string } {
  if (error instanceof RpcError) return error.detail === undefined ? { code: error.code } : { code: error.code, detail: error.detail }
  if (error instanceof PairingError) return { code: `pairing-${error.code}` }
  if (error instanceof UpdateError) return { code: `update-${error.code}` }
  return { code: 'unavailable' }
}

export function createHandler(method: string, impl: Method, log?: (message: string, error: unknown) => void): (request: Request) => Promise<Response> {
  const endpoint = `${RPC_NAMESPACE}/${method}`
  return async request => {
    let rpcId: string | undefined
    try {
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return new Response('unsupported media type', { status: 415 })
      const envelope = await request.json() as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
      if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 100 || envelope.method !== endpoint) {
        return new Response('invalid request', { status: 400 })
      }
      rpcId = envelope.rpcId
      request.signal.throwIfAborted()
      const value = await impl(envelope.payload, { local: isLocalRequest(request) })
      return json({ type: 'server-response', rpcId, result: { ok: true, value } })
    } catch (error) {
      if (rpcId === undefined) return new Response('invalid request', { status: 400 })
      const { code, detail } = errorCode(error)
      if (code === 'unavailable') log?.(`Remora: ${endpoint} failed`, error)
      return json({ type: 'server-response', rpcId, result: { ok: false, error: { code: `${RPC_NAMESPACE}/${code}`, message: code, details: detail === undefined ? {} : { detail } } } })
    }
  }
}

export function registerRoutes(ctx: HostContext, core: RemoraCore): void {
  // The Fetch bridge drops socket metadata. Carry it through DSH's authenticated
  // HTTP waterfall without trusting any client-supplied header.
  ctx.on('connection/request', (request, _response, next) => peerAddress.run(request.socket.remoteAddress, next), { prepend: true, global: true })
  for (const [method, impl] of Object.entries(createMethods(core))) {
    ctx.connection.fetch.register({
      path: `/api/${RPC_NAMESPACE}/${method}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createHandler(method, impl, (message, error) => ctx.logger.warn(message, error)),
    })
  }
}
