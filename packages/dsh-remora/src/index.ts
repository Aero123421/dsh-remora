/**
 * Remora — DSH host side.
 *
 * P0 scaffold: exposes the settings-tab state over the authenticated DSH
 * connection and reports which operations this DSH can serve. The outbound
 * hub connection, pairing and the operation handlers land next; see
 * docs/development.md for the plan.
 */
import type { HostContext } from './dsh.ts'
import { registerRoutes } from './routes.ts'
import { RemoraState } from './state.ts'

export const name = 'dsh-remora'
export const inject = ['connection']

export function apply(ctx: HostContext): void {
  const state = new RemoraState(service => ctx.get(service) !== undefined)
  registerRoutes(ctx, state)
  ctx.logger.info('Remora: settings routes ready (hub connection not configured)')
}

export { RemoraState } from './state.ts'
export { detectFeatures } from './features.ts'
