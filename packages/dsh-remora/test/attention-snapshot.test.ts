import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AttentionSnapshotEvent } from '@dsh-remora/protocol'
import { buildAdapter } from '../src/adapter/index.ts'
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
