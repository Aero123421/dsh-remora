import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, type Grant } from '../src/index.ts'

const now = Date.UTC(2026, 9, 12)
const allScopes = ['dsh.read', 'dsh.content', 'dsh.tasks', 'dsh.admin']
const view: Grant = { level: 'view' }
const request: Grant = { level: 'request' }
const full: Grant = { level: 'full', fullAccessExpiresAt: now + 60_000 }

test('view can read but cannot start tasks', () => {
  assert.deepEqual(decide({ operation: 'sessions.list', ceiling: view, hubGrant: view, tokenScopes: allScopes, now }), { allowed: true })
  assert.deepEqual(decide({ operation: 'task.start', ceiling: view, hubGrant: request, tokenScopes: allScopes, now }),
    { allowed: false, layer: 'dsh', reason: 'level-too-low' })
})

test('the hub grant can only narrow the DSH ceiling', () => {
  assert.deepEqual(decide({ operation: 'task.start', ceiling: request, hubGrant: view, tokenScopes: allScopes, now }),
    { allowed: false, layer: 'hub', reason: 'level-too-low' })
  assert.deepEqual(decide({ operation: 'task.start', ceiling: view, hubGrant: full, tokenScopes: allScopes, now }),
    { allowed: false, layer: 'dsh', reason: 'level-too-low' })
})

test('the token scope is checked last', () => {
  assert.deepEqual(decide({ operation: 'session.read', ceiling: request, hubGrant: request, tokenScopes: ['dsh.read'], now }),
    { allowed: false, layer: 'token', reason: 'missing-scope' })
})

test('switches turn single operations off or on, but not dangerous ones on', () => {
  const custom: Grant = { level: 'view', overrides: { 'task.start': true, 'sessions.list': false, 'terminal.run': true } }
  assert.deepEqual(decide({ operation: 'task.start', ceiling: custom, hubGrant: custom, tokenScopes: allScopes, now }), { allowed: true })
  assert.deepEqual(decide({ operation: 'sessions.list', ceiling: custom, hubGrant: request, tokenScopes: allScopes, now }),
    { allowed: false, layer: 'dsh', reason: 'switched-off' })
  assert.deepEqual(decide({ operation: 'terminal.run', ceiling: custom, hubGrant: full, tokenScopes: allScopes, now }),
    { allowed: false, layer: 'dsh', reason: 'level-too-low' })
})

test('full access expires and then behaves as request', () => {
  const expired: Grant = { level: 'full', fullAccessExpiresAt: now - 1 }
  assert.deepEqual(decide({ operation: 'terminal.run', ceiling: full, hubGrant: full, tokenScopes: allScopes, now }), { allowed: true })
  assert.deepEqual(decide({ operation: 'terminal.run', ceiling: expired, hubGrant: full, tokenScopes: allScopes, now }),
    { allowed: false, layer: 'dsh', reason: 'full-access-expired' })
  assert.deepEqual(decide({ operation: 'task.start', ceiling: expired, hubGrant: full, tokenScopes: allScopes, now }), { allowed: true })
})

test('some operations are never allowed remotely, and unknown ones are refused', () => {
  assert.deepEqual(decide({ operation: 'credentials.read', ceiling: full, hubGrant: full, tokenScopes: allScopes, now }),
    { allowed: false, layer: 'dsh', reason: 'forbidden-remotely' })
  assert.deepEqual(decide({ operation: 'made.up', ceiling: full, hubGrant: full, tokenScopes: allScopes, now }),
    { allowed: false, layer: 'dsh', reason: 'unknown-operation' })
})
