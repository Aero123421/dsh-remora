/**
 * The small slice of the DSH (Cordis) host context this plugin touches.
 * DSH packages are not installed as dependencies; these local types keep the
 * plugin compiling on its own and make every DSH touch point visible in one
 * file. Only the adapter layer may grow this list.
 */

export interface FetchRoute {
  path: string
  methods: string[]
  requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}

export interface HostContext {
  /** Authenticated routes: only reachable through an authenticated DSH Web connection. */
  connection: { fetch: { register(route: FetchRoute): unknown } }
  /** Look up an optional service without requiring it. */
  get(name: string): unknown
  effect(setup: () => () => void, label?: string): void
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

/** Built into dist by esbuild's `define`; absent when tests run the TypeScript source. */
declare const __REMORA_VERSION__: string | undefined

export const PLUGIN_VERSION: string = typeof __REMORA_VERSION__ === 'string' ? __REMORA_VERSION__ : '0.0.0-dev'
