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

test('every P0 and P1 operation is implemented; P2 ones are not', () => {
  const available = new Set(detectFeatures(() => true).available)
  for (const spec of OPERATIONS) {
    if (spec.id === 'hosts.list') continue
    assert.equal(available.has(spec.id), spec.phase !== 'P2', spec.id)
  }
})

test('a missing DSH service disables only the operations that need it', () => {
  const report = detectFeatures(service => service !== 'goals')
  assert.ok(!report.available.includes('goal.manage'))
  assert.ok(report.available.includes('task.start'))
  assert.deepEqual(report.missing, [{ operation: 'goal.manage', services: ['goals'] }])
})
