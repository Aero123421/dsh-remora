/**
 * The small slice of the DSH (Cordis) host context this plugin touches.
 * DSH packages are not installed as dependencies. Lifecycle and authenticated
 * settings-route APIs live here; operation services live in adapter/dsh-types.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

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
  on(event: 'connection/request', listener: (request: IncomingMessage, response: ServerResponse, next: () => Promise<void>) => Promise<void>, options?: { prepend?: boolean; global?: boolean }): () => void
  effect(setup: () => () => void | Promise<void>, label?: string): void
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

/** Built into dist by esbuild's `define`; absent when tests run the TypeScript source. */
declare const __REMORA_VERSION__: string | undefined

export const PLUGIN_VERSION: string = typeof __REMORA_VERSION__ === 'string' ? __REMORA_VERSION__ : '0.0.0-dev'
