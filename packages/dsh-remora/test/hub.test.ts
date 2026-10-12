import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Grant, RequestFrame } from '@dsh-remora/protocol'
import { apply } from '../src/index.ts'
import { InstanceLock } from '../src/core/lock.ts'
import { OperationError, type AdapterDeps, type CreateAdapter } from '../src/ops/types.ts'
import type { RemoraSnapshot } from '../src/state.ts'
import { FakeHub } from './fake-hub.ts'
import { fakeHost, makeConfirmation, makePasskey, rpc, tempDir, until } from './helpers.ts'

const PORT = 18090

function fakeAdapter() {
  let deps: AdapterDeps | undefined
  let started = 0
  const create: CreateAdapter = (_ctx, d) => {
    deps = d
    return {
      handlers: {
        'sessions.list': async () => ({ sessions: [], nextCursor: null }),
        'session.get': async () => { throw new OperationError('not_found', 'no such session') },
        'session.read': async () => { throw new Error('secret internals at /home/me') },
        'task.start': async (_params, context) => ({ task: { taskId: context.taskId, state: 'accepted' } }) as never,
        'task.get': (_params, context) => new Promise((_, reject) => context.signal.addEventListener('abort', () => reject(new Error('aborted')))),
        'terminal.run': async () => ({ output: 'done', exitCode: 0 }) as never,
        'approval.respond': async () => ({ accepted: true }),
      },
      has: () => true,
      start: () => { started++ },
      dispose: () => {},
    }
  }
  return { create, deps: () => deps, started: () => started }
}

function request(id: string, op: string, params: unknown, grant: Grant, scopes: string[], extra: Partial<RequestFrame> = {}): RequestFrame {
  return { t: 'request', id, op, params, actor: { clientId: 'client-1', clientName: 'Claude' }, scopes, grant, deadline: Date.now() + 10_000, ...extra }
}

const remote = { host: 'dsh.example.com', origin: 'https://dsh.example.com' }

