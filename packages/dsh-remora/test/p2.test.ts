import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAdapter } from '../src/adapter/index.ts'
import { createRequest, ruleText } from '../src/adapter/schedules.ts'
import { queryWords, snippet } from '../src/adapter/search.ts'
import { OperationError } from '../src/ops/types.ts'
import { context, createFake, harness, type ScopeOptions } from './fake-dsh.ts'

function setup(scope: ScopeOptions = {}, path = '/work/a') {
  const dsh = createFake()
  dsh.addWorkspace('ws-a', path, 'Project A')
  dsh.addWorkspace('ws-b', '/work/b', 'Project B')
  const h = harness(dsh, { workspaces: ['ws-a'], ...scope })
  const adapter = buildAdapter(dsh.ctx(), h.deps)
  return { dsh, adapter, handlers: adapter.handlers as Required<typeof adapter.handlers> }
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return error instanceof OperationError ? error.code : String(error)
  }
}

const message = (role: 'user' | 'assistant', text: string, turn: number) => role === 'user'
  ? { turn, content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `r${turn}` } }
  : { turn, step: 1, message: { content: [{ type: 'text', text }] } }

test('sessions.search finds words in titles, prompts and replies of reachable sessions only', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', title: 'Database migration', updatedAt: 10 })
  dsh.addSession('s2', { workspace: 'ws-a', title: 'Release notes', updatedAt: 20 })
  dsh.addSession('hidden', { workspace: 'ws-b', title: 'Database secrets', updatedAt: 30 })
  dsh.append('s2', 'turn/start', { turn: 1 })
  dsh.append('s2', 'user/message', message('user', 'Please plan the database migration for Postgres', 1))
  dsh.append('s2', 'assistant/message', message('assistant', 'Here is the migration plan. OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx', 1))
  dsh.append('s2', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const result = await handlers['sessions.search']({ query: 'MIGRATION database' }, context())
  assert.deepEqual(result.hits.map(hit => `${hit.sessionId}:${hit.role}`), ['s2:user', 's1:title'])
  assert.equal(result.hits[0]!.turn, 1)
  assert.match(result.hits[0]!.snippet, /database migration/)
  assert.equal(result.scanned, 2)
  assert.equal(result.partial, false)
  const secret = await handlers['sessions.search']({ query: 'plan OPENAI_API_KEY' }, context())
  assert.ok(secret.hits.every(hit => !hit.snippet.includes('sk-abcdefghijklmnop')), 'snippets are redacted')
  assert.equal((await handlers['sessions.search']({ query: 'sk-abcdefghijklmnop' }, context())).hits.length, 0, 'a secret cannot be searched for')
  assert.equal((await handlers['sessions.search']({ query: 'qrstuvwx' }, context())).hits.length, 0, 'nor a piece of one')
  assert.equal((await handlers['sessions.search']({ query: 'secrets' }, context())).hits.length, 0, 'sessions outside the scope are not searched')
  assert.equal(await code(handlers['sessions.search']({ query: 'x', sessionId: 'hidden' }, context())), 'denied')
  assert.equal(await code(handlers['sessions.search']({ query: 'plan' }, context({ content: false }))), 'denied')
  const limited = await handlers['sessions.search']({ query: 'migration', limit: 1 }, context())
  assert.equal(limited.hits.length, 1)
  assert.equal(limited.partial, true)
  assert.deepEqual(queryWords('  Foo  foo bar '), ['foo', 'bar'])
  assert.equal(snippet('a\n\nlong   text with the word here', ['word']), 'a long text with the word here')
})

test('session.fork copies up to the end of a turn into a new session in the same workspace', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', title: 'Original', live: true })
  dsh.runTurn('s1', { reply: 'first' })
  dsh.runTurn('s1', { reply: 'second' })
  const forked = await handlers['session.fork']({ sessionId: 's1', atTurn: 1, title: 'Try B' }, context())
  assert.equal(forked.forkedFrom, 's1')
  assert.equal(forked.session.workspaceId, 'ws-a')
  const call = dsh.calls.find(c => c.method === 'fork')!.args as { atSeq: number; allowMigration: boolean }
  assert.equal(dsh.sessions.get('s1')!.events.find(event => event.seq === call.atSeq)?.type, 'turn/end')
  assert.equal(call.allowMigration, false)
  assert.ok(dsh.calls.some(c => c.method === 'rename' && (c.args as { title: string }).title === 'Try B'))
  assert.equal(dsh.sessions.get(forked.session.sessionId)!.events.filter(event => event.type === 'turn/end').length, 1)
  assert.equal(await code(handlers['session.fork']({ sessionId: 's1', atTurn: 9 }, context())), 'invalid_request')
  dsh.addSession('child', { origin: 'subagent', parent: 's1' })
  assert.equal(await code(handlers['session.fork']({ sessionId: 'child' }, context())), 'invalid_request')
})

