import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { CONFIRMATION_TTL_MS, toBase64Url } from '@dsh-remora/protocol'
import { verifyConfirmation, type ConfirmationInput } from '../src/core/confirmation.ts'
import { coseToKeyObject, decodeCbor } from '../src/core/cose.ts'
import { cbor, makeConfirmation, makePasskey, type AssertionOptions, type Passkey } from './helpers.ts'

const hubOrigin = 'https://hub.example.com'
const rpId = 'hub.example.com'
const hostId = 'host_1'
const now = 1_800_000_000_000
const params = { hostId, command: 'ls -la', cwdWorkspaceId: 'w1' }

function base(passkey: Passkey, extra: Partial<ConfirmationInput> = {}): Omit<ConfirmationInput, 'confirmation'> {
  return { pinned: { hubOrigin, rpId, hostId, owner: [passkey.credential] }, requestId: 'req-1', operation: 'terminal.run', params, now, isUsed: () => false, ...extra }
}

const assertion = (overrides: Partial<AssertionOptions> = {}): AssertionOptions =>
  ({ hubOrigin, rpId, hostId, requestId: 'req-1', operation: 'terminal.run', params, issuedAt: now - 1000, ...overrides })

for (const kind of ['es256', 'ed25519'] as const) {
  test(`a genuine ${kind} assertion verifies`, async () => {
    const passkey = makePasskey(kind)
    const confirmation = await makeConfirmation(passkey, assertion())
    assert.deepEqual(await verifyConfirmation({ ...base(passkey), confirmation }), { ok: true })
  })

  test(`${kind}: every check fails closed`, async () => {
    const passkey = makePasskey(kind)
    const other = makePasskey(kind, passkey.credential.credentialId)
    const cases: [string, Promise<unknown>][] = [
      ['missing', verifyConfirmation({ ...base(passkey), confirmation: undefined })],
      ['unknown-credential', verifyConfirmation({ ...base(passkey), confirmation: await makeConfirmation(makePasskey(kind, 'stranger'), assertion()) })],
      ['type', verifyConfirmation({ ...base(passkey), confirmation: await makeConfirmation(passkey, assertion({ type: 'webauthn.create' })) })],
      ['origin', verifyConfirmation({ ...base(passkey), confirmation: await makeConfirmation(passkey, assertion({ origin: 'https://evil.example.com' })) })],
      ['challenge', verifyConfirmation({ ...base(passkey), params: { ...params, command: 'rm -rf /' }, confirmation: await makeConfirmation(passkey, assertion()) })],
      ['challenge', verifyConfirmation({ ...base(passkey), operation: 'job.stop', confirmation: await makeConfirmation(passkey, assertion()) })],
      ['challenge', verifyConfirmation({ ...base(passkey), requestId: 'req-2', confirmation: await makeConfirmation(passkey, assertion()) })],
      ['rp-id', verifyConfirmation({ ...base(passkey), confirmation: await makeConfirmation(passkey, assertion({ rpIdForHash: 'evil.example.com' })) })],
      ['user-presence', verifyConfirmation({ ...base(passkey), confirmation: await makeConfirmation(passkey, assertion({ flags: 0x04 })) })],
      ['user-verification', verifyConfirmation({ ...base(passkey), confirmation: await makeConfirmation(passkey, assertion({ flags: 0x01 })) })],
      ['signature', verifyConfirmation({ ...base(passkey), confirmation: await makeConfirmation(other, assertion()) })],
      ['expired', verifyConfirmation({ ...base(passkey), confirmation: await makeConfirmation(passkey, assertion({ issuedAt: now - CONFIRMATION_TTL_MS - 1 })) })],
      ['replayed', verifyConfirmation({ ...base(passkey, { isUsed: () => true }), confirmation: await makeConfirmation(passkey, assertion()) })],
    ]
    for (const [failure, result] of cases) assert.deepEqual(await result, { ok: false, failure }, failure)
  })
}

test('a tampered signature or authenticator data is rejected', async () => {
  const passkey = makePasskey('es256')
  const confirmation = await makeConfirmation(passkey, assertion())
  const bytes = Buffer.from(confirmation.assertion.authenticatorData, 'base64url')
  bytes[36] = 9
  const tampered = { ...confirmation, assertion: { ...confirmation.assertion, authenticatorData: toBase64Url(bytes) } }
  assert.deepEqual(await verifyConfirmation({ ...base(passkey), confirmation: tampered }), { ok: false, failure: 'signature' })
})

test('COSE keys: RS256 is parsed, mismatched algorithms and curves are refused', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' })
  const rsa = cbor(new Map<number, number | Uint8Array>([[1, 3], [3, -257], [-1, Buffer.from(jwk.n as string, 'base64url')], [-2, Buffer.from(jwk.e as string, 'base64url')]]))
  assert.equal(coseToKeyObject(rsa, -257).asymmetricKeyType, 'rsa')
  const ed = makePasskey('ed25519')
  assert.throws(() => coseToKeyObject(Buffer.from(ed.credential.publicKey, 'base64url'), -7))
  assert.throws(() => decodeCbor(new Uint8Array([0x5f])))
  assert.throws(() => decodeCbor(new Uint8Array([0x01, 0x02])), /trailing/)
})
