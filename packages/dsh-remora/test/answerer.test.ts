import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AttentionEvent, AttentionItem } from '@dsh-remora/protocol'
import { buildAdapter } from '../src/adapter/index.ts'
import type { DshAgent } from '../src/adapter/dsh-types.ts'
import { OperationError } from '../src/ops/types.ts'
import { context, createFake, harness, waterfall, type FakeDsh, type ScopeOptions } from './fake-dsh.ts'
import { until } from './helpers.ts'

const QUESTIONS = [{ id: 'color', question: 'Which color?', options: [{ label: 'Teal' }, { label: 'Navy' }] }]
const noProvider = () => Promise.reject(Object.assign(new Error('no user-questions answerer accepted the request'), { name: 'UserQuestionError', code: 'NO_PROVIDER' }))
const unavailable = () => Promise.resolve('unavailable')

interface Options { wait?: number; approvals?: boolean; allows?: boolean; linked?: boolean; web?: boolean; scope?: ScopeOptions }

function setup(options: Options = {}) {
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  dsh.addWorkspace('ws-b', '/work/b')
  if (options.web !== undefined) dsh.webConnected = options.web
  const h = harness(dsh, { workspaces: ['ws-a'], ...options.scope })
  const policy = { wait: options.wait ?? 60_000, approvals: options.approvals ?? false, allows: options.allows ?? true, linked: options.linked ?? true }
  h.deps.answers = { waitMs: () => policy.wait, approvalsFromRemote: () => policy.approvals, allows: () => policy.allows, linked: () => policy.linked }
  const adapter = buildAdapter(dsh.ctx(), h.deps)
  adapter.start()
  return { dsh, adapter, policy, scope: h.deps.scope, events: h.events, handlers: adapter.handlers as Required<typeof adapter.handlers> }
}

/** An answerer after Remora that holds the request until answered or withdrawn (DSH Web's card, or DSH's gateway with no tab). */
function addCard(dsh: FakeDsh, name: string) {
  const pending: { request: any; resolve: (value: unknown) => void }[] = []
  let withdrawn = 0
  dsh.ctx().on(name, (request: any) => new Promise((resolve, reject) => {
    const signal: AbortSignal | undefined = request.signal
    signal?.addEventListener('abort', () => { withdrawn++; reject(signal.reason) }, { once: true })
    pending.push({ request, resolve })
  }))
  return { pending, withdrawn: () => withdrawn }
}

function openQuestion(dsh: FakeDsh, sessionId = 's1', callId = 'call-1', tool = 'ask_user_question', args: unknown = { questions: QUESTIONS }): DshAgent {
  if (!dsh.sessions.has(sessionId)) dsh.addSession(sessionId, { workspace: 'ws-a', live: true })
  dsh.runTurn(sessionId, { leaveOpen: true, beforeEnd: turn => dsh.append(sessionId, 'tool/call', { turn, step: 1, callId, name: tool, arguments: JSON.stringify(args) }) })
  return dsh.sessions.get(sessionId)!.agent!
}

function ask(dsh: FakeDsh, agent: DshAgent, extra: Record<string, unknown> = {}) {
  const controller = new AbortController()
  const request: Record<string, any> = { questions: QUESTIONS, agent, signal: controller.signal, ...extra }
  const result = waterfall(dsh, 'user-questions/request', request, noProvider)
  result.catch(() => {})
  return { request, result, controller }
}

async function item(handlers: ReturnType<typeof setup>['handlers'], attentionId: string, sessionId = 's1'): Promise<AttentionItem | undefined> {
  return (await handlers['attention.list']({ sessionId }, context())).items.find(candidate => candidate.attentionId === attentionId)
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error) {
    return error instanceof OperationError ? error.code : String((error as { code?: unknown }).code ?? error)
  }
}

