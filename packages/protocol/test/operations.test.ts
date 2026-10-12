import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CONFIRMATION_UNLESS_ALLOWED, OPERATIONS, REQUIRES_CONFIRMATION, findOperationByTool, remoraRequestId, type OperationSpec } from '../src/index.ts'

const all = OPERATIONS as readonly OperationSpec[]

test('operation ids and tool names are unique', () => {
  assert.equal(new Set(all.map(op => op.id)).size, all.length)
  const tools = all.flatMap(op => (op.tool ? [op.tool] : []))
  assert.equal(new Set(tools).size, tools.length)
})

test('tool names follow the MCP naming rule and the dsh_ prefix', () => {
  for (const op of all) {
    if (op.tool) assert.match(op.tool, /^dsh_[a-z0-9_]{1,60}$/, op.id)
  }
})

test('read-only tools never need more than view, and destructive ones need full or a confirmation', () => {
  for (const op of all) {
    if (op.readOnly) assert.equal(op.level, 'view', op.id)
    if (op.destructive) assert.ok(op.level === 'full' || CONFIRMATION_UNLESS_ALLOWED.has(op.id), op.id)
    assert.ok(!(op.readOnly && op.destructive), op.id)
  }
})

test('approvals are a request-level tool guarded by the DSH-side switch', () => {
  const approval = all.find(op => op.id === 'approval.respond')
  assert.equal(approval?.tool, 'dsh_approval_respond')
  assert.equal(approval?.level, 'request')
  assert.ok(CONFIRMATION_UNLESS_ALLOWED.has('approval.respond'))
})

test('full-access operations need the owner\'s passkey on every call', () => {
  const full = all.filter(op => op.level === 'full').map(op => op.id)
  assert.deepEqual(full, ['terminal.run'])
  for (const id of full) assert.ok(REQUIRES_CONFIRMATION.has(id), id)
  assert.equal(findOperationByTool('dsh_terminal_run')?.id, 'terminal.run')
  assert.equal(findOperationByTool('dsh_confirmation_get')?.id, 'confirmation.get')
})

test('the P0 MCP surface matches the design', () => {
  const p0 = all.filter(op => op.phase === 'P0').map(op => op.tool)
  assert.deepEqual(p0, [
    'dsh_status', 'dsh_hosts_list', 'dsh_workspaces_list', 'dsh_sessions_list', 'dsh_session_get',
    'dsh_session_read', 'dsh_skills_list', 'dsh_task_start', 'dsh_task_get', 'dsh_task_wait', 'dsh_attention_list',
  ])
})

test('lookups and request ids', () => {
  assert.equal(findOperationByTool('dsh_task_start')?.id, 'task.start')
  assert.equal(findOperationByTool('nope'), undefined)
  assert.equal(remoraRequestId('claude', 't1'), 'remora:claude:t1')
})
