import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Grant, RequestFrame, ResponseFrame } from '@dsh-remora/protocol'
import { buildAdapter } from '../src/adapter/index.ts'
import { Dispatcher, effectiveFullAccess } from '../src/core/dispatch.ts'
import { SettingsScopePolicy } from '../src/core/scope.ts'
import { defaultSettings, parseSettings, type RemoraSettings } from '../src/core/settings.ts'
import type { OperationContext } from '../src/ops/types.ts'
import { createFake, harness } from './fake-dsh.ts'

const NOW = 1_000_000
const fullCeiling: Grant = { level: 'full', fullAccessExpiresAt: NOW + 3_600_000 }

function setup(settings: RemoraSettings) {
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a')
  dsh.addSession('s1', { workspace: 'ws-a', live: true })
  const h = harness(dsh)
  const scope = new SettingsScopePolicy({ settings: () => settings, markUntrusted: async () => {}, now: () => NOW })
  const adapter = buildAdapter(dsh.ctx(), { ...h.deps, scope })
  const responses: ResponseFrame[] = []
  const dispatcher = new Dispatcher({
    handlers: () => adapter.handlers,
    ceiling: () => settings.ceiling,
    killSwitch: () => false,
    pinned: () => null,
    confirmations: { isUsed: () => false, markUsed: async () => {} },
    audit: () => {},
    respond: frame => { responses.push(frame) },
    now: () => NOW,
  })
  const send = async (op: string, params: unknown, grant: Grant): Promise<ResponseFrame> => {
    const frame: RequestFrame = { t: 'request', id: `r${responses.length}`, op, params, actor: { clientId: 'c', clientName: 'Attacker' }, scopes: ['dsh.read', 'dsh.content', 'dsh.tasks', 'dsh.admin'], grant, deadline: NOW + 60_000, taskId: `t${responses.length}` }
    await dispatcher.handle(frame)
    return responses.at(-1)!
  }
  return { dsh, send }
}

test('attack: a "request" client cannot raise the DSH permission preset while full access is on', async () => {
  // Even if the owner had listed /permission, it is dropped when settings are parsed.
  const settings = parseSettings({ ...defaultSettings(), ceiling: fullCeiling, scope: { ...defaultSettings().scope, workspaces: ['ws-a'], commands: ['/compact', '/permission', '/Feedback'] } })
  assert.deepEqual(settings.scope.commands, ['/compact'])
  const { dsh, send } = setup(settings)
  for (const grant of [{ level: 'request' } as Grant, fullCeiling]) {
    const response = await send('command.run', { sessionId: 's1', command: '/permission', args: 'danger-full-access' }, grant)
    assert.equal(response.ok, false)
    assert.equal(response.error?.code, 'denied')
    assert.equal(response.error?.denial?.layer, 'dsh')
  }
  // Other unlisted commands are not opened up by full access either.
  assert.equal((await send('command.run', { sessionId: 's1', command: '/goal' }, fullCeiling)).error?.code, 'denied')
  assert.equal(dsh.calls.filter(call => call.method === 'command').length, 0, 'DSH never saw a command')
  // An explicitly allowed, harmless command still works.
  assert.equal((await send('command.run', { sessionId: 's1', command: '/compact' }, { level: 'request' })).ok, true)
})

test('attack: full access does not unlock agent presets or skills for a new task', async () => {
  const settings: RemoraSettings = { ...defaultSettings(), ceiling: fullCeiling, scope: { ...defaultSettings().scope, workspaces: ['ws-a'] } }
  const { dsh, send } = setup(settings)
  const preset = await send('task.start', { target: { new: { workspaceId: 'ws-a', agentPreset: 'cordis' } }, prompt: 'x', idempotencyKey: 'k1' }, fullCeiling)
  assert.equal(preset.error?.code, 'denied', preset.error?.message)
  const skill = await send('task.start', { target: { sessionId: 's1' }, prompt: 'x', skills: ['review'], idempotencyKey: 'k2' }, fullCeiling)
  assert.equal(skill.error?.code, 'denied', skill.error?.message)
  assert.equal(dsh.calls.filter(call => call.method === 'prompt' || call.method === 'create').length, 0)
})

