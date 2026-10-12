/**
 * Verifies the owner's passkey confirmation of a dangerous operation, exactly
 * in the order `@dsh-remora/protocol/confirmation.ts` prescribes. Only the
 * credentials pinned at pairing are trusted; nothing the hub says about keys
 * is used here.
 */
import { createHash, timingSafeEqual, verify } from 'node:crypto'
import { CONFIRMATION_TTL_MS, confirmationChallenge, fromBase64Url, type Confirmation, type OwnerCredential } from '@dsh-remora/protocol'
import { COSE_EDDSA, COSE_ES256, COSE_RS256, coseToKeyObject } from './cose.ts'

export type ConfirmationFailure =
  | 'missing'
  | 'unknown-credential'
  | 'client-data'
  | 'type'
  | 'origin'
  | 'challenge'
  | 'authenticator-data'
  | 'rp-id'
  | 'user-presence'
  | 'user-verification'
  | 'signature'
  | 'expired'
  | 'replayed'

export interface ConfirmationInput {
  confirmation: Confirmation | undefined
  pinned: { hubOrigin: string; rpId: string; hostId: string; owner: readonly OwnerCredential[] }
  requestId: string
  operation: string
  params: unknown
  now: number
  /** Whether this requestId was confirmed before. */
  isUsed: (requestId: string) => boolean
}

export type ConfirmationResult = { ok: true } | { ok: false; failure: ConfirmationFailure }

const fail = (failure: ConfirmationFailure): ConfirmationResult => ({ ok: false, failure })

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function verifyConfirmation(input: ConfirmationInput): Promise<ConfirmationResult> {
  const { confirmation, pinned } = input
  if (!confirmation || typeof confirmation !== 'object' || typeof confirmation.issuedAt !== 'number' || !confirmation.assertion) return fail('missing')
  const assertion = confirmation.assertion
  // 1. a pinned credential
  const credential = pinned.owner.find(item => item.credentialId === assertion.credentialId)
  if (!credential) return fail('unknown-credential')
  // 2. clientDataJSON
  let clientDataBytes: Uint8Array
  let clientData: { type?: unknown; origin?: unknown; challenge?: unknown; crossOrigin?: unknown }
  try {
    clientDataBytes = fromBase64Url(assertion.clientDataJSON)
    clientData = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataBytes)) as typeof clientData
    if (typeof clientData !== 'object' || clientData === null) throw new Error('not an object')
  } catch {
    return fail('client-data')
  }
  if (clientData.type !== 'webauthn.get') return fail('type')
  if (clientData.origin !== pinned.hubOrigin || clientData.crossOrigin === true) return fail('origin')
  const expected = await confirmationChallenge({
    hubOrigin: pinned.hubOrigin,
    hostId: pinned.hostId,
    requestId: input.requestId,
    operation: input.operation,
    params: input.params ?? {},
    issuedAt: confirmation.issuedAt,
  })
  if (typeof clientData.challenge !== 'string' || !sameBytes(Buffer.from(clientData.challenge), Buffer.from(expected))) return fail('challenge')
  // 3. authenticatorData
  let authData: Uint8Array
  try { authData = fromBase64Url(assertion.authenticatorData) } catch { return fail('authenticator-data') }
  if (authData.length < 37) return fail('authenticator-data')
  const rpIdHash = createHash('sha256').update(pinned.rpId, 'utf8').digest()
  if (!sameBytes(authData.subarray(0, 32), rpIdHash)) return fail('rp-id')
  const flags = authData[32] as number
  if ((flags & 0x01) === 0) return fail('user-presence')
  if ((flags & 0x04) === 0) return fail('user-verification')
  // 4. signature over authenticatorData || SHA-256(clientDataJSON)
  let signature: Uint8Array
  try { signature = fromBase64Url(assertion.signature) } catch { return fail('signature') }
  const signed = Buffer.concat([authData, createHash('sha256').update(clientDataBytes).digest()])
  try {
    const key = coseToKeyObject(fromBase64Url(credential.publicKey), credential.algorithm)
    let valid = false
    if (credential.algorithm === COSE_ES256) valid = verify('sha256', signed, { key, dsaEncoding: 'der' }, signature)
    else if (credential.algorithm === COSE_EDDSA) valid = verify(null, signed, key, signature)
    else if (credential.algorithm === COSE_RS256) valid = verify('sha256', signed, key, signature)
    if (!valid) return fail('signature')
  } catch {
    return fail('signature')
  }
  // 5. freshness and replay
  if (Math.abs(input.now - confirmation.issuedAt) > CONFIRMATION_TTL_MS) return fail('expired')
  if (input.isUsed(input.requestId)) return fail('replayed')
  return { ok: true }
}