test('a legacy question while DSH Web is open: an answer from outside wins and withdraws the Web card', async () => {
  const { dsh, adapter, handlers } = setup({ web: true })
  const web = addCard(dsh, 'user-questions/request')
  const agent = openQuestion(dsh)
  const { request, result, controller } = ask(dsh, agent)
  await until(() => adapter.answerer.find('s1', 'call-1') !== undefined, 3000, 'held question')
  assert.equal(web.pending.length, 1, 'DSH Web still gets the question')
  assert.notEqual(web.pending[0]!.request.signal, controller.signal, 'the chain sees a signal Remora can abort')
  const listed = await item(handlers, 'call-1')
  assert.equal(listed?.answerable, true)
  assert.equal(listed?.answerVia, 'remote')
  assert.equal(listed?.expiresAt, null, 'no deadline while DSH Web holds the card')
  assert.deepEqual(await handlers['attention.respond']({ sessionId: 's1', attentionId: 'call-1', answer: { optionId: '1', text: 'darker' } }, context()), { accepted: true })
  assert.deepEqual(await result, { answers: [{ id: 'color', selected: ['Navy'], custom: 'darker' }] })
  assert.equal(web.withdrawn(), 1)
  assert.equal(request.signal, controller.signal, 'the caller\'s signal is put back')
  assert.equal(adapter.answerer.find('s1', 'call-1'), undefined)
  assert.equal(await code(handlers['attention.respond']({ sessionId: 's1', attentionId: 'call-1', answer: { optionId: '0' } }, context())), 'unavailable')
  dsh.append('s1', 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'call-1', content: [{ type: 'text', text: '{"answers":[]}' }] } })
  assert.equal(await code(handlers['attention.respond']({ sessionId: 's1', attentionId: 'call-1', answer: { optionId: '0' } }, context())), 'conflict')
  adapter.dispose()
})

test('DSH Web answers first: its answer goes through and Remora lets go', async () => {
  const { dsh, adapter } = setup({ web: true })
  const web = addCard(dsh, 'user-questions/request')
  const { result } = ask(dsh, openQuestion(dsh))
  await until(() => adapter.answerer.find('s1', 'call-1') !== undefined, 3000, 'held question')
  const answer = { answers: [{ id: 'color', selected: ['Teal'] }] }
  web.pending[0]!.resolve(answer)
  assert.deepEqual(await result, answer)
  assert.equal(adapter.answerer.find('s1', 'call-1'), undefined)
  assert.equal(web.withdrawn(), 0)
  adapter.dispose()
})

test('no DSH Web tab: Remora waits the configured time, then the question fails with NO_PROVIDER', async () => {
  const { dsh, adapter, handlers, events } = setup({ web: false, wait: 800 })
  const gateway = addCard(dsh, 'user-questions/request')
  const { result } = ask(dsh, openQuestion(dsh))
  await until(() => adapter.answerer.find('s1', 'call-1') !== undefined, 3000, 'held question')
  const listed = await item(handlers, 'call-1')
  assert.equal(typeof listed?.expiresAt, 'number')
  await adapter.watcher.idle()
  const sent = events.filter((e): e is AttentionEvent => e.kind === 'attention').at(-1)?.items.find(i => i.attentionId === 'call-1')
  assert.equal(sent?.answerVia, 'remote', 'the attention event carries the route')
  assert.equal(typeof sent?.expiresAt, 'number', 'and the deadline')
  await assert.rejects(result, (error: Error & { code?: string }) => error.code === 'NO_PROVIDER' && error.name === 'UserQuestionError' && /Nobody answered/.test(error.message))
  assert.equal(gateway.withdrawn(), 1, 'the request is withdrawn from DSH\'s gateway')
  assert.equal(adapter.answerer.find('s1', 'call-1'), undefined)
  adapter.dispose()
})

test('nobody else can answer (the chain gives up): Remora keeps the question open for an answer from outside', async () => {
  const { dsh, adapter, handlers } = setup()
  const { result } = ask(dsh, openQuestion(dsh))
  await until(() => adapter.answerer.find('s1', 'call-1')?.alone === true, 3000, 'held question')
  assert.equal(typeof (await item(handlers, 'call-1'))?.expiresAt, 'number')
  await handlers['attention.respond']({ sessionId: 's1', attentionId: 'call-1', answer: { text: 'Purple' } }, context())
  assert.deepEqual(await result, { answers: [{ id: 'color', selected: [], custom: 'Purple' }] })
  adapter.dispose()

  const short = setup({ wait: 100 })
  const late = ask(short.dsh, openQuestion(short.dsh))
  await assert.rejects(late.result, (error: Error & { code?: string }) => error.code === 'NO_PROVIDER' && /Nobody answered/.test(error.message))
  short.adapter.dispose()
})

