// Compatibility check of the Remora adapter against the real DSH services at
// the pinned commit (upstream.json). See scripts/compat/README.md for what
// this covers and what it does not.
//
//   pnpm --filter dsh-remora test:compat
//
// DSH_UPSTREAM_COMMIT=<40-hex sha> fetches that commit instead of upstream.json.
// DSH_UPSTREAM_DIR=<checkout> skips the git fetch and uses a local checkout.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cacheRoot, compileOfficial, ensureUpstream, packageRoot, upstreamIdentity } from './upstream.mjs'

await ensureUpstream()
console.log(`DSH ${await upstreamIdentity()}: Remora adapter compat`)
const bundle = join(cacheRoot, 'compat-host.mjs')
await compileOfficial(join(packageRoot, 'scripts/compat/host-entry.ts'), bundle, {
  '@dsh-compat/mock-adapter': 'packages/core/agent-loop/tests/mock-adapter.ts',
  // Paths for @deepseek-ai/* overrides are relative to this package.
  '@deepseek-ai/node-addon-system/flock': 'scripts/compat/flock-shim.ts',
})
const dsh = await import(pathToFileURL(bundle).href)
const { buildAdapter } = await import(pathToFileURL(join(packageRoot, 'src/adapter/index.ts')).href)
const { remoraRequestId } = await import(pathToFileURL(join(packageRoot, '../protocol/src/index.ts')).href)

