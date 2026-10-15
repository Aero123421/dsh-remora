/**
 * How long the signed-in owner's full grant stays valid.
 * Ordinary owner operations keep the short grant. `terminal.run` covers the
 * command's own timeout plus the same slack the relay uses, and still expires.
 */
import type { Grant } from './vendor/protocol/index.ts'

export const OWNER_GRANT_MS = 60_000
/** Matches the confirmed-run relay slack in the host Durable Object. */
export const OWNER_GRANT_GRACE_MS = 30_000
const TERMINAL_TIMEOUT_MIN_MS = 1_000
const TERMINAL_TIMEOUT_MAX_MS = 600_000

export function ownerGrant(now = Date.now(), holdMs = OWNER_GRANT_MS): Grant {
  return { level: 'full', fullAccessExpiresAt: now + holdMs }
}

/** Owner grant for one operation. Client grants are chosen elsewhere. */
export function ownerGrantFor(op: string, params: Record<string, unknown> | undefined, now = Date.now()): Grant {
  if (op !== 'terminal.run') return ownerGrant(now)
  const raw = params && typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) ? params.timeoutMs : OWNER_GRANT_MS
  const timeoutMs = Math.min(TERMINAL_TIMEOUT_MAX_MS, Math.max(TERMINAL_TIMEOUT_MIN_MS, raw))
  return ownerGrant(now, timeoutMs + OWNER_GRANT_GRACE_MS)
}
