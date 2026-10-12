import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clientPolicy, isCimdClientId } from '../../src/client-policy.ts'
import { stampHostId } from '../../src/stamp.ts'
import { safeNext } from '../../src/next.ts'

const ORIGIN = 'https://hub.example.com'

test('safeNext keeps same-origin paths and refuses everything else', () => {
  assert.equal(safeNext('/settings?x=1#passkeys', ORIGIN), '/settings?x=1#passkeys')
  assert.equal(safeNext('/oauth/authorize?client_id=a%2Fb', ORIGIN), '/oauth/authorize?client_id=a%2Fb')
  for (const bad of ['/\t/evil.com', '/\n/evil.com', '//evil.com', '/\\evil.com', '\\/evil.com', 'https://evil.com', 'evil.com', '/\u0000x', '', null, '/%09/evil.com'.replace('%09', '\t')]) {
    assert.equal(safeNext(bad, ORIGIN), '/', String(bad))
  }
  // Encoded characters stay encoded and on this origin.
  assert.equal(safeNext('/%09/evil.com', ORIGIN), '/%09/evil.com')
})

test('stampHostId reaches any depth and survives cycles', () => {
  let deep: Record<string, unknown> = { hostId: 'forged' }
  for (let i = 0; i < 100; i++) deep = { nested: [deep] }
  const cyclic: Record<string, unknown> = { hostId: 'x' }
  cyclic.self = cyclic
  stampHostId({ deep, cyclic }, 'h1')
  let cursor: unknown = deep
  while ((cursor as { nested?: unknown[] }).nested) cursor = (cursor as { nested: unknown[] }).nested[0]
  assert.equal((cursor as { hostId: string }).hostId, 'h1')
  assert.equal(cyclic.hostId, 'h1')
})

test('URL client ids always go through the CIMD allowlist', () => {
  for (const id of ['https://evil.example/', 'https://evil.example', 'https://evil.example/client.json', 'http://evil.example/c', 'custom:thing']) {
    assert.equal(isCimdClientId(id), true, id)
    assert.deepEqual(clientPolicy(id, 'https://evil.example/cb', { allowOtherClients: false, dcr: true }), { allowed: false, reason: 'not-allowlisted' }, id)
  }
  assert.equal(isCimdClientId('abc123randomdcrid'), false)
  assert.deepEqual(clientPolicy('http://evil.example/c', 'http://evil.example/cb', { allowOtherClients: true, dcr: true }), { allowed: false, reason: 'not-allowlisted' })
  assert.deepEqual(clientPolicy('https://chatgpt.com/oauth/client.json', 'https://chatgpt.com/cb', { allowOtherClients: false, dcr: false }), { allowed: true })
})
