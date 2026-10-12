import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUDIT_GENESIS_HASH, INPUT_SCHEMAS, OPERATIONS, OWNER_APPROVED_OPERATIONS, REQUIRES_CONFIRMATION, auditHash, canonicalJson, confirmationChallenge, findOperation,
  formatUserCode, fromBase64Url, normalizeUserCode, pairPollMessage, sha256, toBase64Url, validateParams, verifyAuditRecords, type AuditRecord, type OperationSpec,
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

test('schedules take exactly one timing shape', () => {
  const base = { sessionId: 's', title: 'Daily check', prompt: 'Check CI', idempotencyKey: 'k' }
  assert.deepEqual(validateParams('schedule.create', { ...base, when: { daily: { time: '09:00', timeZone: 'Asia/Tokyo' } } }), [])
  assert.deepEqual(validateParams('schedule.create', { ...base, when: { weekly: { time: '18:30:00', timeZone: 'UTC', weekdays: [1, 5] } } }), [])
  assert.deepEqual(validateParams('schedule.create', { ...base, when: { at: '2026-10-13T09:00:00+09:00' } }), [])
  assert.deepEqual(validateParams('schedule.create', { ...base, when: { cron: { expression: '0 9 * * 1-5', timeZone: 'Asia/Tokyo' } } }), [])
  assert.ok(validateParams('schedule.create', { ...base, when: { afterSeconds: 60, everySeconds: 60 } }).length > 0)
  assert.ok(validateParams('schedule.create', { ...base, when: { everySeconds: 30 } }).length > 0)
  assert.ok(validateParams('schedule.create', { ...base, when: { daily: { time: '25:00', timeZone: 'UTC' } } }).length > 0)
  assert.ok(validateParams('schedule.create', { ...base, when: { weekly: { time: '09:00', timeZone: 'UTC', weekdays: [0] } } }).length > 0)
  assert.ok(validateParams('schedule.create', { ...base, idempotencyKey: undefined, when: { afterSeconds: 60 } }).length > 0)
  assert.deepEqual(validateParams('terminal.run', { command: 'git status', cwdWorkspaceId: 'w1', timeoutMs: 5000 }), [])
  assert.ok(validateParams('terminal.run', { command: 'ls' }).length > 0)
  assert.deepEqual(validateParams('confirmation.get', { confirmationId: 'h-1', timeoutMs: 25_000 }), [])
  assert.deepEqual(validateParams('sessions.search', { query: 'migration plan', limit: 10 }), [])
  assert.deepEqual(validateParams('session.fork', { sessionId: 's', atTurn: 3, title: 'Try B' }), [])
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
  assert.ok(!REQUIRES_CONFIRMATION.has('job.stop'))
  assert.ok(!REQUIRES_CONFIRMATION.has('schedule.create'))
  assert.ok(!REQUIRES_CONFIRMATION.has('approval.respond'))
  assert.ok(!REQUIRES_CONFIRMATION.has('task.start'))
})

test('pairing helpers', () => {
  assert.equal(pairPollMessage('https://hub.example', 'p1'), 'remora-pair/v1\nhttps://hub.example\np1')
  assert.equal(formatUserCode('ABCD2345'), 'ABCD-2345')
  assert.equal(normalizeUserCode(' abcd-2345 '), 'ABCD2345')
})

test('audit chains: a changed, removed or reordered row breaks the chain', async () => {
  const fields = (n: number) => ({ at: n, actor: 'owner', actorName: 'オーナー', operation: `op.${n}`, hostId: null, outcome: 'ok' as const, layer: null, reason: null })
  const records: AuditRecord[] = []
  let prev = AUDIT_GENESIS_HASH
  for (let seq = 1; seq <= 4; seq++) {
    const hash = await auditHash(seq, fields(seq), prev)
    records.push({ seq, ...fields(seq), prevHash: prev, hash })
    prev = hash
  }
  assert.equal(await verifyAuditRecords(records), null)
  assert.equal(await verifyAuditRecords(records.slice(2)), null, 'a pruned head is fine')
  assert.equal(await verifyAuditRecords([...records].reverse()), null, 'order of the input does not matter')
  assert.equal(await verifyAuditRecords(records.map(r => (r.seq === 2 ? { ...r, actorName: 'someone else' } : r))), 2)
  assert.equal(await verifyAuditRecords(records.filter(r => r.seq !== 3)), 4)
  assert.equal(await verifyAuditRecords([]), null)
  assert.ok(OWNER_APPROVED_OPERATIONS.has('audit.export') && OWNER_APPROVED_OPERATIONS.has('host.rotate-key'))
  for (const id of OWNER_APPROVED_OPERATIONS) assert.equal(findOperation(id)?.tool, undefined, `${id} is not an MCP tool`)
})