test('Remora stays out of the chain when nobody outside could answer', async () => {
  const cases: [string, Options, (dsh: FakeDsh) => DshAgent, Record<string, unknown>?][] = [
    ['wait 0', { wait: 0 }, dsh => openQuestion(dsh)],
    ['hub link down', { linked: false }, dsh => openQuestion(dsh)],
    ['ceiling or kill switch', { allows: false }, dsh => openQuestion(dsh)],
    ['session out of scope', {}, dsh => { dsh.addSession('s1', { workspace: 'ws-b', live: true }); return openQuestion(dsh) }],
    ['untrusted workspace', { scope: { untrusted: ['ws-a'] } }, dsh => openQuestion(dsh)],
    ['timed question', {}, dsh => openQuestion(dsh), { wait: { callId: 'call-1', timed: true } }],
  ]
  for (const [name, options, prepare, extra] of cases) {
    const { dsh, adapter } = setup(options)
    const { result } = ask(dsh, prepare(dsh), extra)
    await assert.rejects(result, (error: Error) => error.message === 'no user-questions answerer accepted the request', name)
    assert.equal(adapter.answerer.find('s1', 'call-1'), undefined, name)
    adapter.dispose()
  }
})

test('plan reviews: approve, or keep planning with feedback for the model', async () => {
  const { dsh, adapter, handlers } = setup({ web: true })
  addCard(dsh, 'user-questions/request')
  const plan = [{ id: 'plan-review', header: 'Plan review', question: 'Approve this plan and leave plan mode?', detail: '# Migrate\n1. step', options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent: { kind: 'plan-review', approve: 'Approve', callId: 'plan-1' } }]
  const agent = openQuestion(dsh, 's1', 'plan-1', 'exit_plan_mode', { plan: '# Migrate\n1. step' })
  const first = ask(dsh, agent, { questions: plan })
  await until(() => adapter.answerer.find('s1', 'plan-1') !== undefined, 3000, 'held plan review')
  const listed = await item(handlers, 'plan-1')
  assert.equal(listed?.kind, 'plan-review')
  assert.equal(listed?.answerVia, 'remote')
  assert.deepEqual(listed?.options?.map(o => o.id), ['approve', 'keep-planning'])
  assert.equal(await code(handlers['attention.respond']({ sessionId: 's1', attentionId: 'plan-1', answer: { text: 'hmm' } }, context())), 'invalid_request')
  await handlers['attention.respond']({ sessionId: 's1', attentionId: 'plan-1', answer: { approve: false, text: 'smaller steps' } }, context())
  assert.deepEqual(await first.result, { answers: [{ id: 'plan-review', selected: ['Keep planning'], custom: 'smaller steps' }] })

  const second = ask(dsh, agent, { questions: plan })
  await until(() => adapter.answerer.find('s1', 'plan-1') !== undefined, 3000, 'held plan review again')
  await handlers['attention.respond']({ sessionId: 's1', attentionId: 'plan-1', answer: { optionId: 'approve', text: 'ignored' } }, context())
  assert.deepEqual(await second.result, { answers: [{ id: 'plan-review', selected: ['Approve'] }] })
  adapter.dispose()
})