test('pair, connect, dispatch with permission checks, events, kill switch and passkey confirmation', async () => {
  const { dir, cleanup } = await tempDir()
  const passkey = makePasskey('es256', 'owner-1')
  const hub = new FakeHub({ port: PORT, owner: [passkey.credential], pendingPolls: 1 })
  await hub.listen()
  const host = fakeHost()
  const adapter = fakeAdapter()
  const core = apply(host.ctx, undefined, { dataDir: dir, createAdapter: adapter.create })
  try {
    await core.ready
    const state = async () => {
      const result = await rpc<RemoraSnapshot>(host.routes, 'state')
      assert.ok(result.ok)
      return result.value
    }
    assert.equal((await state()).hub.paired, false)

    // Pairing is refused from another device, then started locally.
    const refused = await rpc(host.routes, 'pairing-start', { hubUrl: hub.origin }, remote)
    assert.deepEqual(refused.ok ? null : refused.error.code, 'remora/local-only')
    const started = await rpc<RemoraSnapshot>(host.routes, 'pairing-start', { hubUrl: `${hub.origin}/some/path` })
    assert.ok(started.ok)
    assert.equal(started.value.pairing.phase, 'waiting')
    assert.equal(started.value.pairing.userCode, 'ABCD-2345')
    await until(() => core.internals.link.connected, 8000, 'hub connection')
    assert.equal(hub.pollSignaturesValid, true)
    assert.equal(hub.polls, 2)
    const paired = await state()
    assert.equal(paired.hub.paired, true)
    assert.equal(paired.hub.hostId, hub.hostId)
    assert.equal(paired.hub.lock, 'held')
    assert.equal(adapter.started(), 1)
    const hello = hub.hellos[0] as { name: string; operations: string[]; ceiling: Grant; killSwitch: boolean }
    assert.deepEqual(hello.ceiling, { level: 'view' })
    assert.deepEqual([...hello.operations].sort(), ['approval.respond', 'host.rotate-key', 'session.get', 'session.read', 'sessions.list', 'task.get', 'task.start', 'terminal.run'])

    const full: Grant = { level: 'full', fullAccessExpiresAt: Date.now() + 60_000 }
    hub.send(request('r1', 'sessions.list', {}, full, ['dsh.read']))
    assert.deepEqual(await hub.response('r1'), { t: 'response', id: 'r1', ok: true, result: { sessions: [], nextCursor: null } })

    hub.send(request('r2', 'task.start', { target: { sessionId: 's1' }, prompt: 'hi', idempotencyKey: 'k1' }, full, ['dsh.tasks'], { taskId: 'task-1' }))
    const denied = await hub.response('r2')
    assert.equal(denied.error?.code, 'denied')
    assert.deepEqual(denied.error?.denial, { layer: 'dsh', reason: 'level-too-low' })
    assert.equal(denied.error?.fix, 'dsh:settings/remora#permissions')

    hub.send(request('r3', 'sessions.list', { bogus: 1 }, full, ['dsh.read']))
    assert.equal((await hub.response('r3')).error?.code, 'invalid_request')
    hub.send(request('r4', 'session.get', { sessionId: 'x' }, full, ['dsh.read']))
    assert.deepEqual((await hub.response('r4')).error, { code: 'not_found', message: 'no such session' })
    hub.send(request('r5', 'session.read', { sessionId: 'x', depth: 'summary' }, full, ['dsh.content']))
    const internal = await hub.response('r5')
    assert.deepEqual(internal.error, { code: 'internal', message: 'Internal error on the DSH host.' })
    hub.send(request('r6', 'sessions.list', {}, { level: 'view', overrides: { 'sessions.list': false } }, ['dsh.read']))
    assert.deepEqual((await hub.response('r6')).error?.denial, { layer: 'hub', reason: 'switched-off' })
    hub.send(request('r7', 'sessions.list', {}, full, ['dsh.tasks']))
    assert.deepEqual((await hub.response('r7')).error?.denial, { layer: 'token', reason: 'missing-scope' })
    hub.send(request('r8', 'status', {}, full, ['dsh.read']))
    assert.equal((await hub.response('r8')).error?.code, 'not_found')
    hub.send(request('r9', 'task.get', { taskId: 't' }, full, ['dsh.read'], { deadline: Date.now() + 1300 }))
    assert.equal((await hub.response('r9')).error?.code, 'unavailable')

    // Raising the ceiling only from this PC; it is announced to the hub.
    const remoteRaise = await rpc(host.routes, 'permission', { level: 'request' }, remote)
    assert.equal(remoteRaise.ok ? null : remoteRaise.error.code, 'remora/local-only')
    assert.ok((await rpc(host.routes, 'permission', { level: 'request' })).ok)
    await until(() => hub.events().some(e => e.kind === 'host-status' && e.ceiling.level === 'request'), 3000, 'host-status')
    hub.send(request('r10', 'task.start', { target: { sessionId: 's1' }, prompt: 'hi', idempotencyKey: 'k1' }, full, ['dsh.tasks'], { taskId: 'task-1' }))
    assert.deepEqual((await hub.response('r10')).result, { task: { taskId: 'task-1', state: 'accepted' } })
    // Lowering is fine from anywhere.
    assert.ok((await rpc(host.routes, 'permission', { level: 'view' }, remote)).ok)

    // Events from the adapter: completion goes out immediately.
    adapter.deps()?.emit({ kind: 'task', taskId: 'task-1', state: 'completed', updatedAt: 5 })
    await until(() => hub.events().some(e => e.kind === 'task' && e.state === 'completed'), 3000, 'task event')

    // Full access needs the confirmation flag, and dangerous operations need the passkey.
    const noConfirm = await rpc(host.routes, 'permission', { level: 'full' })
    assert.equal(noConfirm.ok ? null : noConfirm.error.code, 'remora/full-confirmation-required')
    const fullState = await rpc<RemoraSnapshot>(host.routes, 'permission', { level: 'full', confirmFull: true })
    assert.ok(fullState.ok && fullState.value.fullAccess.active)
    const params = { command: 'ls', cwdWorkspaceId: 'w1' }
    hub.send(request('r11', 'terminal.run', params, full, ['dsh.admin']))
    assert.equal((await hub.response('r11')).error?.code, 'denied')
    const confirmation = await makeConfirmation(passkey, { hubOrigin: hub.origin, rpId: '127.0.0.1', hostId: hub.hostId, requestId: 'r12', operation: 'terminal.run', params, issuedAt: Date.now() })
    hub.send(request('r12', 'terminal.run', params, full, ['dsh.admin'], { confirmation }))
    assert.deepEqual(await hub.response('r12'), { t: 'response', id: 'r12', ok: true, result: { output: 'done', exitCode: 0 } })
    hub.received.length = 0
    hub.send(request('r12', 'terminal.run', params, full, ['dsh.admin'], { confirmation }))
    assert.match((await hub.response('r12')).error?.message ?? '', /replayed/)
    const used = JSON.parse(await readFile(join(dir, 'confirmations.json'), 'utf8')) as { data: { used: Record<string, number> } }
    assert.ok(used.data.used.r12)

    // A changed owner credential set waits for the DSH user.
    const second = makePasskey('ed25519', 'owner-2')
    hub.send({ t: 'owner-credentials', credentials: [passkey.credential, second.credential] })
    await until(() => core.internals.pairing().pendingCredentials !== null, 3000, 'pending credentials')
    const pendingState = await state()
    assert.deepEqual(pendingState.pendingCredentials?.added, ['owner-2'])
    const remoteAccept = await rpc(host.routes, 'owner-credentials', { accept: true }, remote)
    assert.equal(remoteAccept.ok ? null : remoteAccept.error.code, 'remora/local-only')
    assert.ok((await rpc(host.routes, 'owner-credentials', { accept: true })).ok)
    assert.equal(core.internals.pairing().paired?.owner.length, 2)

    // The kill switch refuses everything and drops the link; turning it off again needs this PC.
    const killed = await rpc<RemoraSnapshot>(host.routes, 'kill-switch', { on: true }, remote)
    assert.ok(killed.ok && killed.value.settings.killSwitch)
    await until(() => hub.events().some(e => e.kind === 'host-status' && e.killSwitch), 3000, 'kill switch status')
    await until(() => hub.socket === null, 3000, 'socket closed')
    assert.equal(core.internals.link.status.state, 'stopped')
    const remoteResume = await rpc(host.routes, 'kill-switch', { on: false }, remote)
    assert.equal(remoteResume.ok ? null : remoteResume.error.code, 'remora/local-only')
    assert.ok((await rpc(host.routes, 'kill-switch', { on: false })).ok)
    await until(() => core.internals.link.connected, 5000, 'reconnect after kill switch')

    // Audit and connected clients.
    const audit = await rpc<{ entries: { action: string; outcome: string; clientName?: string }[] }>(host.routes, 'audit')
    assert.ok(audit.ok && audit.value.entries.some(e => e.action === 'task.start' && e.outcome === 'denied'))
    const clients = await rpc<{ clients: { clientId: string; requests: number; denied: number }[] }>(host.routes, 'clients')
    assert.ok(clients.ok && clients.value.clients[0]?.clientId === 'client-1' && clients.value.clients[0].denied > 0)
    const auditText = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    assert.ok(!auditText.includes('prompt') && !auditText.includes('cwdWorkspaceId') && !auditText.includes('"hi"'), 'no prompts or parameters in the audit log')

    // Unpair forgets the key and stops the link.
    assert.ok((await rpc(host.routes, 'unpair', {}, remote)).ok)
    const unpaired = await state()
    assert.equal(unpaired.hub.paired, false)
    assert.equal(hub.unpaired, true, 'the hub got a valid signed unpair request')
    assert.equal(unpaired.lastUnpair?.hub, 'removed')
    assert.equal(core.internals.link.status.state, 'idle')
  } finally {
    host.dispose()
    await core.dispose()
    await hub.close()
    await cleanup()
  }
})

