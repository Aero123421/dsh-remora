import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ceilingAllows, fullAccessActive, wideningReasons } from '../src/core/permissions.ts'
import { defaultSettings, type RemoraSettings } from '../src/core/settings.ts'

const now = 1_000_000

function withScope(settings: RemoraSettings, scope: Partial<RemoraSettings['scope']>): RemoraSettings {
  return { ...settings, scope: { ...settings.scope, ...scope } }
}

test('the ceiling follows decide: levels, switches and full-access expiry', () => {
  const view = ceilingAllows({ level: 'view' }, now)
  assert.ok(view.has('sessions.list'))
  assert.ok(!view.has('task.start'))
  const custom = ceilingAllows({ level: 'view', overrides: { 'task.start': true, 'sessions.list': false } }, now)
  assert.ok(custom.has('task.start'))
  assert.ok(!custom.has('sessions.list'))
  const switchedFull = ceilingAllows({ level: 'request', overrides: { 'terminal.run': true } }, now)
  assert.ok(!switchedFull.has('terminal.run'), 'dangerous operations need an unexpired full ceiling')
  assert.ok(ceilingAllows({ level: 'full', fullAccessExpiresAt: now + 1 }, now).has('terminal.run'))
  assert.ok(!ceilingAllows({ level: 'full', fullAccessExpiresAt: now }, now).has('terminal.run'))
  assert.equal(fullAccessActive({ level: 'full', fullAccessExpiresAt: now - 1 }, now), false)
})

test('raising, full access and widening the scope are reported; lowering is not', () => {
  const base = defaultSettings()
  assert.deepEqual(wideningReasons(base, base, now), [])
  assert.deepEqual(wideningReasons(base, { ...base, ceiling: { level: 'request' } }, now), ['operations'])
  assert.deepEqual(wideningReasons({ ...base, ceiling: { level: 'request' } }, base, now), [])
  const full = { ...base, ceiling: { level: 'full' as const, fullAccessExpiresAt: now + 10 } }
  assert.ok(wideningReasons(base, full, now).includes('full-access'))
  assert.ok(wideningReasons(full, { ...full, ceiling: { ...full.ceiling, fullAccessExpiresAt: now + 20 } }, now).includes('full-access'))
  assert.deepEqual(wideningReasons({ ...base, killSwitch: false }, { ...base, killSwitch: true }, now), [])
  assert.deepEqual(wideningReasons({ ...base, killSwitch: true }, base, now), ['kill-switch'])
  assert.deepEqual(wideningReasons(base, withScope(base, { workspaces: ['w1'] }), now), ['workspaces'])
  assert.deepEqual(wideningReasons(withScope(base, { workspaces: ['w1'] }), base, now), [])
  assert.deepEqual(wideningReasons(base, withScope(base, { aliases: { a: 's' } }), now), [])
  assert.deepEqual(wideningReasons(withScope(base, { exceptions: [{ sessionId: 's', allow: false }] }), base, now), ['exceptions'])
  assert.deepEqual(wideningReasons(base, withScope(base, { exceptions: [{ sessionId: 's', allow: false }] }), now), [])
  assert.deepEqual(wideningReasons(withScope(base, { untrustedWorkspaces: ['w'] }), base, now), ['trust'])
  assert.deepEqual(wideningReasons(base, withScope(base, { commands: ['/compact'] }), now), ['commands'])
  // Answers from outside: approvals without a passkey, and holding requests again after "off".
  assert.deepEqual(wideningReasons(base, { ...base, approvalsFromRemote: true }, now), ['approvals-from-remote'])
  assert.deepEqual(wideningReasons({ ...base, approvalsFromRemote: true }, base, now), [])
  const off = { ...base, remoteAnswerWaitMs: 0 }
  assert.deepEqual(wideningReasons(base, off, now), [])
  assert.deepEqual(wideningReasons(off, base, now), ['remote-answers'])
  assert.deepEqual(wideningReasons(base, { ...base, remoteAnswerWaitMs: 60 * 60_000 }, now), [])
})
