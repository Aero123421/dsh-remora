import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OPERATIONS } from '@dsh-remora/protocol'
import { SERVICE_REQUIREMENTS, detectFeatures } from '../src/features.ts'

test('every catalog operation declares its DSH service needs', () => {
  for (const { id } of OPERATIONS) assert.ok(Array.isArray(SERVICE_REQUIREMENTS[id]), id)
})

test('operations are offered only when implemented and every service is present', () => {
  const implemented = new Set(['status', 'sessions.list', 'command.run'] as const)
  const report = detectFeatures(service => service === 'sessionController', implemented)
  assert.deepEqual(report.available, ['status', 'sessions.list'])
  assert.deepEqual(report.missing, [{ operation: 'command.run', services: ['commands'] }])
})

test('the scaffold advertises only status', () => {
  assert.deepEqual(detectFeatures(() => true).available, ['status'])
})
