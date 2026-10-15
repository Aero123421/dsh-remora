import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OWNER_GRANT_GRACE_MS, OWNER_GRANT_MS, ownerGrant, ownerGrantFor } from '../../src/owner-grant.ts'

test('owner terminal grants cover the command timeout and still expire', () => {
  const now = 1_000_000
  assert.equal(ownerGrant(now).fullAccessExpiresAt, now + OWNER_GRANT_MS)
  assert.equal(ownerGrantFor('sessions.list', {}, now).fullAccessExpiresAt, now + OWNER_GRANT_MS)
  assert.equal(ownerGrantFor('terminal.run', { timeoutMs: 120_000 }, now).fullAccessExpiresAt, now + 120_000 + OWNER_GRANT_GRACE_MS)
  assert.equal(ownerGrantFor('terminal.run', { timeoutMs: 600_000 }, now).fullAccessExpiresAt, now + 600_000 + OWNER_GRANT_GRACE_MS)
  assert.equal(ownerGrantFor('terminal.run', { timeoutMs: 9_999_000 }, now).fullAccessExpiresAt, now + 600_000 + OWNER_GRANT_GRACE_MS)
  assert.equal(ownerGrantFor('terminal.run', { timeoutMs: 1 }, now).fullAccessExpiresAt, now + 1_000 + OWNER_GRANT_GRACE_MS)
  assert.equal(ownerGrantFor('terminal.run', {}, now).fullAccessExpiresAt, now + OWNER_GRANT_MS + OWNER_GRANT_GRACE_MS)
  assert.ok(Number.isFinite(ownerGrantFor('terminal.run', { timeoutMs: 120_000 }, now).fullAccessExpiresAt))
})
