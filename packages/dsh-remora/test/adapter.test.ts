import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remoraRequestId, type AttentionEvent, type TaskEvent } from '@dsh-remora/protocol'
import { buildAdapter } from '../src/adapter/index.ts'
import { sessionIdFor } from '../src/adapter/tasks.ts'
import { OperationError } from '../src/ops/types.ts'
import { context, createFake, harness, type ScopeOptions } from './fake-dsh.ts'

function setup(scope: ScopeOptions = {}) {
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a', 'Project A')
  dsh.addWorkspace('ws-b', '/work/b', 'Project B')
  const h = harness(dsh, { workspaces: ['ws-a'], skills: ['review'], ...scope })
  const adapter = buildAdapter(dsh.ctx(), h.deps)
  return { dsh, ...h, adapter, handlers: adapter.handlers as Required<typeof adapter.handlers> }
}

async function rejects(promise: Promise<unknown>, code: string, layer?: string): Promise<OperationError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof OperationError, String(error))
    assert.equal(error.code, code, error.message)
    if (layer) assert.equal(error.details.denial?.layer, layer)
    return error
  }
  assert.fail(`expected ${code}`)
}

const wakes = (dsh: ReturnType<typeof createFake>) => dsh.calls.filter(c => c.method === 'wake' || c.method === 'resolveAgent').length

test('sessions.list follows the sidebar: pinned first, archived out, subagents under parent, scope filtered', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', title: 'one', updatedAt: 10 })
  dsh.addSession('s2', { workspace: 'ws-a', title: 'two', updatedAt: 20 })
  dsh.addSession('s3', { workspace: 'ws-a', title: 'pinned', updatedAt: 5 })
  dsh.addSession('s4', { workspace: 'ws-a', title: 'archived', updatedAt: 30 })
  dsh.addSession('child', { origin: 'subagent', parent: 's1', title: 'child', updatedAt: 40 })
  dsh.addSession('other', { workspace: 'ws-b', title: 'out of scope' })
  dsh.addSession('loose', { title: 'outside any workspace' })
  dsh.pinned = ['s3']
  dsh.archived = ['s4']
  const result = await handlers['sessions.list']({}, context())
  assert.deepEqual(result.sessions.map(s => s.sessionId), ['s3', 's1', 'child', 's2'])
  const child = result.sessions.find(s => s.sessionId === 'child')!
  assert.equal(child.parentSessionId, 's1')
  assert.equal(child.workspaceId, 'ws-a')
  assert.equal(result.sessions[0]!.pinned, true)
  const all = await handlers['sessions.list']({ includeArchived: true, limit: 2 }, context())
  assert.equal(all.sessions.length, 2)
  assert.ok(all.nextCursor)
  const next = await handlers['sessions.list']({ includeArchived: true, limit: 10, cursor: all.nextCursor! }, context())
  assert.ok(next.sessions.some(s => s.sessionId === 's4'))
  assert.equal(wakes(dsh), 0, 'listing never wakes a session')
})

test('reads never wake sessions', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', title: 'cold', values: { tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }, contextPressure: { projectedTokens: 50, contextWindow: 100 } } })
  dsh.append('s1', 'turn/start', { turn: 1 })
  dsh.append('s1', 'user/message', { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
  dsh.append('s1', 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'hello' }] } })
  dsh.append('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const got = await handlers['session.get']({ sessionId: 's1' }, context())
  assert.equal(got.untrusted, true)
  assert.deepEqual(got.context, { usedTokens: 50, maxTokens: 100, ratio: 0.5 })
  assert.equal(got.recentTurns[0]!.reply, 'hello')
  await handlers['session.read']({ sessionId: 's1', depth: 'summary' }, context())
  await handlers['session.read']({ sessionId: 's1', depth: 'turns' }, context())
  const page = await handlers['session.read']({ sessionId: 's1', depth: 'page' }, context())
  assert.deepEqual(page.items!.map(i => i.role), ['user', 'assistant'])
  await handlers['attention.list']({}, context())
  const usage = await handlers['session.usage']({ sessionId: 's1' }, context())
  assert.equal(usage.tokens.input, 13)
  assert.equal(usage.tokens.total, 18)
  assert.equal(wakes(dsh), 0)
})

