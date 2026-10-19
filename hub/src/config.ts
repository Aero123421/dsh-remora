import { AUDIT_KEPT_ROWS } from './vendor/protocol/index.ts'
/**
 * Settings that come from secrets and variables (never from wrangler.jsonc,
 * so the upstream-sync pull request never conflicts), plus fixed limits.
 */

export interface HubSecrets {
  /** One-time secret for registering the first passkey. Disabled for good afterwards. */
  SETUP_TOKEN?: string
  /** `true` turns on RFC 7591 dynamic client registration (off by default). */
  ENABLE_DCR?: string
  /** Optional canonical origin, e.g. `https://remora.example.com`. Defaults to the request origin. */
  HUB_ORIGIN?: string
}

export function secrets(env: Env): HubSecrets {
  return env as unknown as HubSecrets
}

export function dcrEnabled(env: Env): boolean {
  return secrets(env).ENABLE_DCR === 'true'
}

/** The hub's own origin: the configured one, or the origin the request reached. */
export function hubOrigin(request: Request, env: Env): string {
  const configured = secrets(env).HUB_ORIGIN
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      // fall through to the request origin
    }
  }
  return new URL(request.url).origin
}

export { OWNER_CLIENT_ID } from './vendor/protocol/index.ts'
/** Audit rows kept per log (hub and each host); older rows are dropped. */
export const AUDIT_MAX_ROWS = AUDIT_KEPT_ROWS

export const SESSION_COOKIE = '__Host-remora_sid'
/** Sessions end after this long without a request. */
export const SESSION_IDLE_MS = 30 * 60_000
/** …and after this long regardless. */
export const SESSION_MAX_MS = 12 * 60 * 60_000
/** A passkey re-authentication covers sensitive actions for this long. */
export const REAUTH_WINDOW_MS = 5 * 60_000
export const CHALLENGE_TTL_MS = 5 * 60_000

export const RECOVERY_CODE_COUNT = 10
/** Remote full access granted on the hub lapses after this long. */
export const FULL_ACCESS_MS = 24 * 60 * 60_000

/** OAuth lifetimes (seconds). */
export const ACCESS_TOKEN_TTL_S = 60 * 60
export const REFRESH_TOKEN_TTL_S = 90 * 24 * 60 * 60
export const REFRESH_TOKEN_IDLE_TTL_S = 30 * 24 * 60 * 60

export const DEVICE_CODE_TTL_MS = 10 * 60_000
export const DEVICE_POLL_INTERVAL_S = 5

/** Parked tasks (host offline) fail after this long. */
export const PARKED_TASK_TTL_MS = 60 * 60_000
/** Default wait for a relayed request. */
export const RELAY_TIMEOUT_MS = 20_000

/** Cloudflare free plan, per UTC day. */
export const FREE_TIER = { workerRequests: 100_000, durableObjectRequests: 100_000, kvWrites: 1_000 } as const
export const FREE_TIER_WARN = 0.8

/** Rate limits: [max events, window in seconds]. */
export const RATE_LIMITS = {
  login: [20, 600],
  setup: [10, 600],
  pairStart: [10, 3600],
  pairPoll: [600, 600],
  unpair: [30, 3600],
  deviceAuthorization: [20, 600],
  token: [120, 600],
  dcr: [10, 3600],
  apiPerClient: [600, 60],
} as const satisfies Record<string, readonly [number, number]>

export type RateLimitName = keyof typeof RATE_LIMITS

/** Where the plugin, the CLI and their install scripts are published. */
export const RELEASES_URL = 'https://github.com/Aero123421/dsh-remora/releases'
