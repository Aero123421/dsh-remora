import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AttentionEvent, AttentionSnapshotEvent } from '@dsh-remora/protocol'
import { buildAdapter } from '../src/adapter/index.ts'
import { OperationError } from '../src/ops/types.ts'
import { createFake, harness } from './fake-dsh.ts'

const wakes = (dsh: ReturnType<typeof createFake>) => dsh.calls.filter(call => call.method === 'wake' || call.method === 'resolveAgent').length

function question(dsh: ReturnType<typeof createFake>, sessionId: string, callId: string, text: string, answered = false): void {
  dsh.append(sessionId, 'turn/start', { turn: 1 })
  dsh.append(sessionId, 'tool/call', { turn: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: text }] }) })
  if (!answered) return
  dsh.append(sessionId, 'tool/result', { turn: 1, message: { toolCallId: callId, content: [{ type: 'text', text: '{}' }] } })
  dsh.append(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
}

test('plugin start republishes open questions, including a subagent, without waking sessions', async () => {
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  dsh.addWorkspace('ws-b', '/work/b')
  dsh.addSession('open', { workspace: 'ws-a' })
  dsh.addSession('done', { workspace: 'ws-a' })
  dsh.addSession('outside', { workspace: 'ws-b' })
  dsh.addSession('child', { origin: 'subagent', parent: 'open' })
  question(dsh, 'open', 'q-open', 'Still open?')
  question(dsh, 'done', 'q-done', 'Answered?', true)
  question(dsh, 'outside', 'q-out', 'Hidden?')
  question(dsh, 'child', 'q-child', 'Child?')
  const h = harness(dsh, { workspaces: ['ws-a'] })
  const adapter = buildAdapter(dsh.ctx(), h.deps)
  adapter.start()
  await adapter.watcher.idle()
  const snapshots = h.events.filter((event): event is AttentionSnapshotEvent => event.kind === 'attention-snapshot')
  assert.equal(snapshots.length, 1)
  assert.deepEqual(snapshots[0]!.sessions.map(session => session.sessionId).sort(), ['child', 'open'])
  assert.equal(snapshots[0]!.sessions.every(session => session.items.length > 0 && session.items.every(item => !('detail' in item))), true)
  assert.equal(wakes(dsh), 0)
  adapter.start()
  await adapter.watcher.idle()
  assert.equal(h.events.filter(event => event.kind === 'attention-snapshot').length, 1, 'a second start is the same process and does not publish again')
  adapter.dispose()
  const restarted = buildAdapter(dsh.ctx(), h.deps)
  restarted.start()
  await restarted.watcher.idle()
  assert.equal(h.events.filter(event => event.kind === 'attention-snapshot').length, 2)
  restarted.dispose()
})

test('a temporary read failure during startup keeps that session unread', async () => {
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  dsh.addSession('healthy', { workspace: 'ws-a' })
  dsh.addSession('flaky', { workspace: 'ws-a' })
  question(dsh, 'healthy', 'q-healthy', 'Still open?')
  question(dsh, 'flaky', 'q-flaky', 'Read failed?')
  const original = dsh.sessionController.inspect.bind(dsh.sessionController)
  dsh.sessionController.inspect = async (id: string) => {
    if (id === 'flaky') throw new Error('temporary')
    return original(id)
  }
  const h = harness(dsh, { workspaces: ['ws-a'] })
  const adapter = buildAdapter(dsh.ctx(), h.deps)
  adapter.start()
  await adapter.watcher.idle()
  const snapshots = h.events.filter((event): event is AttentionSnapshotEvent => event.kind === 'attention-snapshot')
  assert.equal(snapshots.length, 1)
  assert.deepEqual(snapshots[0]!.sessions.map(session => session.sessionId), ['healthy'])
  assert.ok(snapshots[0]!.unreadSessionIds?.includes('flaky'))
  const cleared = h.events.filter((event): event is AttentionEvent => event.kind === 'attention' && event.sessionId === 'flaky' && event.items.length === 0)
  assert.equal(cleared.length, 0)
  assert.equal(wakes(dsh), 0)
  adapter.dispose()
})

test('a session that is gone during startup still clears its attention', async () => {
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  dsh.addSession('healthy', { workspace: 'ws-a' })
  dsh.addSession('missing', { workspace: 'ws-a' })
  question(dsh, 'healthy', 'q-healthy', 'Still open?')
  question(dsh, 'missing', 'q-missing', 'Deleted?')
  const original = dsh.sessionController.inspect.bind(dsh.sessionController)
  dsh.sessionController.inspect = async (id: string) => {
    if (id === 'missing') throw new OperationError('gone', 'session missing was deleted')
    return original(id)
  }
  const h = harness(dsh, { workspaces: ['ws-a'] })
  const adapter = buildAdapter(dsh.ctx(), h.deps)
  adapter.start()
  await adapter.watcher.idle()
  const snapshots = h.events.filter((event): event is AttentionSnapshotEvent => event.kind === 'attention-snapshot')
  assert.equal(snapshots[0]!.unreadSessionIds, undefined)
  assert.equal(h.events.some(event => event.kind === 'attention' && event.sessionId === 'missing' && event.items.length === 0), true)
  adapter.dispose()
})