test('session.get hides transcript previews without dsh.content and redacts with it', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', title: 'x' })
  dsh.append('s1', 'turn/start', { turn: 1 })
  dsh.append('s1', 'user/message', { content: [{ type: 'text', text: 'my key is sk-abcdefghijklmnopqrstuvwxyz' }], source: { kind: 'user' } })
  dsh.append('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const without = await handlers['session.get']({ sessionId: 's1' }, context({ content: false }))
  assert.equal(without.recentTurns[0]!.request, '')
  const withContent = await handlers['session.get']({ sessionId: 's1' }, context())
  assert.equal(withContent.recentTurns[0]!.request, 'my key is sk-[REDACTED]')
  await rejects(handlers['session.read']({ sessionId: 's1', depth: 'page' }, context({ content: false })), 'denied')
})

test('scope: out-of-scope sessions are denied at the dsh layer; unknown ones are not_found; deleted ones gone', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('other', { workspace: 'ws-b' })
  dsh.addSession('s1', { workspace: 'ws-a' })
  await rejects(handlers['session.get']({ sessionId: 'other' }, context()), 'denied', 'dsh')
  await rejects(handlers['session.get']({ sessionId: 'nope' }, context()), 'not_found')
  await handlers['session.get']({ sessionId: 's1' }, context())
  dsh.sessions.delete('s1')
  await rejects(handlers['session.get']({ sessionId: 's1' }, context()), 'gone')
  await rejects(handlers['session.get']({ sessionId: 's1' }, context()), 'gone')
})

test('task.start writes the task record before prompting, with the remora request id, and a retry never sends twice', async () => {
  const { dsh, handlers, tasks } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', live: true })
  const info = await handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'do it', idempotencyKey: 'k1' }, context({ taskId: 't1' }))
  const requestId = remoraRequestId('client-1', 't1')
  assert.deepEqual(dsh.log.slice(0, 2), ['put:t1:accepted', `prompt:${requestId}`])
  assert.equal(info.state, 'accepted')
  assert.equal(info.sessionId, 's1')
  assert.equal(tasks.get('t1')!.requestId, requestId)
  await handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'do it', idempotencyKey: 'k1' }, context({ taskId: 't1' }))
  assert.equal(dsh.sessions.get('s1')!.inbox.length, 1, 'DSH saw the same requestId again and kept one message')
  const prompts = dsh.calls.filter(c => c.method === 'prompt').map(c => (c.args as { requestId: string }).requestId)
  assert.ok(prompts.every(id => id === requestId))
})

test('task.start rejects archived, subagent and out-of-scope sessions before calling DSH', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('arch', { workspace: 'ws-a' })
  dsh.addSession('parent', { workspace: 'ws-a' })
  dsh.addSession('child', { origin: 'subagent', parent: 'parent' })
  dsh.addSession('other', { workspace: 'ws-b' })
  dsh.archived = ['arch']
  await rejects(handlers['task.start']({ target: { sessionId: 'arch' }, prompt: 'x', idempotencyKey: 'a' }, context({ taskId: 'a' })), 'conflict')
  await rejects(handlers['task.start']({ target: { sessionId: 'child' }, prompt: 'x', idempotencyKey: 'b' }, context({ taskId: 'b' })), 'invalid_request')
  await rejects(handlers['task.start']({ target: { sessionId: 'other' }, prompt: 'x', idempotencyKey: 'c' }, context({ taskId: 'c' })), 'denied', 'dsh')
  assert.equal(dsh.calls.filter(c => c.method === 'prompt').length, 0)
})

test('task.start checks skills: requested ones, gestures anywhere in the prompt, and untrusted workspaces', async () => {
  const { dsh, handlers } = setup({ untrusted: ['ws-u'], workspaces: ['ws-a', 'ws-u'] })
  dsh.addWorkspace('ws-u', '/work/u')
  dsh.addSession('s1', { workspace: 'ws-a' })
  dsh.addSession('u1', { workspace: 'ws-u' })
  await rejects(handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'x', skills: ['deploy'], idempotencyKey: '1' }, context({ taskId: '1' })), 'denied', 'dsh')
  await rejects(handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'please run /deploy now', idempotencyKey: '2' }, context({ taskId: '2' })), 'denied')
  await rejects(handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'x', skills: ['nonexistent'], idempotencyKey: '3' }, context({ taskId: '3' })), 'invalid_request')
  await rejects(handlers['task.start']({ target: { sessionId: 'u1' }, prompt: 'x', skills: ['review'], idempotencyKey: '4' }, context({ taskId: '4' })), 'denied')
  await handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'look at /tmp and 5/8', skills: ['review'], idempotencyKey: '5' }, context({ taskId: '5' }))
  const sent = dsh.calls.find(c => c.method === 'prompt')!.args as { content: { text: string }[] }
  assert.equal(sent.content[0]!.text, 'look at /tmp and 5/8\n\n/review')
})