test('a second DSH process with the same data folder does not connect', async () => {
  const { dir, cleanup } = await tempDir()
  const passkey = makePasskey('ed25519')
  const hub = new FakeHub({ port: PORT + 1, owner: [passkey.credential] })
  await hub.listen()
  const first = fakeHost()
  const firstCore = apply(first.ctx, undefined, { dataDir: dir, createAdapter: fakeAdapter().create })
  let secondCore: ReturnType<typeof apply> | undefined
  const second = fakeHost()
  try {
    await firstCore.ready
    assert.ok((await rpc(first.routes, 'pairing-start', { hubUrl: hub.origin })).ok)
    await until(() => firstCore.internals.link.connected, 8000, 'first connection')
    secondCore = apply(second.ctx, undefined, { dataDir: dir, createAdapter: fakeAdapter().create })
    await secondCore.ready
    const snapshot = await rpc<RemoraSnapshot>(second.routes, 'state')
    assert.ok(snapshot.ok)
    assert.equal(snapshot.value.hub.lock, 'other')
    assert.equal(hub.connections, 1)
    // With the hub gone, unpairing still clears local state and says so.
    await hub.close()
    const result = await rpc<RemoraSnapshot>(first.routes, 'unpair')
    assert.ok(result.ok)
    assert.equal(result.value.hub.paired, false)
    assert.equal(result.value.lastUnpair?.hub, 'unreachable')
  } finally {
    first.dispose(); second.dispose()
    await secondCore?.dispose()
    await firstCore.dispose()
    await hub.close().catch(() => {})
    await cleanup()
  }
})