test('jobs: session.get lists them (labels with dsh.content only); job.stop stops one the caller may reach', async () => {
  const { dsh, handlers } = setup()
  dsh.addSession('s1', { workspace: 'ws-a', live: true })
  dsh.addSession('other', { workspace: 'ws-b', live: true })
  dsh.jobList.push({ id: 'bash-1', kind: 'bash', label: 'npm run dev', owner: 's1', status: 'running', output: 'listening on 3000' })
  dsh.jobList.push({ id: 'bash-2', kind: 'bash', label: 'tail -f log', owner: 'other', status: 'running', output: '' })
  const got = await handlers['session.get']({ sessionId: 's1' }, context())
  assert.deepEqual(got.jobs, [{ jobId: 'bash-1', kind: 'bash', label: 'npm run dev', status: 'running' }])
  const plain = await handlers['session.get']({ sessionId: 's1' }, context({ content: false }))
  assert.equal(plain.jobs?.[0]?.label, '')
  assert.equal((await handlers['job.output']({ jobId: 'bash-1' }, context())).output, 'listening on 3000')
  assert.deepEqual(await handlers['job.stop']({ jobId: 'bash-1' }, context({ clientId: 'phone' })), { stopped: true, status: 'killed' })
  const kill = dsh.calls.find(c => c.method === 'kill')!.args as { caller: string; reason: string }
  assert.equal(kill.caller, 's1')
  assert.match(kill.reason, /Remora/)
  assert.deepEqual(await handlers['job.stop']({ jobId: 'bash-1' }, context()), { stopped: false, status: 'killed' })
  assert.equal(await code(handlers['job.stop']({ jobId: 'bash-2' }, context())), 'denied')
  assert.equal(await code(handlers['job.stop']({ jobId: 'nope' }, context())), 'not_found')
  dsh.jobList.push({ id: 'global-1', kind: 'bash', label: 'host-wide', status: 'running', output: 'x' })
  assert.equal(await code(handlers['job.stop']({ jobId: 'global-1' }, context())), 'denied', 'a job no session owns is out of scope')
  assert.equal(await code(handlers['job.output']({ jobId: 'global-1' }, context())), 'denied')
})

