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

test('attention helpers: answer urls, routes and push text', async () => {
  const { answerRoute, answerUrl, pushText, stampAnswerUrls, countdownText } = await import('../../src/attention.ts')
  assert.equal(answerUrl('https://hub.example.com', 'habc', 'approval:7/x'), 'https://hub.example.com/attention/habc/approval%3A7%2Fx')
  const result = { items: [{ attentionId: 'q1', hostId: 'h1', sessionId: 's', kind: 'question', title: 't', answerable: true, createdAt: null }], task: { attention: [{ attentionId: 'a1', hostId: 'h1', sessionId: 's', kind: 'approval', title: 't', answerable: false, createdAt: null }] }, other: { attentionId: 'x', kind: 'nope' } }
  stampAnswerUrls(result, 'https://hub.example.com')
  assert.equal((result.items[0] as { answerUrl?: string }).answerUrl, 'https://hub.example.com/attention/h1/q1')
  assert.equal((result.task.attention[0] as { answerUrl?: string }).answerUrl, 'https://hub.example.com/attention/h1/a1')
  assert.equal((result.other as { answerUrl?: string }).answerUrl, undefined)
  const now = 1_000_000
  assert.equal(answerRoute({ kind: 'approval', answerable: true, answerVia: 'hub-passkey', expiresAt: now + 1 }, now), 'passkey')
  assert.equal(answerRoute({ kind: 'approval', answerable: true, answerVia: 'hub-passkey', expiresAt: now }, now), 'expired')
  assert.equal(answerRoute({ kind: 'approval', answerable: false, answerVia: 'dsh-web' }, now), 'dsh-web')
  assert.equal(answerRoute({ kind: 'question', answerable: false, answerVia: 'remote' }, now), 'remote')
  assert.equal(answerRoute({ kind: 'question', answerable: false }, now), 'dsh-web')
  assert.equal(answerRoute({ kind: 'plan-review', answerable: true }, now), 'remote')
  assert.equal(answerRoute({ kind: 'goal-stopped', answerable: true, answerVia: 'remote' }, now), 'dsh-web')
  assert.equal(countdownText(now + 125_000, now), 'あと 2 分 05 秒')
  assert.equal(countdownText(now - 1, now), '期限切れ')
  assert.equal(pushText('Approve shell:\n rm -rf  build'), 'Approve shell: rm -rf build')
  assert.equal(pushText('token sk-abcdefghijklmnop and ghp_1234567890abcdef please'), 'token ••• and ••• please')
  assert.equal(Array.from(pushText('あ'.repeat(200))).length, 80)
})
