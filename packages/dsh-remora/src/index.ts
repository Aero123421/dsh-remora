/**
 * Remora — DSH host side.
 *
 * Creates the core (storage, host key, pairing, hub link, dispatch, events),
 * hands the adapter its dependencies, and exposes the settings tab's RPC
 * over DSH's authenticated connection. Everything is disposed on unload.
 */
import { createAdapter } from './adapter/index.ts'
import type { HostContext } from './dsh.ts'
import { RemoraCore, type RemoraOptions } from './core/remora.ts'
import { registerRoutes } from './routes.ts'

export const name = 'dsh-remora'
export const inject = ['connection']

/** Test hook: options merged into the core (data folder, socket factory, fetch). */
export interface ApplyOptions extends Partial<RemoraOptions> {}

export function apply(ctx: HostContext, _config?: unknown, options: ApplyOptions = {}): RemoraCore {
  const core = new RemoraCore(ctx, { createAdapter, ...options })
  registerRoutes(ctx, core)
  ctx.effect(() => () => { void core.dispose() }, 'dsh-remora: core')
  void core.ready.then(() => ctx.logger.info(`Remora: ready (data in ${core.dataDir})`))
  return core
}

export { RemoraCore } from './core/remora.ts'
export { detectFeatures } from './features.ts'
