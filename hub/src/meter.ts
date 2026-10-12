/**
 * Cheap free-tier meter. Each Worker isolate counts its own requests,
 * Durable Object calls and KV writes in memory and flushes the deltas to
 * the hub object every so often (one extra Durable Object request per
 * flush). Counts are approximate: an isolate that is evicted before a flush
 * loses its last few events, and requests Cloudflare answers without
 * running the Worker (static assets) are not counted, as they are not
 * billed either.
 */
import { HUB_OBJECT_NAME, type HubDO } from './hub-do.ts'
import type { HostDO } from './host-do.ts'

const pending = { worker: 0, durable: 0, kv: 0 }
let lastFlush = Date.now()

const FLUSH_EVERY = 50
const FLUSH_AFTER_MS = 60_000

export function countWorkerRequest(): void {
  pending.worker++
}

export function countKvWrite(n = 1): void {
  pending.kv += n
}

/** Flush the counters when enough has accumulated. Call with the request's `ctx.waitUntil`. */
export function maybeFlush(env: Env, ctx: ExecutionContext, force = false): void {
  const total = pending.worker + pending.durable + pending.kv
  if (total === 0) return
  if (!force && total < FLUSH_EVERY && Date.now() - lastFlush < FLUSH_AFTER_MS) return
  const delta = { ...pending }
  pending.worker = 0
  pending.durable = 0
  pending.kv = 0
  lastFlush = Date.now()
  ctx.waitUntil(
    env.HUB.get(env.HUB.idFromName(HUB_OBJECT_NAME)).meterAdd(delta).catch(() => {
      pending.worker += delta.worker
      pending.durable += delta.durable
      pending.kv += delta.kv
    }),
  )
}

/** Wrap a stub so each method call counts as one Durable Object request. */
function counted<T extends object>(stub: T): T {
  return new Proxy(stub, {
    get(target, property) {
      // RPC stubs answer every property with a callable stub, so call through the
      // target itself: `Function.prototype.apply` would be sent as an RPC method.
      if (typeof property !== 'string' || property === 'then' || property === 'id' || property === 'name') return Reflect.get(target, property)
      return (...args: unknown[]) => {
        pending.durable++
        return (target as Record<string, (...a: unknown[]) => unknown>)[property]!(...args)
      }
    },
  })
}

export function hubStub(env: Env): DurableObjectStub<HubDO> {
  return counted(env.HUB.get(env.HUB.idFromName(HUB_OBJECT_NAME)))
}

export function hostStub(env: Env, hostId: string): DurableObjectStub<HostDO> {
  return counted(env.HOST.get(env.HOST.idFromName(hostId)))
}

/** A KV namespace wrapper that counts writes and deletes (both are billed as writes). */
export function countingKv(kv: KVNamespace): KVNamespace {
  return new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      if (property === 'put' || property === 'delete') {
        return (...args: unknown[]) => {
          pending.kv++
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return (value as (...a: unknown[]) => unknown).bind(target)
    },
  })
}
