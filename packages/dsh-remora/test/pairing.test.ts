import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verify, createPublicKey } from 'node:crypto'
import { pairPollMessage } from '@dsh-remora/protocol'
import { HostKey, HostKeyStore, HOST_KEY_RECORD, type CredentialsLike } from '../src/core/hostkey.ts'
import { PairingClient, normalizeHubUrl, rpIdMatches, type FetchLike, type PairingView } from '../src/core/pairing.ts'
import { makePasskey, tempDir, until } from './helpers.ts'

const origin = 'https://hub.example.com'

function hubFetch(approval: (pairingId: string) => unknown, start: Record<string, unknown> = {}): { fetch: FetchLike; signaturesOk: () => boolean } {
  let publicKey = ''
  let ok = true
  const fetch: FetchLike = async (url, init) => {
    const input = JSON.parse(init.body) as Record<string, string>
    if (url === `${origin}/pair/start`) {
      publicKey = input.publicKey as string
      return Response.json({ pairingId: 'p1', userCode: 'WXYZ2345', verifyUrl: `${origin}/pair?code=WXYZ-2345`, expiresAt: Date.now() + 60_000, pollIntervalMs: 1000, ...start })
    }
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' })
    ok &&= verify(null, Buffer.from(pairPollMessage(origin, input.pairingId as string)), key, Buffer.from(input.signature as string, 'base64url'))
    return Response.json(approval(input.pairingId as string))
  }
  return { fetch, signaturesOk: () => ok }
}

function client(fetch: FetchLike, onApproved: (pairing: unknown, key: HostKey) => Promise<void> = async () => {}) {
  const views: PairingView[] = []
  const pairing = new PairingClient({ fetch, sleep: () => new Promise(resolve => setTimeout(resolve, 1)), onApproved, onChange: view => views.push(view) })
  return { pairing, views }
}

test('hub URLs: https only (loopback http for development), reduced to the origin', () => {
  assert.equal(normalizeHubUrl('https://hub.example.com/path?x'), 'https://hub.example.com')
  assert.equal(normalizeHubUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787')
  assert.throws(() => normalizeHubUrl('http://hub.example.com'))
  assert.throws(() => normalizeHubUrl('https://user:pw@hub.example.com'))
  assert.equal(rpIdMatches('https://hub.example.com', 'example.com'), true)
  assert.equal(rpIdMatches('https://hub.example.com', 'evil.com'), false)
})

test('an approved pairing is handed over with the signing key', async () => {
  const owner = [makePasskey('es256').credential]
  const hub = hubFetch(() => ({ status: 'approved', hostId: 'h1', hubOrigin: origin, rpId: 'hub.example.com', owner }))
  let approved: { hostId?: string } = {}
  let usedKey: HostKey | undefined
  const { pairing } = client(hub.fetch, async (p, key) => { approved = p as { hostId: string }; usedKey = key })
  const view = await pairing.start(origin, 'pc', '1.0.0')
  assert.equal(view.userCode, 'WXYZ-2345')
  await until(() => pairing.view.phase === 'approved', 2000, 'approval')
  assert.equal(approved.hostId, 'h1')
  assert.ok(usedKey)
  assert.equal(hub.signaturesOk(), true)
})

test('approvals that do not match the hub are refused', async () => {
  const owner = [makePasskey('ed25519').credential]
  for (const [answer, code] of [
    [{ status: 'approved', hostId: 'h1', hubOrigin: 'https://other.example.com', rpId: 'hub.example.com', owner }, 'invalid-response'],
    [{ status: 'approved', hostId: 'h1', hubOrigin: origin, rpId: 'evil.com', owner }, 'invalid-response'],
    [{ status: 'approved', hostId: 'h1', hubOrigin: origin, rpId: 'hub.example.com', owner: [] }, 'invalid-response'],
    [{ status: 'approved', hostId: 'h1', hubOrigin: origin, rpId: 'hub.example.com', owner: [{ ...owner[0], algorithm: -999 }] }, 'invalid-response'],
  ] as const) {
    let called = false
    const { pairing } = client(hubFetch(() => answer).fetch, async () => { called = true })
    await pairing.start(origin, 'pc', '1')
    await until(() => pairing.view.phase === 'error', 2000, 'error')
    assert.equal(pairing.view.error, code)
    assert.equal(called, false)
  }
  const offsite = client(hubFetch(() => ({ status: 'pending' }), { verifyUrl: 'https://phish.example.com/pair' }).fetch)
  assert.equal((await offsite.pairing.start(origin, 'pc', '1')).phase, 'error')
})

test('cancelling stops polling', async () => {
  let polls = 0
  const { pairing } = client(hubFetch(() => { polls++; return { status: 'pending' } }).fetch)
  await pairing.start(origin, 'pc', '1')
  await until(() => polls > 2, 2000, 'polls')
  pairing.cancel()
  const seen = polls
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(polls <= seen + 1)
  assert.equal(pairing.view.phase, 'cancelled')
})

test('host keys are stored in DSH credentials when available, else in a 0600 file', async () => {
  const records = new Map<string, unknown>()
  const credentials: CredentialsLike = {
    readRecord: async key => records.get(key) as never,
    modifyRecord: async (key, mutate) => { const next = await mutate(records.get(key)); if (next) records.set(key, next); return next },
    deleteRecord: async key => { records.delete(key) },
  }
  const t = await tempDir()
  try {
    const store = new HostKeyStore(t.dir, credentials)
    assert.equal(store.location, 'credentials')
    assert.equal(await store.load(), null)
    const key = HostKey.generate()
    await store.save(key)
    assert.ok(records.has(HOST_KEY_RECORD))
    const loaded = await store.load()
    assert.equal(loaded?.publicKey, key.publicKey)
    assert.equal(loaded?.sign('m'), key.sign('m'), 'Ed25519 signatures are deterministic')
    await store.delete()
    assert.equal(await store.load(), null)
    const fileStore = new HostKeyStore(t.dir, undefined)
    await fileStore.save(key)
    assert.equal((await fileStore.load())?.publicKey, key.publicKey)
  } finally { await t.cleanup() }
})
