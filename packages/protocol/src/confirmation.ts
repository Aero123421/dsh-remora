/**
 * End-to-end confirmation of dangerous operations with the owner's passkey.
 *
 * The hub UI asks the browser for a WebAuthn assertion whose challenge is
 * `confirmationChallenge(...)`. The hub forwards the assertion inside the
 * request frame; the DSH plugin verifies it against the owner credentials it
 * pinned at pairing. A compromised hub can neither forge the assertion nor
 * reuse it for another host, request, operation or set of parameters.
 *
 * The plugin MUST check, in order:
 *   1. `credentialId` is one of the pinned owner credentials.
 *   2. clientDataJSON: type === 'webauthn.get', origin === pinned hubOrigin,
 *      challenge === confirmationChallenge(recomputed from the request).
 *   3. authenticatorData: rpIdHash === SHA-256(pinned rpId); flags UP (0x01)
 *      and UV (0x04) are set.
 *   4. The signature over authenticatorData || SHA-256(clientDataJSON)
 *      verifies with the pinned COSE key.
 *   5. `issuedAt` is within CONFIRMATION_TTL_MS of now, and the requestId has
 *      not been confirmed before.
 *
 * `params` in the subject is exactly the `params` object of the request frame
 * (after the hub filled in `hostId`), or `{}` when the frame has none. The hub
 * UI must therefore send the final params, hostId included, when it asks for
 * the challenge, and the request frame id must equal `requestId`.
 */
import { canonicalJson, sha256, toBase64Url } from './encoding.ts'
import { OPERATIONS } from './operations.ts'

export const CONFIRMATION_TTL_MS = 5 * 60_000

export interface WebAuthnAssertion {
  credentialId: string
  authenticatorData: string
  clientDataJSON: string
  signature: string
  userHandle?: string | null
}

export interface Confirmation {
  issuedAt: number
  assertion: WebAuthnAssertion
}

export interface ConfirmationSubject {
  hubOrigin: string
  hostId: string
  requestId: string
  operation: string
  params: unknown
  issuedAt: number
}

/** base64url SHA-256 of the canonical subject: the WebAuthn challenge. */
export async function confirmationChallenge(subject: ConfirmationSubject): Promise<string> {
  return toBase64Url(await sha256(`remora-confirm/v1\n${canonicalJson(subject)}`))
}

/** Operations that need a passkey confirmation in addition to an unexpired full grant. */
export const REQUIRES_CONFIRMATION: ReadonlySet<string> = new Set(
  (OPERATIONS as readonly { id: string; level: string }[]).filter(op => op.level === 'full').map(op => op.id),
)

/**
 * Needs a passkey confirmation unless the DSH settings tab allows it from
 * MCP and CLI. The DSH host decides (it knows the setting); the hub always
 * collects a confirmation when the owner answers on the hub's own page.
 */
export const CONFIRMATION_UNLESS_ALLOWED: ReadonlySet<string> = new Set(['approval.respond'])

/**
 * Hub maintenance the owner approves on the hub for every call (passkey
 * re-authentication, checked by the hub; nothing a DSH host could verify is
 * at stake). A client's call is parked like a REQUIRES_CONFIRMATION one and
 * answered through confirmation.get.
 */
export const OWNER_APPROVED_OPERATIONS: ReadonlySet<string> = new Set(['audit.export', 'hub.export', 'host.rotate-key'])