test('task.start resolves latest, exact title, alias and new targets', async () => {
  const { dsh, handlers } = setup({ aliases: { main: 's1' } })
  dsh.addSession('s1', { workspace: 'ws-a', title: 'Alpha', updatedAt: 1 })
  dsh.addSession('s2', { workspace: 'ws-a', title: 'Beta', updatedAt: 9 })
  dsh.addSession('s3', { workspace: 'ws-a', title: 'Beta', updatedAt: 3 })
  assert.equal((await handlers['task.start']({ target: { latest: true }, prompt: 'x', idempotencyKey: 'l' }, context({ taskId: 'l' }))).sessionId, 's2')
  assert.equal((await handlers['task.start']({ target: { title: 'Alpha' }, prompt: 'x', idempotencyKey: 't' }, context({ taskId: 't' }))).sessionId, 's1')
  await rejects(handlers['task.start']({ target: { title: 'Beta' }, prompt: 'x', idempotencyKey: 't2' }, context({ taskId: 't2' })), 'conflict')
  assert.equal((await handlers['task.start']({ target: { alias: 'main' }, prompt: 'x', idempotencyKey: 'a' }, context({ taskId: 'a' }))).sessionId, 's1')
  await rejects(handlers['task.start']({ target: { new: { workspaceId: 'ws-a', agentPreset: 'ptc' } }, prompt: 'x', idempotencyKey: 'n0' }, context({ taskId: 'n0' })), 'denied')
  await rejects(handlers['task.start']({ target: { new: { workspaceId: 'ws-b' } }, prompt: 'x', idempotencyKey: 'n1' }, context({ taskId: 'n1' })), 'denied')
  const created = await handlers['task.start']({ target: { new: { workspaceId: 'ws-a', agentPreset: 'standard', title: 'Fresh' } }, prompt: 'x', idempotencyKey: 'n' }, context({ taskId: 'n' }))
  assert.equal(created.sessionId, sessionIdFor(remoraRequestId('client-1', 'n')))
  assert.equal(dsh.sessions.get(created.sessionId!)!.values.title, 'Fresh')
  // A retry adopts the same session instead of creating another.
  await handlers['task.start']({ target: { new: { workspaceId: 'ws-a', agentPreset: 'standard' } }, prompt: 'x', idempotencyKey: 'n' }, context({ taskId: 'n' }))
  assert.equal(dsh.calls.filter(c => c.method === 'create').length, 1)
})

test('a task completes when its turn ended, the session is idle, the queue is empty and nothing needs attention', async () => {
  const { dsh, handlers, adapter, events } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', live: true })
  adapter.start()
  await handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'go', idempotencyKey: 'k' }, context({ taskId: 't1' }))
  dsh.activity = ['s1']
  dsh.runTurn('s1', { reply: 'all done' })
  await adapter.watcher.idle()
  assert.equal(adapter.tasks.active().length, 1, 'a background job keeps the task running')
  dsh.activity = []
  dsh.fire('api-session/status', 's1', false)
  await adapter.watcher.idle()
  const states = events.filter((e): e is TaskEvent => e.kind === 'task').map(e => e.state)
  assert.deepEqual(states, ['running', 'completed'])
  const info = await handlers['task.get']({ taskId: 't1' }, context())
  assert.equal(info.state, 'completed')
  assert.equal(info.result?.reply, 'all done')
  const hidden = await handlers['task.get']({ taskId: 't1' }, context({ content: false }))
  assert.equal(hidden.result?.reply, null)
  await rejects(handlers['task.get']({ taskId: 't1' }, context({ clientId: 'someone-else' })), 'not_found')
  adapter.dispose()
})