test('approvals: held, answered with approval.respond, and routed to the hub passkey page unless allowed from MCP and CLI', async () => {
  const { dsh, adapter, handlers, policy } = setup({ web: true })
  const web = addCard(dsh, 'approval/request')
  dsh.addSession('s1', { workspace: 'ws-a', live: true })
  const fake = dsh.sessions.get('s1')!
  const agent = fake.agent!
  // Read the open turn in-process, the way a live DSH session offers it.
  Object.defineProperty(agent.session, 'seq', { get: () => fake.events.length })
  Object.defineProperty(agent.session, 'eventAt', { value: (seq: number) => fake.events[seq] })
  dsh.runTurn('s1', { leaveOpen: true })
  const askApproval = (id: string) => {
    dsh.append('s1', 'approval/asked', { id, toolName: 'shell', callId: `call-${id}`, reason: 'write outside the workspace' })
    const controller = new AbortController()
    const result = waterfall(dsh, 'approval/request', { agent, toolName: 'shell', callId: `call-${id}`, reason: 'write outside the workspace', signal: controller.signal }, unavailable)
    return { result, controller }
  }
  const first = askApproval('ap-1')
  await until(() => adapter.answerer.find('s1', 'approval:ap-1') !== undefined, 3000, 'held approval')
  let listed = await item(handlers, 'approval:ap-1')
  assert.equal(listed?.answerable, true)
  assert.equal(listed?.answerVia, 'hub-passkey')
  assert.deepEqual(listed?.options?.map(o => o.id), ['allow-once', 'reject'])
  policy.approvals = true
  adapter.settingsChanged()
  listed = await item(handlers, 'approval:ap-1')
  assert.equal(listed?.answerVia, 'remote')
  assert.equal(await code(handlers['attention.respond']({ sessionId: 's1', attentionId: 'approval:ap-1', answer: { approve: true } }, context())), 'invalid_request')
  assert.equal(await code(handlers['approval.respond']({ sessionId: 's1', attentionId: 'approval:ap-1', answer: { text: 'yes' } }, context())), 'invalid_request')
  assert.deepEqual(await handlers['approval.respond']({ sessionId: 's1', attentionId: 'approval:ap-1', answer: { approve: true } }, context()), { accepted: true })
  assert.equal(await first.result, 'allowed-once')
  assert.equal(web.withdrawn(), 1)
  dsh.append('s1', 'approval/decided', { id: 'ap-1', outcome: 'allowed-once' })
  assert.equal(await code(handlers['approval.respond']({ sessionId: 's1', attentionId: 'approval:ap-1', answer: { approve: true } }, context())), 'conflict')

  const second = askApproval('ap-2')
  await until(() => adapter.answerer.find('s1', 'approval:ap-2') !== undefined, 3000, 'second approval')
  await handlers['approval.respond']({ sessionId: 's1', attentionId: 'approval:ap-2', answer: { optionId: 'reject' } }, context())
  assert.equal(await second.result, 'rejected')
  adapter.dispose()
})

test('an approval nobody answers comes back unavailable (DSH rejects it); one Remora does not hold is answered in DSH Web', async () => {
  const { dsh, adapter, handlers } = setup({ wait: 100 })
  dsh.addSession('s1', { workspace: 'ws-a', live: true })
  const agent = dsh.sessions.get('s1')!.agent!
  dsh.runTurn('s1', { leaveOpen: true })
  dsh.append('s1', 'approval/asked', { id: 'ap-1', toolName: 'shell' })
  const result = waterfall(dsh, 'approval/request', { agent, toolName: 'shell' }, unavailable)
  await until(() => adapter.answerer.find('s1', 'approval:ap-1') !== undefined, 3000, 'held approval')
  assert.equal(await result, 'unavailable')
  dsh.append('s1', 'approval/decided', { id: 'ap-1', outcome: 'unavailable' })
  dsh.append('s1', 'approval/asked', { id: 'ap-2', toolName: 'shell' })
  assert.equal((await item(handlers, 'approval:ap-2'))?.answerVia, 'dsh-web')
  assert.equal(await code(handlers['approval.respond']({ sessionId: 's1', attentionId: 'approval:ap-2', answer: { approve: true } }, context())), 'unavailable')
  adapter.dispose()
})

