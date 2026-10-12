/** Hub URL paths and HTTP conventions shared by the hub, the plugin and the CLI. */
import type { ErrorCode, RemoraError } from './errors.ts'

export const ENDPOINTS = {
  health: '/healthz',
  /** HTTP API: POST /api/v1/ops/<operationId> with the params as the JSON body. */
  ops: '/api/v1/ops/',
  mcp: '/mcp',
  pairStart: '/pair/start',
  pairPoll: '/pair/poll',
  /** Owner-facing approval page: GET /pair?code=XXXX-XXXX */
  pairApprove: '/pair',
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  /** RFC 7009 token revocation (also advertised as `revocation_endpoint`). */
  revocation: '/oauth/revoke',
  /** A paired host removes itself (signed with its host key; see pairing.ts `unpairMessage`). */
  hostUnpair: '/pair/unpair',
  /** RFC 8628 device authorization (CLI over SSH). */
  deviceAuthorization: '/oauth/device_authorization',
  /** Owner-facing page where a device code is entered. */
  deviceVerify: '/device',
  authorizationServerMetadata: '/.well-known/oauth-authorization-server',
  protectedResourceMetadata: '/.well-known/oauth-protected-resource',
} as const

/**
 * OAuth resource indicators (RFC 8707). Tokens are bound to one audience:
 * MCP tokens do not work on the HTTP API and the other way round.
 */
export function resourceIndicators(hubOrigin: string): { mcp: string; api: string } {
  return { mcp: `${hubOrigin}/mcp`, api: `${hubOrigin}/api/v1/ops` }
}

/** Names of release assets on GitHub Releases. */
export const RELEASE_ASSETS = {
  plugin: (version: string) => `dsh-remora-${version}.tgz`,
  cli: (platform: string, arch: string) => `remora-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`,
  checksums: 'SHA256SUMS',
  installSh: 'install.sh',
  installPs1: 'install.ps1',
} as const

export function hostSocketPath(hostId: string): string {
  return `/ws/host/${hostId}`
}

/** The CLI is a public OAuth client registered by the hub itself (loopback redirect + PKCE, or device code). */
export const CLI_CLIENT_ID = 'remora-cli'

/** Body of every non-2xx HTTP API response. */
export interface HttpErrorBody { error: RemoraError }

export const HTTP_STATUS_FOR_ERROR: Readonly<Record<ErrorCode, number>> = {
  denied: 403,
  invalid_request: 400,
  not_found: 404,
  gone: 410,
  conflict: 409,
  unavailable: 503,
  host_offline: 503,
  rate_limited: 429,
  protocol_mismatch: 426,
  internal: 500,
}