test('fullAccess in the operation context is ceiling ∩ the caller grant, with expiry', async () => {
  assert.equal(effectiveFullAccess(fullCeiling, { level: 'request' }, NOW), false)
  assert.equal(effectiveFullAccess(fullCeiling, { level: 'full', fullAccessExpiresAt: NOW - 1 }, NOW), false)
  assert.equal(effectiveFullAccess({ level: 'full', fullAccessExpiresAt: NOW - 1 }, { level: 'full' }, NOW), false)
  assert.equal(effectiveFullAccess(fullCeiling, { level: 'full', fullAccessExpiresAt: NOW + 1 }, NOW), true)
  const seen: OperationContext[] = []
  const dispatcher = new Dispatcher({
    handlers: () => ({ 'sessions.list': async (_params, context) => { seen.push(context); return { sessions: [], nextCursor: null } } }),
    ceiling: () => fullCeiling,
    killSwitch: () => false,
    pinned: () => null,
    confirmations: { isUsed: () => false, markUsed: async () => {} },
    audit: () => {},
    respond: () => {},
    now: () => NOW,
  })
  for (const grant of [{ level: 'request' } as Grant, { level: 'full', fullAccessExpiresAt: NOW + 5 } as Grant]) {
    await dispatcher.handle({ t: 'request', id: `x${seen.length}`, op: 'sessions.list', params: {}, actor: { clientId: 'c', clientName: 'c' }, scopes: ['dsh.read'], grant, deadline: NOW + 60_000 })
  }
  assert.deepEqual(seen.map(context => context.fullAccess), [false, true])
})

test('no remote path drives agent turns in an untrusted or cloning workspace', async () => {
  const { buildAdapter: build } = await import('../src/adapter/index.ts')
  const { context } = await import('./fake-dsh.ts')
  const dsh = createFake()
  dsh.addWorkspace('ws-u', '/work/u')
  dsh.addWorkspace('ws-c', '/work/c')
  const u = dsh.addSession('su', { workspace: 'ws-u', live: true })
  dsh.addSession('sc', { workspace: 'ws-c', live: true })
  u.values.userQuestions = { active: [{ callId: 'call-1', state: 'continued', questions: [{ id: 'q', question: 'Ok?', options: [{ label: 'Yes' }] }] }], settled: [] }
  const h = harness(dsh, { workspaces: ['ws-u', 'ws-c'], untrusted: ['ws-u'], commands: ['/compact', '/goal'] })
  const creations = [{ key: 'c\u0000k', workspaceId: 'ws-c', path: '/work/c', name: 'c', state: 'cloning' as const, createdAt: 1, updatedAt: 1 }]
  const adapter = build(dsh.ctx(), { ...h.deps, workspaceCreations: { list: () => creations, put: async () => {} } }, { deferRecovery: true })
  const handlers = adapter.handlers as Required<typeof adapter.handlers>
  const code = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: { code?: string }) => error.code)
  for (const [sessionId, expected] of [['su', 'denied'], ['sc', 'conflict']] as const) {
    assert.equal(await code(handlers['goal.manage']({ sessionId, action: 'set', goal: 'ship it' }, context())), expected, `goal set ${sessionId}`)
    assert.equal(await code(handlers['goal.manage']({ sessionId, action: 'resume' }, context())), expected, `goal resume ${sessionId}`)
    assert.equal(await code(handlers['command.run']({ sessionId, command: '/goal', args: 'do things' }, context())), expected, `command ${sessionId}`)
    assert.equal(await code(handlers['command.run']({ sessionId, command: '/compact' }, context())), expected)
    assert.equal(await code(handlers['task.start']({ target: { sessionId }, prompt: 'x', idempotencyKey: sessionId }, context({ taskId: `t-${sessionId}` }))), expected)
    // A schedule starts turns later: same rule.
    assert.equal(await code(handlers['schedule.create']({ sessionId, title: 'later', prompt: 'x', when: { afterSeconds: 60 }, idempotencyKey: `s-${sessionId}` }, context())), expected, `schedule ${sessionId}`)
  }
  assert.equal(dsh.scheduleRows.length, 0, 'no schedule was created')
  assert.equal(await code(handlers['attention.respond']({ sessionId: 'su', attentionId: 'call-1', answer: { optionId: '0' } }, context())), 'denied')
  assert.deepEqual(dsh.answers, [])
  assert.equal(dsh.calls.filter(call => ['command', 'prompt', 'resolveAgent'].includes(call.method)).length, 0, 'no agent was woken or driven')
  // Operations that start no turn still work.
  assert.equal(await code(handlers['model.select']({ sessionId: 'su', model: 'deepseek-chat' }, context())), 'ok')
  assert.notEqual(await code(handlers['goal.manage']({ sessionId: 'su', action: 'pause' }, context())), 'denied')
})