test('a held request goes back to DSH when the session leaves scope, the workspace is untrusted, or the hub link is stopped', async () => {
  const answer = { answers: [{ id: 'color', selected: ['Teal'] }] }
  {
    const workspaces = ['ws-a']
    const { dsh, adapter } = setup({ web: false, wait: 60_000, scope: { workspaces } })
    const gateway = addCard(dsh, 'user-questions/request')
    const { result } = ask(dsh, openQuestion(dsh))
    await until(() => adapter.answerer.find('s1', 'call-1') !== undefined, 3000, 'held question')
    workspaces.splice(0, 1)
    adapter.settingsChanged()
    await until(() => adapter.answerer.find('s1', 'call-1') === undefined, 3000, 'question released')
    assert.equal(gateway.withdrawn(), 0, 'DSH keeps the card')
    gateway.pending[0]!.resolve(answer)
    assert.deepEqual(await result, answer)
    adapter.dispose()
  }
  {
    const { dsh, adapter, scope } = setup({ web: true })
    const web = addCard(dsh, 'user-questions/request')
    const { result } = ask(dsh, openQuestion(dsh))
    await until(() => adapter.answerer.find('s1', 'call-1') !== undefined, 3000, 'held question')
    await scope.markUntrustedWorkspace('ws-a')
    adapter.settingsChanged()
    await until(() => adapter.answerer.find('s1', 'call-1') === undefined, 3000, 'question released')
    web.pending[0]!.resolve(answer)
    assert.deepEqual(await result, answer)
    assert.equal(web.withdrawn(), 0)
    adapter.dispose()
  }
  {
    const { dsh, adapter } = setup({ web: true })
    const web = addCard(dsh, 'user-questions/request')
    const { result } = ask(dsh, openQuestion(dsh))
    await until(() => adapter.answerer.find('s1', 'call-1') !== undefined, 3000, 'held question')
    adapter.releaseAnswers()
    assert.equal(adapter.answerer.find('s1', 'call-1'), undefined)
    web.pending[0]!.resolve(answer)
    assert.deepEqual(await result, answer)
    assert.equal(web.withdrawn(), 0)
    adapter.dispose()
  }
})

test('Remora lets go when the turn is cancelled, the wait is turned off, or the plugin unloads', async () => {
  {
    const { dsh, adapter } = setup({ web: true })
    const web = addCard(dsh, 'user-questions/request')
    const { result, controller } = ask(dsh, openQuestion(dsh))
    await until(() => adapter.answerer.find('s1', 'call-1') !== undefined, 3000, 'held question')
    controller.abort(new Error('turn cancelled'))
    await assert.rejects(result, /turn cancelled/)
    assert.equal(web.withdrawn(), 1)
    assert.equal(adapter.answerer.find('s1', 'call-1'), undefined)
    adapter.dispose()
  }
  {
    // DSH Web still holds it: the card keeps waiting and its answer still goes through.
    const { dsh, adapter, policy } = setup({ web: true })
    const web = addCard(dsh, 'user-questions/request')
    const { result } = ask(dsh, openQuestion(dsh))
    await until(() => adapter.answerer.find('s1', 'call-1') !== undefined, 3000, 'held question')
    policy.wait = 0
    adapter.settingsChanged()
    assert.equal(adapter.answerer.find('s1', 'call-1'), undefined)
    web.pending[0]!.resolve({ answers: [{ id: 'color', selected: ['Teal'] }] })
    assert.deepEqual(await result, { answers: [{ id: 'color', selected: ['Teal'] }] })
    adapter.dispose()
  }
  {
    // Nobody else could answer: unloading ends it the way DSH would have without Remora.
    const { dsh, adapter } = setup()
    const { result } = ask(dsh, openQuestion(dsh))
    await until(() => adapter.answerer.find('s1', 'call-1')?.alone === true, 3000, 'held question')
    adapter.dispose()
    await assert.rejects(result, (error: Error) => error.message === 'no user-questions answerer accepted the request')
  }
})

test('a frozen request is still answered (DSH Web\'s card then stays until the turn ends)', async () => {
  const { dsh, adapter, handlers } = setup({ web: true })
  addCard(dsh, 'user-questions/request')
  const agent = openQuestion(dsh)
  const controller = new AbortController()
  const result = waterfall(dsh, 'user-questions/request', Object.freeze({ questions: QUESTIONS, agent, signal: controller.signal }), noProvider)
  await until(() => adapter.answerer.find('s1', 'call-1') !== undefined, 3000, 'held question')
  await handlers['attention.respond']({ sessionId: 's1', attentionId: 'call-1', answer: { optionId: '0' } }, context())
  assert.deepEqual(await result, { answers: [{ id: 'color', selected: ['Teal'] }] })
  adapter.dispose()
})
