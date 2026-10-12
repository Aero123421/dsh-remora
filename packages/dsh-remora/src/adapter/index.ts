/**
 * Adapter entry point: operations implemented on top of DSH APIs.
 * Owned by the adapter work stream; the core only calls `createAdapter`.
 * (Stub until the adapter lands: no operations.)
 */
import type { CreateAdapter } from '../ops/types.ts'

export const createAdapter: CreateAdapter = (ctx) => ({
  handlers: {},
  has: service => ctx.get(service) !== undefined,
  start() {},
  dispose() {},
})