const results = []
async function step(name, run) {
  const started = Date.now()
  try {
    await run()
    results.push({ name, ok: true, ms: Date.now() - started })
    console.log(`  ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`  FAIL ${name}\n${error?.stack ?? error}`)
  }
}

// --- the model: DSH's scripted MockAdapter, answering by the last message ----------------
const lastUserText = (options) => {
  for (let i = options.messages.length - 1; i >= 0; i--) {
    const message = options.messages[i]
    if (message.role === 'tool') return { tool: true, text: message.content.map(b => b.text ?? '').join('') }
    if (message.role !== 'user') continue
    const text = message.content.map(b => b.text ?? '').join('')
    // The runtime-context snapshot (e.g. the approval policy) arrives as a user message too.
    if (text.startsWith('Current runtime context')) continue
    return { tool: false, text }
  }
  return { tool: false, text: '' }
}
const respond = (options) => {
  const last = lastUserText(options)
  if (!last.tool && /ask me/.test(last.text)) {
    return dsh.toolCallResponse(`call-${options.messages.length}`, 'ask_user_question', {
      questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
      // "must": an indefinite (blocking) ask, like the default legacy tool.
      ...(/must ask me/.test(last.text) ? { timeout: -1 } : {}),
    })
  }
  if (last.tool) return dsh.textResponse(/"answers"/.test(last.text) ? `answered: ${last.text.includes('Postgres') ? 'Postgres' : 'other'}` : 'waiting for your answer')
  if (/answer_to_pending_question/.test(last.text)) return dsh.textResponse(`thanks: ${last.text.includes('SQLite') ? 'SQLite' : 'other'}`)
  return dsh.textResponse(`pong: ${last.text.slice(0, 40)} OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx`)
}
const model = new dsh.MockAdapter(Array.from({ length: 200 }, () => respond))

// --- compose the real host services ---------------------------------------------
const root = await realpath(await mkdtemp(join(tmpdir(), 'remora-compat-')))
const workspacePath = join(root, 'project')
const outsidePath = join(root, 'outside')
await mkdir(workspacePath)
await mkdir(outsidePath)

/** Compose the real host services. Called twice with the same folders to simulate a DSH restart. */
async function boot() {
  const ctx = new dsh.Context()
  await ctx.plugin(dsh.LlmRuntime)
  await ctx.plugin(dsh.SessionStore)
  await ctx.plugin(dsh.SessionProjectionRegistry)
  await ctx.plugin(dsh.SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(dsh.ToolRuntime)
  await ctx.plugin(dsh.AgentRegistry)
  await ctx.plugin(dsh.JsonlSessionPersistence, { root: join(root, 'sessions') })
  await ctx.plugin(dsh.SessionCheckpointPolicy)
  await ctx.plugin(dsh.AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], model)
  await ctx.plugin(dsh.Storage)
  await ctx.plugin(dsh.StorageJson, { root: join(root, 'storages') })
  await ctx.plugin(dsh.StorageDomain, { backend: 'json' })
  await ctx.plugin(dsh.SessionProjectionCache, { writeEveryEvents: 1, writeIntervalMs: 10 })
  await ctx.plugin(dsh.WorkspaceRegistry)
  await ctx.plugin(dsh.TurnOutline)
  await ctx.plugin(dsh.TokenMeter)
  await ctx.plugin(dsh.SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  await ctx.plugin(dsh.UserQuestionService)
  await ctx.plugin(dsh.ToolAskUser, { mode: 'timed', timeout: 1 })
  await ctx.plugin(dsh.ApprovalService, { policy: 'ask' })
  await ctx.plugin(dsh.SubprocessLocal, {})
  // Host services the Session Controller injects but the compat run does not exercise
  // (same stand-ins as DSH's own session-controller test harness). `typert` is the real
  // registry, mounted below, because session list/search register a resource on it.
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'mock', model: 'mock' }), saveSelection: async () => {} })
  ctx.provide('attachments', {
    imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1, maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] },
    admitPromptContent: async content => content,
  })
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {},
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
    retirePrompt: () => {},
  })
  ctx.provide('fs', {})
  await ctx.plugin(dsh.CompatSessionQuery)
  // alpha.3: session list and search filter rows through remoteAccess.allows().
  // TypertRegistry provides that service's resource registry. An in-process call has no
  // Remote invocation, so allows() admits every session; the adapter's own scope still applies.
  await ctx.plugin(dsh.TypertRegistry)
  await ctx.plugin(dsh.RemoteAccess)
  await ctx.plugin(dsh.SessionController, {})
  await ctx.plugin(dsh.ScheduleService, {})
  for (const name of ['sessionController', 'workspaceRegistry', 'agents', 'userQuestions', 'sessionQuery', 'sessionTitle', 'approval', 'schedule', 'subprocess', 'typert', 'remoteAccess']) {
    assert.ok(ctx.get(name) !== undefined, `${name} is mounted`)
  }

  if (process.env.COMPAT_DEBUG) {
    ctx.on('api-session/error', (id, message) => console.log('  [dsh error]', id, message))
    ctx.on('session/event', (session, event) => console.log('  [event]', session.id.slice(0, 16), event.type, JSON.stringify(event.data).slice(0, 160)))
  }
  return ctx
}

let ctx = await boot()
const workspace = await ctx.workspaceRegistry.create(workspacePath)
const workspaceId = workspace.id
const outside = await ctx.workspaceRegistry.create(outsidePath)

// --- the adapter, with a scope that reaches only `workspace` ---------------------
const emitted = []
const records = new Map()
const putOrder = []
/** How long Remora holds a request for an outside answer in this run (no DSH Web: nothing else answers). */
let answerWait = 30_000
const deps = {
  scope: {
    canAccessWorkspace: id => id === workspace.id,
    canAccessSession: input => input.workspaceId === workspace.id,
    placements: () => [],
    isAllowedSkill: () => false,
    isAllowedAgentPreset: () => true,
    isAllowedCommand: () => false,
    aliases: () => ({}),
    gitHosts: () => [],
    isUntrustedWorkspace: () => false,
    markUntrustedWorkspace: async () => {},
  },
  tasks: {
    get: id => records.get(id),
    list: () => [...records.values()],
    put: async (record) => { putOrder.push(`${record.taskId}:${record.state}:${record.sessionId ?? '-'}`); records.set(record.taskId, { ...record }) },
  },
  answers: { waitMs: () => answerWait, approvalsFromRemote: () => false, allows: () => true, linked: () => true },
  emit: event => emitted.push(event),
  logger: { info: () => {}, warn: (...args) => console.warn('  [adapter warn]', ...args) },
}
let adapter = buildAdapter(ctx, deps)
let h = adapter.handlers
adapter.start()
const context = (taskId, content = true) => ({
  actor: { clientId: 'compat-client', clientName: 'Compat' },
  requestId: `r-${Math.random()}`,
  ...(taskId ? { taskId } : {}),
  scopes: content ? ['dsh.read', 'dsh.content', 'dsh.tasks'] : ['dsh.read', 'dsh.tasks'],
  fullAccess: false,
  signal: AbortSignal.timeout(30_000),
})
const waitFor = async (what, check, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const taskStates = taskId => emitted.filter(e => e.kind === 'task' && e.taskId === taskId).map(e => e.state)
const userMessages = sessionId => ctx.sessions.get(sessionId)?.snapshotEvents().filter(e => e.type === 'user/message').length ?? 0

let sessionId

await step('remote access admits an in-process session read', async () => {
  assert.equal(ctx.get('remoteAccess').allows({ kind: 'session', id: 'compat-session' }), true)
})

await step('task.start (new session in a workspace) → real session.create + session.prompt, write-ahead record', async () => {
  const info = await h['task.start']({ target: { new: { workspaceId: workspace.id, title: 'Compat session' } }, prompt: 'hello there', idempotencyKey: 'k1' }, context('t1'))
  sessionId = info.sessionId
  assert.ok(sessionId)
  assert.equal(putOrder[0], 't1:accepted:-', 'the record is durable before DSH sees anything')
  assert.ok(workspace.sessionIds.includes(sessionId), 'DSH attached the new session to the workspace')
  assert.equal(records.get('t1').requestId, remoraRequestId('compat-client', 't1'))
})

await step('completion: the real agent loop runs the turn; the watcher reports running → completed from session events', async () => {
  await waitFor('t1 completed', () => records.get('t1')?.state === 'completed')
  await adapter.watcher.idle()
  // The mock turn is faster than the watcher's debounce, so `running` may be coalesced away.
  assert.equal(taskStates('t1').at(-1), 'completed')
  assert.ok(taskStates('t1').every(state => state === 'running' || state === 'completed'))
  const info = await h['task.get']({ taskId: 't1' }, context())
  assert.equal(info.result.reply, "pong: hello there OPENAI_API_KEY=sk-[REDACTED]")
  const user = ctx.sessions.get(sessionId).snapshotEvents().find(e => e.type === 'user/message')
  assert.equal(user.data.source.rpcId, remoraRequestId('compat-client', 't1'), 'DSH stored requestId as source.rpcId')
})

await step('retrying task.start with the same task id does not send twice (DSH dedupes on requestId)', async () => {
  const before = userMessages(sessionId)
  const info = await h['task.start']({ target: { new: { workspaceId: workspace.id } }, prompt: 'hello there', idempotencyKey: 'k1' }, context('t1'))
  assert.equal(info.state, 'completed')
  assert.equal(userMessages(sessionId), before)
  // And a forced re-prompt with the same requestId is accepted without a new message.
  await ctx.sessionController.prompt({ requestId: remoraRequestId('compat-client', 't1'), sessionId, mode: 'queue', content: [{ type: 'text', text: 'hello there' }] }, AbortSignal.timeout(5000))
  assert.equal(userMessages(sessionId), before)
})

await step('reads: sessions.list / session.get / session.read / session.usage / attention.list on a live session', async () => {
  const list = await h['sessions.list']({}, context())
  const row = list.sessions.find(s => s.sessionId === sessionId)
  assert.ok(row, 'listed')
  assert.equal(row.workspaceId, workspace.id)
  assert.equal(row.title, 'Compat session')
  const got = await h['session.get']({ sessionId }, context())
  assert.equal(got.queueLength, 0)
  assert.equal(got.recentTurns.length, 1)
  assert.match(got.recentTurns[0].request, /hello there/)
  const page = await h['session.read']({ sessionId, depth: 'page' }, context())
  assert.deepEqual(page.items.map(i => i.role), ['user', 'assistant'])
  assert.ok(page.items[1].text.includes('[REDACTED]'))
  const usage = await h['session.usage']({ sessionId }, context())
  assert.ok((usage.tokens.output ?? 0) > 0, 'token-meter projection read')
  assert.deepEqual((await h['attention.list']({ sessionId }, context())).items, [])
})

await step('restart: cold sessions are listed and read without waking; task.start resumes from JSONL persistence', async () => {
  adapter.dispose()
  await ctx.fiber.dispose()
  if (process.env.COMPAT_DEBUG) console.log((await import('node:child_process')).execSync(`find ${root}/sessions`).toString())
  ctx = await boot()
  adapter = buildAdapter(ctx, deps)
  h = adapter.handlers
  adapter.start()
  assert.equal(ctx.agents.get(sessionId), undefined, 'no live agent after the restart')
  const list = await h['sessions.list']({}, context())
  const row = list.sessions.find(s => s.sessionId === sessionId)
  assert.ok(row, 'the cold session is listed')
  assert.equal(row.workspaceId, workspace.id, 'workspace membership survives (storage-json)')
  assert.equal(row.title, 'Compat session', 'title from the projection cache')
  const got = await h['session.get']({ sessionId }, context())
  assert.match(got.recentTurns[0].request, /hello there/)
  await h['session.read']({ sessionId, depth: 'turns' }, context())
  await h['session.read']({ sessionId, depth: 'page' }, context())
  await h['session.usage']({ sessionId }, context())
  await h['attention.list']({}, context())
  assert.equal((await h['task.get']({ taskId: 't1' }, context())).result.reply.startsWith('pong: hello there'), true, 'a finished task result is rebuilt from the cold log')
  assert.equal(ctx.agents.get(sessionId), undefined, 'still cold after every read')
  await h['task.start']({ target: { latest: true, workspaceId: workspace.id }, prompt: 'second', idempotencyKey: 'k2' }, context('t2'))
  assert.ok(ctx.agents.get(sessionId), 'the prompt woke the session')
  await waitFor('t2 completed', () => records.get('t2')?.state === 'completed')
})

await step('timed ask_user_question: needs_attention, then attention.respond → userQuestions.answer → completed', async () => {
  await h['task.start']({ target: { sessionId }, prompt: 'please ask me something', idempotencyKey: 'k3' }, context('t3'))
  const info = await waitFor('t3 needs attention', async () => {
    const current = await h['task.get']({ taskId: 't3' }, context())
    return current.state === 'needs_attention' && current.attention?.[0]?.answerable ? current : null
  })
  const item = info.attention[0]
  assert.equal(item.kind, 'question')
  assert.equal(item.title, 'Which database?')
  assert.deepEqual(item.options.map(o => o.label), ['Postgres', 'SQLite'])
  const event = emitted.filter(e => e.kind === 'attention' && e.sessionId === sessionId).at(-1)
  assert.equal(event?.items[0]?.attentionId, item.attentionId)
  assert.ok(!('detail' in event.items[0]))
  await h['attention.respond']({ sessionId, attentionId: item.attentionId, answer: { optionId: '1' } }, context())
  await waitFor('t3 completed', () => records.get('t3')?.state === 'completed')
  const reply = (await h['task.get']({ taskId: 't3' }, context())).result.reply
  assert.equal(reply, 'thanks: SQLite')
  await assert.rejects(h['attention.respond']({ sessionId, attentionId: item.attentionId, answer: { optionId: '0' } }, context()), { code: 'conflict' })
})

await step('task.resubmit re-sends the logged prompt; task.steer on an idle session queues it', async () => {
  await h['task.resubmit']({ taskId: 't1', idempotencyKey: 'r' }, context('t4'))
  await waitFor('t4 completed', () => records.get('t4')?.state === 'completed')
  const text = ctx.sessions.get(sessionId).snapshotEvents().filter(e => e.type === 'user/message').at(-1).data.content[0].text
  assert.equal(text, 'hello there')
  await h['task.steer']({ sessionId, prompt: 'steer while idle', idempotencyKey: 's' }, context('t5'))
  await waitFor('t5 completed', () => records.get('t5')?.state === 'completed')
})

await step('task.cancel removes a queued prompt through session.updateQueue', async () => {
  // A running Agent may have claimed the message without logging it yet.
  // Cancellation must not stop an unidentified turn; retry once it is logged.
  let claimed = false
  let releaseClaim
  const claimHold = new Promise(resolve => { releaseClaim = resolve })
  const stopClaim = ctx.on('agent/pre-step', async (input, next) => {
    if (input.messages.some(message => message.source?.rpcId === remoraRequestId('compat-client', 't6'))) {
      claimed = true
      await claimHold
    }
    return next()
  }, { global: true })
  try {
    model.script.unshift({ hangAfter: dsh.textResponse('long').slice(0, 2) })
    await h['task.start']({ target: { sessionId }, prompt: 'long running', idempotencyKey: 'k6' }, context('t6'))
    await waitFor('t6 claimed before logging', () => claimed)
    await assert.rejects(h['task.cancel']({ taskId: 't6' }, context()), { code: 'conflict' })
    assert.equal(records.get('t6').state, 'accepted', 'a claimed but unidentified turn remains retryable')
    releaseClaim()
    await waitFor('t6 logged and running', () => records.get('t6')?.state === 'running')
    await h['task.start']({ target: { sessionId }, prompt: 'queued behind', idempotencyKey: 'k7' }, context('t7'))
    assert.equal((await h['session.get']({ sessionId }, context())).queueLength, 1)
    assert.deepEqual(await h['task.cancel']({ taskId: 't7' }, context()), { cancelled: true, how: 'removed-from-queue' })
    assert.equal((await h['session.get']({ sessionId }, context())).queueLength, 0)
    assert.deepEqual(await h['task.cancel']({ taskId: 't6' }, context()), { cancelled: true, how: 'stopped-session' })
    await waitFor('agent idle', () => ctx.agents.get(sessionId)?.status !== 'running')
  } finally {
    releaseClaim()
    stopClaim()
    // A failed assertion must not leave the scripted hanging turn blocking the
    // question/approval/schedule checks that share this session.
    if (ctx.agents.get(sessionId)?.status === 'running') await ctx.sessionController.cancel({ sessionId })
  }
})

await step('blocking ask_user_question: Remora holds it in the user-questions chain; attention.respond answers it', async () => {
  await h['task.start']({ target: { sessionId }, prompt: 'you must ask me first', idempotencyKey: 'k10' }, context('t10'))
  const item = await waitFor('held question', async () => {
    const list = await h['attention.list']({ sessionId }, context())
    return list.items.find(candidate => candidate.kind === 'question' && candidate.answerVia === 'remote')
  })
  assert.equal(item.answerable, true)
  assert.equal(typeof item.expiresAt, 'number', 'nothing else can answer here, so the wait has a deadline')
  await h['attention.respond']({ sessionId, attentionId: item.attentionId, answer: { optionId: '0' } }, context())
  await waitFor('t10 completed', () => records.get('t10')?.state === 'completed')
  assert.equal((await h['task.get']({ taskId: 't10' }, context())).result.reply, 'answered: Postgres')
})

await step('approvals: a DSH approval request is held; approval.respond allows it once; an unanswered one comes back unavailable', async () => {
  model.script.unshift({ hangAfter: dsh.textResponse('long').slice(0, 2) })
  await h['task.start']({ target: { sessionId }, prompt: 'hold the turn open', idempotencyKey: 'k11' }, context('t11'))
  await waitFor('t11 running', () => ctx.agents.get(sessionId)?.status === 'running')
  const agent = ctx.agents.get(sessionId)
  const decided = () => ctx.sessions.get(sessionId).snapshotEvents().filter(e => e.type === 'approval/decided').map(e => e.data.outcome)
  const first = ctx.approval.request({ agent, toolName: 'shell', reason: 'compat: write outside the workspace', signal: AbortSignal.timeout(20_000) })
  const item = await waitFor('held approval', async () => (await h['attention.list']({ sessionId }, context())).items.find(candidate => candidate.kind === 'approval' && candidate.answerable))
  assert.equal(item.answerVia, 'hub-passkey', 'approvals need the owner\'s passkey unless allowed from MCP and CLI')
  assert.match(item.attentionId, /^approval:/)
  await h['approval.respond']({ sessionId, attentionId: item.attentionId, answer: { approve: true } }, context())
  assert.equal(await first, 'allowed-once')
  assert.equal(decided().at(-1), 'allowed-once', 'DSH logged the outside decision')
  answerWait = 200
  assert.equal(await ctx.approval.request({ agent, toolName: 'shell', signal: AbortSignal.timeout(20_000) }), 'unavailable')
  assert.equal(decided().at(-1), 'unavailable')
  answerWait = 30_000
  await h['task.cancel']({ taskId: 't11' }, context())
  await waitFor('agent idle', () => ctx.agents.get(sessionId)?.status !== 'running')
})

await step('sessions.search: finds a prompt in the real session log (inspect), only in reachable sessions', async () => {
  const found = await h['sessions.search']({ query: 'HELLO there' }, context())
  const hit = found.hits.find(entry => entry.sessionId === sessionId && entry.role === 'user')
  assert.ok(hit, JSON.stringify(found))
  assert.equal(hit.turn, 1)
  assert.match(hit.snippet, /hello there/)
  assert.equal(found.partial, false)
})

await step('session.fork: the real sessionController.fork copies up to the end of turn 1 into a new session in the workspace', async () => {
  const forked = await h['session.fork']({ sessionId, atTurn: 1, title: 'Compat fork' }, context())
  assert.equal(forked.forkedFrom, sessionId)
  assert.equal(forked.session.workspaceId, workspace.id)
  assert.equal(forked.session.title, 'Compat fork')
  const copy = await h['session.read']({ sessionId: forked.session.sessionId, depth: 'turns' }, context())
  assert.equal(copy.turns.length, 1, 'only the first turn was copied')
  assert.match(copy.turns[0].request, /hello there/)
  assert.ok((await h['session.read']({ sessionId, depth: 'turns' }, context())).turns.length > 1, 'the original keeps every turn')
})

await step('schedules: the real schedule service creates, lists and deletes; a one-shot delivers its prompt as a new turn', async () => {
  const daily = await h['schedule.create']({ sessionId, title: 'Compat daily', prompt: 'daily check', when: { daily: { time: '09:00', timeZone: 'Asia/Tokyo' } }, idempotencyKey: 'sch-1' }, context())
  assert.equal(daily.schedule.rule, 'daily 09:00 Asia/Tokyo')
  assert.ok(daily.schedule.nextAt > Date.now())
  assert.equal((await h['schedule.create']({ sessionId, title: 'Compat daily', prompt: 'daily check', when: { daily: { time: '09:00', timeZone: 'Asia/Tokyo' } }, idempotencyKey: 'sch-1' }, context())).schedule.scheduleId, daily.schedule.scheduleId)
  await assert.rejects(h['schedule.create']({ sessionId, title: 'Bad', prompt: 'x', when: { cron: { expression: 'not a cron', timeZone: 'UTC' } }, idempotencyKey: 'sch-bad' }, context()), { code: 'invalid_request' })
  const before = userMessages(sessionId)
  const once = await h['schedule.create']({ sessionId, title: 'Compat once', prompt: 'scheduled hello from compat', when: { afterSeconds: 1 }, idempotencyKey: 'sch-2' }, context())
  assert.equal(once.schedule.kind, 'after')
  const listed = await h['schedules.list']({ sessionId }, context())
  assert.ok(listed.schedules.some(entry => entry.scheduleId === daily.schedule.scheduleId && entry.status === 'active'))
  await waitFor('the scheduled prompt reached the session', () => userMessages(sessionId) > before, 20_000)
  const delivered = ctx.sessions.get(sessionId).snapshotEvents().filter(e => e.type === 'user/message').at(-1)
  assert.match(JSON.stringify(delivered.data.content), /scheduled hello from compat/)
  await waitFor('agent idle after the scheduled turn', () => ctx.agents.get(sessionId)?.status !== 'running')
  assert.deepEqual(await h['schedule.delete']({ sessionId, scheduleId: daily.schedule.scheduleId }, context()), { deleted: true })
  assert.ok(!(await h['schedules.list']({ sessionId }, context())).schedules.some(entry => entry.scheduleId === daily.schedule.scheduleId))
})

await step('terminal.run: the real local subprocess service runs one command in the workspace folder, with a timeout', async () => {
  const ran = await h['terminal.run']({ cwdWorkspaceId: workspace.id, command: 'pwd; echo OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx; echo to-stderr >&2; exit 4' }, context())
  assert.equal(ran.exitCode, 4)
  assert.equal(ran.stdout.split('\n')[0], workspacePath)
  assert.ok(!ran.stdout.includes('sk-abcdefghijklmnop'), 'redacted')
  assert.equal(ran.stderr.trim(), 'to-stderr')
  const slow = await h['terminal.run']({ cwdWorkspaceId: workspace.id, command: 'sleep 20', timeoutMs: 1000 }, context())
  assert.equal(slow.timedOut, true)
  assert.ok(slow.durationMs < 10_000, `took ${slow.durationMs} ms`)
  await assert.rejects(h['terminal.run']({ cwdWorkspaceId: outside.id, command: 'ls' }, context()), { code: 'denied' })
})

await step('scope and target rules: out-of-scope workspace denied, archived session refused before DSH', async () => {
  await assert.rejects(h['task.start']({ target: { new: { workspaceId: outside.id } }, prompt: 'x', idempotencyKey: 'k8' }, context('t8')), { code: 'denied' })
  await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
  const prompts = userMessages(sessionId)
  await assert.rejects(h['task.start']({ target: { sessionId }, prompt: 'x', idempotencyKey: 'k9' }, context('t9')), { code: 'conflict' })
  assert.equal(userMessages(sessionId), prompts)
  assert.equal((await h['sessions.list']({}, context())).sessions.some(s => s.sessionId === sessionId), false, 'archived sessions are hidden')
  assert.equal((await h['sessions.list']({ includeArchived: true }, context())).sessions.find(s => s.sessionId === sessionId)?.archived, true)
  await ctx.workspaceRegistry.unarchiveSession(sessionId)
})

adapter.dispose()
await ctx.fiber.dispose()
await rm(root, { recursive: true, force: true }).catch(() => {})

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} compat checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