test('pairing that the owner denies is reported', async () => {
  const { dir, cleanup } = await tempDir()
  const hub = new FakeHub({ port: PORT + 2, owner: [makePasskey('es256').credential], approve: 'denied' })
  await hub.listen()
  const host = fakeHost()
  const core = apply(host.ctx, undefined, { dataDir: dir, createAdapter: fakeAdapter().create })
  try {
    await core.ready
    assert.ok((await rpc(host.routes, 'pairing-start', { hubUrl: hub.origin })).ok)
    await until(() => core.snapshot(true).pairing.phase === 'denied', 5000, 'denied')
    assert.equal(core.snapshot(true).hub.paired, false)
    const bad = await rpc(host.routes, 'pairing-start', { hubUrl: 'ftp://example.com' })
    assert.equal(bad.ok ? null : bad.error.code, 'remora/pairing-invalid-hub-url')
  } finally {
    host.dispose()
    await core.dispose()
    await hub.close()
    await cleanup()
  }
})

test('approvals need the owner\'s passkey unless this PC allows them from MCP and CLI', async () => {
  const { dir, cleanup } = await tempDir()
  const passkey = makePasskey('es256', 'owner-1')
  const hub = new FakeHub({ port: PORT + 3, owner: [passkey.credential] })
  await hub.listen()
  const host = fakeHost()
  const adapter = fakeAdapter()
  const core = apply(host.ctx, undefined, { dataDir: dir, createAdapter: adapter.create })
  try {
    await core.ready
    assert.ok((await rpc(host.routes, 'pairing-start', { hubUrl: hub.origin })).ok)
    await until(() => core.internals.link.connected, 8000, 'hub connection')
    assert.ok((await rpc(host.routes, 'permission', { level: 'request' })).ok)
    const answers = adapter.deps()!.answers!
    assert.equal(answers.waitMs(), 10 * 60_000, 'Remora waits 10 minutes by default')
    assert.equal(answers.approvalsFromRemote(), false)
    assert.equal(answers.allows('approval.respond'), true)
    assert.equal(answers.linked(), true)

    const grant: Grant = { level: 'request' }
    const params = { sessionId: 's1', attentionId: 'approval:a1', answer: { approve: true } }
    hub.send(request('a1', 'approval.respond', params, grant, ['dsh.tasks']))
    const refused = await hub.response('a1')
    assert.equal(refused.error?.code, 'denied')
    assert.deepEqual(refused.error?.denial, { layer: 'dsh', reason: 'confirmation-failed' })
    assert.match(refused.error?.message ?? '', /Allow approvals from MCP and CLI/)

    // The hub page sends the owner's passkey: accepted, and checked like any confirmation.
    const confirmation = await makeConfirmation(passkey, { hubOrigin: hub.origin, rpId: '127.0.0.1', hostId: hub.hostId, requestId: 'a2', operation: 'approval.respond', params, issuedAt: Date.now() })
    hub.send(request('a2', 'approval.respond', params, grant, ['dsh.tasks'], { confirmation }))
    assert.deepEqual((await hub.response('a2')).result, { accepted: true })
    hub.send(request('a3', 'approval.respond', { ...params, answer: { approve: false } }, grant, ['dsh.tasks'], { confirmation }))
    assert.equal((await hub.response('a3')).error?.denial?.reason, 'confirmation-failed', 'a confirmation is bound to its request')

    // Allowing approvals without a passkey, or turning waiting back on, needs this PC; turning them off does not.
    const remoteOn = await rpc(host.routes, 'answers', { approvalsFromRemote: true }, remote)
    assert.equal(remoteOn.ok ? null : remoteOn.error.code, 'remora/local-only')
    const on = await rpc<RemoraSnapshot>(host.routes, 'answers', { approvalsFromRemote: true, waitMinutes: 5 })
    assert.ok(on.ok && on.value.settings.approvalsFromRemote && on.value.settings.remoteAnswerWaitMs === 5 * 60_000)
    assert.equal(answers.approvalsFromRemote(), true)
    hub.send(request('a4', 'approval.respond', params, grant, ['dsh.tasks']))
    assert.deepEqual((await hub.response('a4')).result, { accepted: true })
    const bad = await rpc(host.routes, 'answers', { waitMinutes: 2000 })
    assert.equal(bad.ok ? null : bad.error.code, 'remora/invalid-payload')
    assert.ok((await rpc(host.routes, 'answers', { approvalsFromRemote: false, waitMinutes: 0 }, remote)).ok)
    assert.equal(answers.waitMs(), 0)
    const remoteWait = await rpc(host.routes, 'answers', { waitMinutes: 10 }, remote)
    assert.equal(remoteWait.ok ? null : remoteWait.error.code, 'remora/local-only')
    hub.send(request('a5', 'approval.respond', params, grant, ['dsh.tasks']))
    assert.equal((await hub.response('a5')).error?.denial?.reason, 'confirmation-failed')

    // The kill switch and a ceiling without the operation stop outside answers.
    assert.ok((await rpc(host.routes, 'permission', { level: 'view' }, remote)).ok)
    assert.equal(answers.allows('approval.respond'), false)
    const audit = await rpc<{ entries: { action: string; outcome: string; reason?: string }[] }>(host.routes, 'audit')
    assert.ok(audit.ok && audit.value.entries.some(e => e.action === 'approval.respond' && e.outcome === 'denied' && e.reason === 'confirmation-failed'))
    assert.ok(audit.ok && audit.value.entries.some(e => e.action === 'approvals-from-remote:on,answer-wait:5m' || e.action === 'answer-wait:5m,approvals-from-remote:on'))
  } finally {
    host.dispose()
    await core.dispose()
    await hub.close()
    await cleanup()
  }
})

