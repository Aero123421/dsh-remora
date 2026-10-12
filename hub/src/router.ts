/** Request routing for the hub Worker. Pure, so it can be tested without the Workers runtime. */
import { ENDPOINTS } from './vendor/protocol/endpoints.ts'

export type Route =
  | { kind: 'health' }
  | { kind: 'host-socket'; hostId: string }
  | { kind: 'pair-start' }
  | { kind: 'pair-poll' }
  | { kind: 'host-unpair' }
  | { kind: 'pair-approve' }
  | { kind: 'auth'; path: string }
  | { kind: 'mcp' }
  | { kind: 'api'; path: string }
  | { kind: 'oauth'; path: string }
  | { kind: 'ui' }
  | { kind: 'not-found' }
  | { kind: 'method-not-allowed'; allow: string }

/** Host ids are minted by the hub at pairing time: URL-safe and bounded. */
export const HOST_ID = /^[A-Za-z0-9_-]{8,64}$/

export function route(method: string, pathname: string): Route {
  if (pathname === ENDPOINTS.health) return { kind: 'health' }
  if (pathname === ENDPOINTS.mcp) return { kind: 'mcp' }
  if (pathname === '/api/v1' || pathname.startsWith('/api/v1/')) return { kind: 'api', path: pathname.slice('/api/v1'.length) || '/' }
  if (pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/oauth-') || pathname === ENDPOINTS.deviceVerify) return { kind: 'oauth', path: pathname }
  if (pathname === ENDPOINTS.pairStart) return method === 'POST' ? { kind: 'pair-start' } : { kind: 'method-not-allowed', allow: 'POST' }
  if (pathname === ENDPOINTS.pairPoll) return method === 'POST' ? { kind: 'pair-poll' } : { kind: 'method-not-allowed', allow: 'POST' }
  if (pathname === ENDPOINTS.hostUnpair) return method === 'POST' ? { kind: 'host-unpair' } : { kind: 'method-not-allowed', allow: 'POST' }
  if (pathname === ENDPOINTS.pairApprove) return method === 'GET' || method === 'POST' || method === 'HEAD' ? { kind: 'pair-approve' } : { kind: 'method-not-allowed', allow: 'GET, POST' }
  if (pathname.startsWith('/auth/')) return { kind: 'auth', path: pathname }
  const socket = /^\/ws\/host\/([^/]+)$/.exec(pathname)
  if (socket) {
    const hostId = socket[1] ?? ''
    if (!HOST_ID.test(hostId)) return { kind: 'not-found' }
    return method === 'GET' ? { kind: 'host-socket', hostId } : { kind: 'method-not-allowed', allow: 'GET' }
  }
  if (pathname.startsWith('/ws/')) return { kind: 'not-found' }
  return { kind: 'ui' }
}
