/** Request routing for the hub Worker. Pure, so it can be tested without the Workers runtime. */

export type Route =
  | { kind: 'home' }
  | { kind: 'health' }
  | { kind: 'mcp' }
  | { kind: 'api'; path: string }
  | { kind: 'oauth'; path: string }
  | { kind: 'host-socket'; hostId: string }
  | { kind: 'not-found' }
  | { kind: 'method-not-allowed'; allow: string }

/** Host ids are minted by the hub at pairing time: URL-safe and bounded. */
export const HOST_ID = /^[A-Za-z0-9_-]{8,64}$/

export function route(method: string, pathname: string): Route {
  if (pathname === '/') return method === 'GET' || method === 'HEAD' ? { kind: 'home' } : { kind: 'method-not-allowed', allow: 'GET, HEAD' }
  if (pathname === '/healthz') return { kind: 'health' }
  if (pathname === '/mcp') return { kind: 'mcp' }
  if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) return { kind: 'api', path: pathname.slice('/api/v1'.length) || '/' }
  if (pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/oauth-')) return { kind: 'oauth', path: pathname }
  const socket = /^\/ws\/host\/([^/]+)$/.exec(pathname)
  if (socket) {
    const hostId = socket[1] ?? ''
    if (!HOST_ID.test(hostId)) return { kind: 'not-found' }
    return method === 'GET' ? { kind: 'host-socket', hostId } : { kind: 'method-not-allowed', allow: 'GET' }
  }
  return { kind: 'not-found' }
}
