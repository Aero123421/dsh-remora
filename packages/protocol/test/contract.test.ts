import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  INPUT_SCHEMAS, OPERATIONS, REQUIRES_CONFIRMATION, canonicalJson, confirmationChallenge, formatUserCode,
  fromBase64Url, normalizeUserCode, pairPollMessage, sha256, toBase64Url, validateParams, type OperationSpec,
} from '../src/index.ts'

test('every operation has an input schema that rejects unknown fields', () => {
  for (const op of OPERATIONS as readonly OperationSpec[]) {
    const schema = INPUT_SCHEMAS[op.id as keyof typeof INPUT_SCHEMAS]
    assert.ok(schema, op.id)
    assert.equal(schema.additionalProperties, false, op.id)
  }
})

test('task.start params', () => {
  const ok = { target: { sessionId: 's1' }, prompt: 'Fix the bug', skills: ['code-review'], idempotencyKey: 'k1' }
  assert.deepEqual(validateParams('task.start', ok), [])
  assert.deepEqual(validateParams('task.start', { ...ok, target: { latest: true } }), [])
  assert.deepEqual(validateParams('task.start', { ...ok, target: { new: { workspaceId: 'w1', agentPreset: 'ptc' } } }), [])
  assert.ok(validateParams('task.start', { ...ok, idempotencyKey: undefined }).some(issue => issue.path === '$.idempotencyKey'))
  assert.ok(validateParams('task.start', { ...ok, target: { latest: false } }).length > 0)
  assert.ok(validateParams('task.start', { ...ok, target: { sessionId: 's1', title: 'x' } }).length > 0)
  assert.ok(validateParams('task.start', { ...ok, extra: 1 }).some(issue => issue.message === 'is not allowed'))
})

test('patterns guard folder names, git URLs and slash commands', () => {
  const base = { placementId: 'p1', idempotencyKey: 'k' }
  assert.deepEqual(validateParams('workspace.create', { ...base, name: 'my-app', gitUrl: 'https://github.com/a/b.git' }), [])
  assert.ok(validateParams('workspace.create', { ...base, name: '../escape' }).length > 0)
  assert.ok(validateParams('workspace.create', { ...base, name: 'ok', gitUrl: 'git@github.com:a/b.git' }).length > 0)
  assert.deepEqual(validateParams('command.run', { sessionId: 's', command: '/compact' }), [])
  assert.ok(validateParams('command.run', { sessionId: 's', command: 'rm -rf /' }).length > 0)
  assert.ok(validateParams('task.wait', { taskId: 't', timeoutMs: 60_000 }).length > 0)
})

test('base64url and canonical JSON', async () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255])
  assert.deepEqual(fromBase64Url(toBase64Url(bytes)), bytes)
  assert.throws(() => fromBase64Url('a+b/'))
  assert.equal(canonicalJson({ b: 1, a: [true, null, { d: 'x', c: undefined }] }), '{"a":[true,null,{"d":"x"}],"b":1}')
  assert.equal(toBase64Url(await sha256('abc')), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0')
})

test('confirmation challenges bind every field', async () => {
  const subject = { hubOrigin: 'https://hub.example', hostId: 'h1', requestId: 'r1', operation: 'terminal.run', params: { command: 'ls' }, issuedAt: 1 }
  const challenge = await confirmationChallenge(subject)
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(await confirmationChallenge({ ...subject, params: { command: 'ls' } }), challenge)
  for (const change of [{ hostId: 'h2' }, { requestId: 'r2' }, { params: { command: 'rm' } }, { issuedAt: 2 }, { hubOrigin: 'https://evil.example' }]) {
    assert.notEqual(await confirmationChallenge({ ...subject, ...change }), challenge)
  }
  assert.ok(REQUIRES_CONFIRMATION.has('terminal.run'))
  assert.ok(!REQUIRES_CONFIRMATION.has('task.start'))
})

test('pairing helpers', () => {
  assert.equal(pairPollMessage('https://hub.example', 'p1'), 'remora-pair/v1\nhttps://hub.example\np1')
  assert.equal(formatUserCode('ABCD2345'), 'ABCD-2345')
  assert.equal(normalizeUserCode(' abcd-2345 '), 'ABCD2345')
})
