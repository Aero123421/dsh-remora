import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Grant, RequestFrame, ResponseFrame } from '@dsh-remora/protocol'
import { Dispatcher } from '../src/core/dispatch.ts'
import type { PairedHub } from '../src/core/settings.ts'
import type { OperationContext, OperationHandlers } from '../src/ops/types.ts'
import { makeConfirmation, makePasskey } from './helpers.ts'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function fixture(handlers: OperationHandlers) {
  const state = {
    now: 1_000_000,
    ceiling: { level: 'full', fullAccessExpiresAt: 2_000_000 } as Grant,
    stopped: false,
    remoteApprovals: true,
    pinned: null as PairedHub | null,
    persist: async () => {},
  }
  const responses: ResponseFrame[] = []
  const dispatcher = new Dispatcher({
    handlers: () => handlers, ceiling: () => state.ceiling,
    killSwitch: () => state.stopped, allowsWithoutConfirmation: () => state.remoteApprovals,
    pinned: () => state.pinned,
    confirmations: { isUsed: () => false, markUsed: () => state.persist() },
    audit: () => {}, respond: value => { responses.push(value) }, now: () => state.now,
  })
  const frame = (op: string, params: unknown): RequestFrame => ({
    t: 'request', id: 'request', op, params,
    actor: { clientId: 'client', clientName: 'Test' }, scopes: ['dsh.read', 'dsh.content', 'dsh.tasks', 'dsh.admin'],
    grant: { level: 'full', fullAccessExpiresAt: 2_000_000 }, deadline: state.now + 60_000,
  })
  return { state, responses, dispatcher, frame }
}

test('a completed handler cannot disclose a result after its operation is disabled', async () => {
  const entered = gate(), resume = gate()
  const f = fixture({ 'goal.manage': async () => { entered.release(); await resume.promise; return { goal: { text: 'private goal', state: 'active' } } } })
  const pending = f.dispatcher.handle(f.frame('goal.manage', { sessionId: 's1', action: 'get' }))
  await entered.promise
  f.state.ceiling = { level: 'view' }
  resume.release()
  await pending
  assert.equal(f.responses[0]?.ok, false)
  assert.equal(f.responses[0]?.error?.code, 'denied')
  assert.equal(f.responses[0]?.result, undefined)
})

test('still-authorized reads continue after narrowing; fullAccess reflects current expiry', async () => {
  const entered = gate(), resume = gate()
  let captured!: OperationContext
  const f = fixture({ 'sessions.list': async (_params, ctx) => {
    captured = ctx
    assert.equal(ctx.fullAccess, true)
    entered.release(); await resume.promise
    ctx.assertAuthorized?.()
    assert.equal(ctx.fullAccess, false)
    return { sessions: [], nextCursor: null }
  } })
  const request = f.frame('sessions.list', {})
  request.grant.fullAccessExpiresAt = f.state.now + 10
  const pending = f.dispatcher.handle(request)
  await entered.promise
  f.state.now += 11
  f.state.ceiling = { level: 'view' }
  assert.equal(captured.fullAccess, false)
  resume.release(); await pending
  assert.equal(f.responses[0]?.ok, true)
})

test('abortAll settles requests and stops a late handler from executing its next effect', async () => {
  const entered = gate(), resume = gate(), finished = gate()
  let effected = false
  const f = fixture({ 'goal.manage': async (_params, ctx) => {
    entered.release(); await resume.promise
    try { ctx.assertAuthorized?.(); effected = true; return { goal: null } }
    finally { finished.release() }
  } })
  const pending = f.dispatcher.handle(f.frame('goal.manage', { sessionId: 's1', action: 'set', goal: 'work' }))
  await entered.promise
  f.dispatcher.abortAll('unloading')
  await pending
  assert.equal(f.dispatcher.pending, 0)
  assert.equal(f.responses[0]?.error?.code, 'unavailable')
  resume.release(); await finished.promise
  assert.equal(effected, false)
})