test('needs_attention for an unanswered question; attention events carry no detail; task.wait returns early', async () => {
  const { dsh, handlers, adapter, events } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', live: true })
  adapter.start()
  await handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'go', idempotencyKey: 'k' }, context({ taskId: 't1' }))
  const waiting = handlers['task.wait']({ taskId: 't1', timeoutMs: 5000 }, context())
  dsh.runTurn('s1', {
    leaveOpen: true,
    beforeEnd: (turn) => dsh.append('s1', 'tool/call', { turn, step: 1, callId: 'call-1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] }) }),
  })
  await adapter.watcher.idle()
  const info = await waiting
  assert.equal(info.state, 'needs_attention')
  assert.equal(info.attention?.[0]?.kind, 'question')
  assert.equal(info.attention?.[0]?.answerable, false, 'legacy-mode questions are not answerable remotely')
  assert.match(info.attention?.[0]?.detail ?? '', /Postgres/)
  const attention = events.filter((e): e is AttentionEvent => e.kind === 'attention')
  assert.equal(attention.length, 1)
  assert.equal(attention[0]!.items[0]!.title, 'Which DB?')
  assert.ok(!('detail' in attention[0]!.items[0]!))
  dsh.append('s1', 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'call-1', content: [{ type: 'text', text: '{}' }] } })
  dsh.endTurn('s1', 1)
  await adapter.watcher.idle()
  assert.equal((await handlers['task.get']({ taskId: 't1' }, context())).state, 'completed')
  assert.deepEqual(events.filter((e): e is AttentionEvent => e.kind === 'attention').at(-1)!.items, [])
  adapter.dispose()
})

test('attention.respond answers a continued question through userQuestions.answer and refuses answered ones', async () => {
  const { dsh, handlers } = setup()
  const s = dsh.addSession('s1', { workspace: 'ws-a' })
  s.values.userQuestions = { active: [{ callId: 'call-9', state: 'continued', questions: [{ id: 'q1', question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] }] }], settled: [] }
  const list = await handlers['attention.list']({ sessionId: 's1' }, context())
  assert.equal(list.items[0]!.answerable, true)
  assert.deepEqual(list.items[0]!.options, [{ id: '0', label: 'Yes' }, { id: '1', label: 'No' }])
  await handlers['attention.respond']({ sessionId: 's1', attentionId: 'call-9', answer: { optionId: '1', text: 'not yet' } }, context())
  assert.deepEqual(dsh.answers, [{ callId: 'call-9', answer: { answers: [{ id: 'q1', selected: ['No'], custom: 'not yet' }] } }])
  s.values.userQuestions = { active: [], settled: [] }
  await rejects(handlers['attention.respond']({ sessionId: 's1', attentionId: 'call-9', answer: { optionId: '0' } }, context()), 'conflict')
})

test('approvals, plan reviews, goals and expired logins show up as attention', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', live: true, values: { goal: { goal: { id: 'g', revision: 2, objective: 'Ship', phase: 'blocked', blockedReason: { code: 'x', message: 'tests fail' }, maxGoalRounds: 5 }, roundsStarted: 1, createdAt: 1, updatedAt: 2 } } })
  dsh.append('s1', 'turn/start', { turn: 1 })
  dsh.append('s1', 'approval/asked', { id: 'ap1', toolName: 'shell', reason: 'rm -rf build' })
  dsh.append('s1', 'approval/asked', { id: 'ap2', toolName: 'shell' })
  dsh.append('s1', 'approval/decided', { id: 'ap2', outcome: 'allowed-once' })
  dsh.append('s1', 'tool/call', { turn: 1, step: 1, callId: 'plan-1', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# Migrate\n1. do' }) })
  const items = (await handlers['attention.list']({ sessionId: 's1' }, context())).items
  assert.deepEqual(items.map(i => [i.kind, i.attentionId]), [['approval', 'approval:ap1'], ['plan-review', 'plan-1'], ['goal-stopped', 'goal:g:2']])
  assert.equal(items[1]!.title, 'Plan review: Migrate')
  await rejects(handlers['attention.respond']({ sessionId: 's1', attentionId: 'approval:ap1', answer: { approve: true } }, context()), 'invalid_request')
  await rejects(handlers['attention.respond']({ sessionId: 's1', attentionId: 'plan-1', answer: { approve: true } }, context()), 'unavailable')
  dsh.endTurn('s1', 1, { kind: 'error', error: { message: '401 Unauthorized', code: 'INVALID_CREDENTIAL' } })
  const after = (await handlers['attention.list']({ sessionId: 's1' }, context())).items
  assert.deepEqual(after.map(i => i.kind), ['goal-stopped', 'login-expired'])
})

test('task.cancel removes a queued prompt, or stops the running session', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', live: true })
  await handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'one', idempotencyKey: '1' }, context({ taskId: 't1' }))
  assert.deepEqual(await handlers['task.cancel']({ taskId: 't1' }, context()), { cancelled: true, how: 'removed-from-queue' })
  assert.equal(dsh.sessions.get('s1')!.inbox.length, 0)
  await handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'two', idempotencyKey: '2' }, context({ taskId: 't2' }))
  dsh.runTurn('s1', { leaveOpen: true })
  assert.deepEqual(await handlers['task.cancel']({ taskId: 't2' }, context()), { cancelled: true, how: 'stopped-session' })
  assert.ok(dsh.calls.some(c => c.method === 'cancel'))
  assert.deepEqual(await handlers['task.cancel']({ taskId: 't2' }, context()), { cancelled: false, how: 'already-finished' })
})