test('schedules: create like a prompt (scope, trust, idempotency), list with prompts only for dsh.content, delete', async () => {
  const { dsh, adapter, handlers } = setup({ untrusted: ['ws-u'] })
  dsh.addWorkspace('ws-u', '/work/u')
  dsh.addSession('s1', { workspace: 'ws-a' })
  dsh.addSession('u1', { workspace: 'ws-u' })
  dsh.addSession('o1', { workspace: 'ws-b' })
  const params = { sessionId: 's1', title: 'Morning CI check', prompt: 'Check CI and summarize', when: { daily: { time: '09:00', timeZone: 'Asia/Tokyo' } }, idempotencyKey: 'k1' }
  const created = await handlers['schedule.create'](params, context())
  assert.equal(created.schedule.rule, 'daily 09:00 Asia/Tokyo')
  assert.equal(created.schedule.prompt, 'Check CI and summarize')
  assert.equal((dsh.calls.find(c => c.method === 'schedule.create')!.args as any).request.daily.time, '09:00:00')
  const again = await handlers['schedule.create'](params, context())
  assert.equal(again.schedule.scheduleId, created.schedule.scheduleId, 'the same key does not create twice')
  assert.equal(dsh.scheduleRows.length, 1)
  await handlers['schedule.create']({ ...params, idempotencyKey: 'k2', when: { everySeconds: 3600 } }, context())
  dsh.scheduleRows.push({ id: 'schedule-x', sessionId: 'o1', status: 'active', record: { id: 'schedule-x', kind: 'every', title: 'Elsewhere', prompt: 'x', everySeconds: 60, scheduledAt: '2026-10-13T00:00:00.000Z' } })
  const listed = await handlers['schedules.list']({}, context({ content: false }))
  assert.deepEqual(listed.schedules.map(s => s.rule), ['daily 09:00 Asia/Tokyo', 'every 1 h'])
  assert.ok(listed.schedules.every(s => s.prompt === undefined))
  assert.deepEqual(listed.schedules.map(s => s.createdBy), ['Test', 'Test'], 'schedules made through Remora say by whom')
  assert.equal(await code(handlers['schedule.create']({ ...params, sessionId: 'u1', idempotencyKey: 'k3' }, context())), 'denied')
  assert.equal(await code(handlers['schedule.create']({ ...params, sessionId: 'o1', idempotencyKey: 'k4' }, context())), 'denied')
  assert.equal(await code(handlers['schedule.create']({ ...params, title: '   ', idempotencyKey: 'k5' }, context())), 'invalid_request')
  assert.deepEqual(await handlers['schedule.delete']({ sessionId: 's1', scheduleId: created.schedule.scheduleId }, context()), { deleted: true })
  assert.deepEqual(await handlers['schedule.delete']({ sessionId: 's1', scheduleId: created.schedule.scheduleId }, context()), { deleted: false })
  assert.equal(await code(handlers['schedule.delete']({ sessionId: 'o1', scheduleId: 'schedule-x' }, context())), 'denied')
  // A bounded number of remote schedules, and the kill switch / unpairing takes them all away.
  for (let i = 0; i < 19; i++) await handlers['schedule.create']({ ...params, idempotencyKey: `bulk-${i}`, when: { everySeconds: 3600 } }, context())
  assert.equal(await code(handlers['schedule.create']({ ...params, idempotencyKey: 'one-too-many', when: { everySeconds: 3600 } }, context())), 'conflict')
  // A delete DSH refuses (another session) does not drop Remora's record of it.
  const k2 = listed.schedules.find(s => s.rule === 'every 1 h')!.scheduleId
  dsh.addSession('s2', { workspace: 'ws-a' })
  assert.deepEqual(await handlers['schedule.delete']({ sessionId: 's2', scheduleId: k2 }, context()), { deleted: false })
  assert.equal((await handlers['schedules.list']({}, context())).schedules.find(s => s.scheduleId === k2)?.createdBy, 'Test')
  const before = dsh.scheduleRows.length
  assert.equal(await adapter.removeRemoteSchedules(), 20)
  assert.equal(dsh.scheduleRows.length, before - 20)
  assert.ok(dsh.scheduleRows.some(row => row.id === 'schedule-x'), 'schedules made on the DSH host itself stay')
  assert.deepEqual(createRequest('t', 'p', { weekly: { time: '18:30', timeZone: 'UTC', weekdays: [5, 1, 5] } }).weekly, { time: '18:30:00', time_zone: 'UTC', weekdays: [1, 5] })
  assert.equal(ruleText({ id: 'x', kind: 'weekly', title: 't', prompt: 'p', time: '18:30:00.000', timeZone: 'UTC', weekdays: [1, 5], scheduledAt: '', sessionId: 's', status: 'active' }), 'weekly Mon,Fri 18:30 UTC')
  assert.throws(() => createRequest('t', 'p', { at: '2026-13-45T99:00:00Z' }))
})

test('terminal.run runs one command in the workspace folder with a timeout, output redacted', async () => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'remora-terminal-')))
  try {
    const { dsh, handlers } = setup({}, folder)
    const ran = await handlers['terminal.run']({ cwdWorkspaceId: 'ws-a', command: 'pwd; echo OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx; echo oops >&2; exit 3' }, context())
    assert.equal(ran.exitCode, 3)
    assert.equal(ran.timedOut, false)
    assert.match(ran.stdout, new RegExp(folder))
    assert.ok(!ran.stdout.includes('sk-abcdefghijklmnop'))
    assert.equal(ran.stderr.trim(), 'oops')
    assert.deepEqual((dsh.calls.find(c => c.method === 'spawn')!.args as { argv: string[] }).argv.slice(0, 2), ['/bin/sh', '-c'])
    const slow = await handlers['terminal.run']({ cwdWorkspaceId: 'ws-a', command: 'sleep 5', timeoutMs: 1000 }, context())
    assert.equal(slow.timedOut, true)
    assert.ok(slow.durationMs < 4000)
    assert.equal(await code(handlers['terminal.run']({ cwdWorkspaceId: 'ws-b', command: 'ls' }, context())), 'denied')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