for (const change of ['stop', 'permission', 'credential'] as const) {
  test(`confirmation persistence rechecks ${change} before entering a dangerous handler`, async () => {
    const entered = gate(), resume = gate()
    let called = false
    const f = fixture({ 'terminal.run': async () => { called = true; return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', truncated: false, durationMs: 0, untrusted: true } } })
    const key = makePasskey('ed25519')
    f.state.pinned = { hubOrigin: 'https://hub.example', hostId: 'host', rpId: 'hub.example', owner: [key.credential], publicKey: 'host-key', pairedAt: 0 }
    f.state.persist = async () => { entered.release(); await resume.promise }
    const request = f.frame('terminal.run', { cwdWorkspaceId: 'w1', command: 'echo test' })
    request.confirmation = await makeConfirmation(key, {
      hubOrigin: f.state.pinned.hubOrigin, hostId: 'host', rpId: 'hub.example',
      requestId: request.id, operation: request.op, params: request.params, issuedAt: f.state.now,
    })
    const pending = f.dispatcher.handle(request)
    await entered.promise
    if (change === 'stop') f.state.stopped = true
    else if (change === 'permission') f.state.ceiling = { level: 'request' }
    else f.state.pinned = { ...f.state.pinned, owner: [] }
    resume.release(); await pending
    assert.equal(called, false)
    assert.equal(f.responses[0]?.error?.code, 'denied')
  })
}

test('a finished terminal command says so when the grant expired during the run', async () => {
  const entered = gate(), resume = gate()
  const f = fixture({ 'terminal.run': async () => {
    entered.release(); await resume.promise
    return { exitCode: 0, signal: null, timedOut: false, stdout: 'done', stderr: '', truncated: false, durationMs: 65_000, untrusted: true }
  } })
  const key = makePasskey('ed25519')
  f.state.pinned = { hubOrigin: 'https://hub.example', hostId: 'host', rpId: 'hub.example', owner: [key.credential], publicKey: 'host-key', pairedAt: 0 }
  const request = f.frame('terminal.run', { cwdWorkspaceId: 'w1', command: 'sleep 65', timeoutMs: 120_000 })
  request.grant = { level: 'full', fullAccessExpiresAt: f.state.now + 60_000 }
  request.deadline = f.state.now + 180_000
  request.confirmation = await makeConfirmation(key, {
    hubOrigin: 'https://hub.example', hostId: 'host', rpId: 'hub.example',
    requestId: request.id, operation: request.op, params: request.params, issuedAt: f.state.now,
  })
  const pending = f.dispatcher.handle(request)
  await entered.promise
  f.state.now += 65_000
  resume.release()
  await pending
  assert.equal(f.responses[0]?.ok, false)
  assert.equal(f.responses[0]?.error?.denial?.reason, 'full-access-expired')
  assert.match(f.responses[0]?.error?.message ?? '', /already finished/)
  assert.doesNotMatch(f.responses[0]?.error?.message ?? '', /never/i)
})

test('a terminal command whose grant covers the timeout still returns the result', async () => {
  const entered = gate(), resume = gate()
  const f = fixture({ 'terminal.run': async () => {
    entered.release(); await resume.promise
    return { exitCode: 0, signal: null, timedOut: false, stdout: 'done', stderr: '', truncated: false, durationMs: 65_000, untrusted: true }
  } })
  const key = makePasskey('ed25519')
  f.state.pinned = { hubOrigin: 'https://hub.example', hostId: 'host', rpId: 'hub.example', owner: [key.credential], publicKey: 'host-key', pairedAt: 0 }
  const request = f.frame('terminal.run', { cwdWorkspaceId: 'w1', command: 'sleep 65', timeoutMs: 120_000 })
  request.grant = { level: 'full', fullAccessExpiresAt: f.state.now + 120_000 + 30_000 }
  request.deadline = f.state.now + 180_000
  request.confirmation = await makeConfirmation(key, {
    hubOrigin: 'https://hub.example', hostId: 'host', rpId: 'hub.example',
    requestId: request.id, operation: request.op, params: request.params, issuedAt: f.state.now,
  })
  const pending = f.dispatcher.handle(request)
  await entered.promise
  f.state.now += 65_000
  resume.release()
  await pending
  assert.equal(f.responses[0]?.ok, true)
  assert.equal((f.responses[0]?.result as { stdout?: string } | undefined)?.stdout, 'done')
})

test('a kill switch after the command finished still names the command as finished', async () => {
  const entered = gate(), resume = gate()
  const f = fixture({ 'terminal.run': async () => {
    entered.release(); await resume.promise
    return { exitCode: 0, signal: null, timedOut: false, stdout: 'done', stderr: '', truncated: false, durationMs: 1, untrusted: true }
  } })
  const key = makePasskey('ed25519')
  f.state.pinned = { hubOrigin: 'https://hub.example', hostId: 'host', rpId: 'hub.example', owner: [key.credential], publicKey: 'host-key', pairedAt: 0 }
  const request = f.frame('terminal.run', { cwdWorkspaceId: 'w1', command: 'true', timeoutMs: 60_000 })
  request.deadline = f.state.now + 180_000
  request.confirmation = await makeConfirmation(key, {
    hubOrigin: 'https://hub.example', hostId: 'host', rpId: 'hub.example',
    requestId: request.id, operation: request.op, params: request.params, issuedAt: f.state.now,
  })
  const pending = f.dispatcher.handle(request)
  await entered.promise
  f.state.stopped = true
  resume.release()
  await pending
  assert.equal(f.responses[0]?.ok, false)
  assert.equal(f.responses[0]?.error?.denial?.reason, 'kill-switch')
  assert.match(f.responses[0]?.error?.message ?? '', /already finished/)
})

test('requiring passkeys again prevents an unconfirmed approval after an async wait', async () => {
  const entered = gate(), resume = gate()
  let answered = false
  const f = fixture({ 'approval.respond': async (_params, ctx) => {
    entered.release(); await resume.promise
    ctx.assertAuthorized?.(); answered = true
    return { accepted: true }
  } })
  const pending = f.dispatcher.handle(f.frame('approval.respond', { sessionId: 's1', attentionId: 'q1', answer: { approve: true } }))
  await entered.promise
  f.state.remoteApprovals = false
  resume.release(); await pending
  assert.equal(answered, false)
  assert.equal(f.responses[0]?.error?.denial?.reason, 'confirmation-failed')
})

test('a deadline reached during a native await prevents the next effect', async () => {
  const entered = gate(), resume = gate()
  let effected = false
  const f = fixture({ 'goal.manage': async (_params, ctx) => {
    entered.release(); await resume.promise
    ctx.assertAuthorized?.(); effected = true
    return { goal: null }
  } })
  const request = f.frame('goal.manage', { sessionId: 's1', action: 'set', goal: 'work' })
  const pending = f.dispatcher.handle(request)
  await entered.promise
  f.state.now = request.deadline
  resume.release(); await pending
  assert.equal(effected, false)
  assert.equal(f.responses[0]?.error?.code, 'unavailable')
})