test('task.steer and task.resubmit send through the same write-ahead path', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', live: true })
  await handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'original prompt', idempotencyKey: '1' }, context({ taskId: 't1' }))
  dsh.runTurn('s1', { leaveOpen: true })
  const steered = await handlers['task.steer']({ taskId: 't1', prompt: 'also this', idempotencyKey: 's' }, context({ taskId: 't2' }))
  assert.equal(steered.sessionId, 's1')
  const steer = dsh.calls.filter(c => c.method === 'prompt').at(-1)!.args as { mode: string; requestId: string }
  assert.equal(steer.mode, 'steer')
  assert.equal(steer.requestId, remoraRequestId('client-1', 't2'))
  dsh.endTurn('s1', 1)
  await handlers['task.resubmit']({ taskId: 't1', idempotencyKey: 'r' }, context({ taskId: 't3' }))
  const again = dsh.calls.filter(c => c.method === 'prompt').at(-1)!.args as { content: { text: string }[]; requestId: string }
  assert.equal(again.content[0]!.text, 'original prompt')
  assert.equal(again.requestId, remoraRequestId('client-1', 't3'))
})

test('model.select returns candidates when nothing matches and notes the saved default', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a' })
  const miss = await handlers['model.select']({ sessionId: 's1', model: 'gpt-9' }, context())
  assert.equal(miss.savedAsDefault, false)
  assert.ok(miss.candidates!.some(c => c.model === 'deepseek-reasoner' && c.effort === 'high'))
  assert.equal(dsh.calls.filter(c => c.method === 'selectModel').length, 0)
  const hit = await handlers['model.select']({ sessionId: 's1', model: 'DeepSeek Reasoner', effort: 'HIGH' }, context())
  assert.deepEqual(hit, { model: { provider: 'deepseek', model: 'deepseek-reasoner', effort: 'high' }, savedAsDefault: true })
})

test('command.run only runs allowed commands, and redacts output', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a' })
  await rejects(handlers['command.run']({ sessionId: 's1', command: '/feedback' }, context()), 'denied', 'dsh')
  const result = await handlers['command.run']({ sessionId: 's1', command: '/compact' }, context())
  assert.deepEqual(result, { accepted: true, output: 'compacted OPENAI_API_KEY=[REDACTED]', untrusted: true })
})

test('skills.list shows only allowed skills with their source, none in untrusted workspaces', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a' })
  const { skills } = await handlers['skills.list']({ sessionId: 's1' }, context())
  assert.deepEqual(skills.map(s => s.name), ['review'])
  assert.equal(skills[0]!.source, '.agents/skills')
})

test('workspaces.list returns reachable workspaces and placements', async () => {
  const { handlers } = setup({ placements: [{ placementId: 'p1', path: '/work' }], untrusted: ['ws-a'] })
  const result = await handlers['workspaces.list']({}, context())
  assert.deepEqual(result.workspaces.map(w => [w.workspaceId, w.untrusted]), [['ws-a', true]])
  assert.deepEqual(result.placements, [{ placementId: 'p1', path: '/work' }])
})