test('host key rotation: the new key proves itself, survives a restart, and a refused new key falls back to the old one', async () => {
  const { dir, cleanup } = await tempDir()
  const auditLock = new InstanceLock(dir, 'audit.lock')
  const hub = new FakeHub({ port: PORT + 9, owner: [makePasskey('es256').credential] })
  await hub.listen()
  let host = fakeHost()
  let core = apply(host.ctx, undefined, { dataDir: dir, createAdapter: fakeAdapter().create })
  try {
    await core.ready
    assert.ok((await rpc(host.routes, 'pairing-start', { hubUrl: hub.origin })).ok)
    await until(() => core.internals.link.connected, 8000, 'first connection')
    const first = hub.publicKey
    const connections = hub.connections

    await core.auditEntries()
    assert.equal(await auditLock.acquire(), true)
    const rotated = await hub.rotate()
    await until(() => hub.publicKey === rotated && core.internals.link.connected && hub.connections > connections, 5000, 'reconnected with the new key')
    assert.notEqual(rotated, first)
    assert.deepEqual(hub.keysUsed, ['next'])
    await until(() => core.internals.keys().previous === null && core.internals.pairing().paired?.publicKey === rotated, 3000, 'previous key dropped')
    // Reconnecting does not mean the asynchronous audit writes have finished.
    // Hold their actual mutation lock until the read has started waiting.
    let readFinished = false
    const pendingAudit = Promise.resolve(core.auditEntries()).then(entries => { readFinished = true; return entries })
    await Promise.resolve()
    assert.equal(readFinished, false, 'an audit read waits for pending writes')
    await auditLock.release()
    const entries = await pendingAudit
    assert.ok(['rotate-key-proposed', 'rotate-key-committed', 'rotate-key-finished'].every(action => entries.some(entry => entry.action === action)))
    const audit = await rpc<{ entries: { action: string; outcome: string }[] }>(host.routes, 'audit')
    assert.ok(audit.ok && ['rotate-key-proposed', 'rotate-key-committed', 'rotate-key-finished'].every(action => audit.value.entries.some(entry => entry.action === action)))

    // After a restart the stored key is the new one.
    host.dispose()
    await core.dispose()
    host = fakeHost()
    core = apply(host.ctx, undefined, { dataDir: dir, createAdapter: fakeAdapter().create })
    await core.ready
    await until(() => core.internals.link.connected, 8000, 'connection after restart')
    assert.equal(core.internals.keys().current, rotated)

    // The hub drops the new key before the host comes back: the host goes back to the key that works.
    const failures = hub.authFailures
    const abandoned = await hub.rotate({ forgetNext: true })
    await until(() => hub.authFailures > failures && core.internals.link.connected, 8000, 'fell back to the old key')
    assert.equal(hub.publicKey, rotated)
    assert.equal(core.internals.keys().current, rotated)
    await until(() => core.internals.keys().previous === null, 3000, 'the refused key is forgotten')
    await until(() => core.internals.pairing().paired?.publicKey === rotated, 3000, 'the working key is pinned again')
    assert.notEqual(core.internals.pairing().paired?.publicKey, abandoned)
  } finally {
    await auditLock.release()
    host.dispose()
    await core.dispose()
    await hub.close()
    await cleanup()
  }
})
