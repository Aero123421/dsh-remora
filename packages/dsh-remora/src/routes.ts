/**
 * Settings-tab RPC over DSH's authenticated connection
 * (`ctx.connection.fetch.register`). DSH Web keeps its own settings forms in
 * memory when opened from another device, so Remora saves through these
 * routes instead. Envelope matches DSH's client RPC:
 *   request  { type: 'client-request', rpcId, method, payload }
 *   response { type: 'server-response', rpcId, result: { ok, value | error } }
 */
import type { HostContext } from './dsh.ts'
import type { RemoraState } from './state.ts'

export const RPC_NAMESPACE = 'remora'

export class RpcError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

type Method = (payload: unknown) => unknown | Promise<unknown>

export function createMethods(state: RemoraState): Record<string, Method> {
  return {
    state: () => state.snapshot(),
    'kill-switch': payload => {
      const on = (payload as { on?: unknown } | null)?.on
      if (typeof on !== 'boolean') throw new RpcError('invalid-payload')
      return state.setKillSwitch(on)
    },
  }
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

export function createHandler(method: string, impl: Method): (request: Request) => Promise<Response> {
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
      const value = await impl(envelope.payload)
      return json({ type: 'server-response', rpcId, result: { ok: true, value } })
    } catch (error) {
      if (rpcId === undefined) return new Response('invalid request', { status: 400 })
      const code = error instanceof RpcError ? error.code : 'unavailable'
      return json({ type: 'server-response', rpcId, result: { ok: false, error: { code: `${RPC_NAMESPACE}/${code}`, message: code, details: {} } } })
    }
  }
}

export function registerRoutes(ctx: HostContext, state: RemoraState): void {
  for (const [method, impl] of Object.entries(createMethods(state))) {
    ctx.connection.fetch.register({
      path: `/api/${RPC_NAMESPACE}/${method}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: createHandler(method, impl),
    })
  }
}
