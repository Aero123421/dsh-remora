import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAttention, findTaskTurn, isLoginFailure, skillGestures, spanReply, transcriptItems } from '../src/adapter/events.ts'
import type { DshSessionEvent } from '../src/adapter/dsh-types.ts'

function log(entries: [string, unknown][]): DshSessionEvent[] {
  return entries.map(([type, data], seq) => ({ type, seq, time: 1000 + seq, data: data as any }))
}
const user = (text: string, rpcId?: string, kind = 'user') => ({ content: [{ type: 'text', text }], source: rpcId ? { kind, rpcId } : { kind } })
const reply = (turn: number, text: string) => ({ turn, message: { content: [{ type: 'text', text }] } })

test('findTaskTurn maps a request id to its turn and follows DSH-started follow-up turns', () => {
  const events = log([
    ['turn/start', { turn: 1 }],
    ['user/message', user('first', 'remora:c:t1')],
    ['assistant/message', reply(1, 'which db?')],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ['turn/start', { turn: 2 }],
    ['user/message', user('{"kind":"answer_to_pending_question"}', undefined, 'user-question-reply')],
    ['assistant/message', reply(2, 'thanks')],
    ['turn/end', { turn: 2, reason: { kind: 'completed' } }],
    ['turn/start', { turn: 3 }],
    ['user/message', user('someone else', 'remora:c:t2')],
    ['assistant/message', reply(3, 'other work')],
    ['turn/end', { turn: 3, reason: { kind: 'completed' } }],
  ])
  const task = findTaskTurn(events, 'remora:c:t1')!
  assert.deepEqual(task.turns, [1, 2])
  assert.equal(task.text, 'first')
  assert.equal(task.end?.seq, 7)
  assert.equal(spanReply(events, task.turns), 'thanks')
  const other = findTaskTurn(events, 'remora:c:t2')!
  assert.deepEqual(other.turns, [3])
  assert.equal(findTaskTurn(events, 'remora:c:none'), null)
})

test('findTaskTurn reports an open follow-up turn as not ended', () => {
  const events = log([
    ['turn/start', { turn: 1 }],
    ['user/message', user('go', 'r1')],
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ['turn/start', { turn: 2 }],
    ['user/message', user('goal round', undefined, 'goal')],
  ])
  const task = findTaskTurn(events, 'r1')!
  assert.deepEqual(task.turns, [1, 2])
  assert.equal(task.end, null)
})

test('steered messages map to the turn they entered', () => {
  const events = log([
    ['turn/start', { turn: 4 }],
    ['user/message', user('main', 'a')],
    ['user/message', user('steer', 'b')],
    ['turn/end', { turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } }],
  ])
  assert.deepEqual(findTaskTurn(events, 'b')!.turns, [4])
  assert.equal(findTaskTurn(events, 'b')!.end?.reason.kind, 'aborted')
})

test('stale approvals and tool calls from a closed turn are not attention', () => {
  const events = log([
    ['turn/start', { turn: 1 }],
    ['approval/asked', { id: 'x', toolName: 'shell' }],
    ['tool/call', { turn: 1, callId: 'c', name: 'ask_user_question', arguments: '{"questions":[{"id":"q","question":"?"}]}' }],
    ['turn/end', { turn: 1, reason: { kind: 'interrupted' } }],
  ])
  assert.deepEqual(computeAttention('s', { events, values: null }), [])
})

test('timed questions in the projection stay attention after their timeout result', () => {
  const items = computeAttention('s', {
    events: [],
    values: { userQuestions: { active: [{ callId: 'c1', state: 'continued', questions: [{ id: 'a', question: 'One?' }, { id: 'b', question: 'Two?' }] }], settled: [] } },
  })
  assert.equal(items.length, 1)
  assert.equal(items[0]!.answerable, true)
  assert.equal(items[0]!.options, undefined, 'multi-part questions have no single option list')
  assert.match(items[0]!.detail!, /One\?[\s\S]*Two\?/)
})

test('login failures are recognized from codes, status and text', () => {
  assert.ok(isLoginFailure({ code: 'INVALID_CREDENTIAL', message: 'x' }))
  assert.ok(isLoginFailure({ code: 'X', status: 401, message: 'x' }))
  assert.ok(isLoginFailure('provider said: 401 Unauthorized'))
  assert.ok(!isLoginFailure({ code: 'RATE_LIMIT', status: 429, message: 'slow down' }))
})

test('skill gestures follow the DSH grammar', () => {
  assert.deepEqual(skillGestures('/review this and /deploy-prod, see /usr/bin and 5/8 /review'), ['review'])
  assert.deepEqual(skillGestures('/a-b\n/c'), ['a-b', 'c'])
})

test('transcript items are redacted and skip injected context', () => {
  const items = transcriptItems(log([
    ['user/message', user('token ghp_abcdefghijklmnopqrstuvwxyz0123456789')],
    ['user/message', user('AGENTS.md content', undefined, 'context')],
    ['tool/call', { name: 'shell', arguments: '{"cmd":"ls"}' }],
    ['tool/result', { message: { toolCallId: 'x', isError: true, content: [{ type: 'text', text: 'boom' }] } }],
    ['turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'model down' } } }],
  ]))
  assert.deepEqual(items.map(i => [i.role, i.text]), [
    ['user', 'token ghp_[REDACTED]'],
    ['tool', 'shell {"cmd":"ls"}'],
    ['tool', 'error: boom'],
    ['system', 'turn failed: model down'],
  ])
})
