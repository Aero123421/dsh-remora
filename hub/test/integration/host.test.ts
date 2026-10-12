import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { ExecuteCall } from '../../src/host-do.ts'
import type { HubFrame, TaskInfo } from '../../src/vendor/protocol/index.ts'
import { FakeHost, ORIGIN, eventually, hubFetch, reauth, setupOwner, sleep } from './helpers.ts'

const actor = { clientId: 'client-a', clientName: 'Test client' }
const call = (op: string, params: Record<string, unknown>, extra: Partial<ExecuteCall> = {}): ExecuteCall => ({
  op, params, actor, scopes: ['dsh.read', 'dsh.content', 'dsh.tasks'], grant: { level: 'request' }, ...extra,
})
const hostObject = (hostId: string) => env.HOST.get(env.HOST.idFromName(hostId))

describe('pairing and the host connection', () => {
  it('pairs with a signed poll, authenticates the socket and relays requests', async () => {
    const owner = await setupOwner()
    const host = await FakeHost.create()

    // An unsigned (wrongly signed) poll never reveals the result.
    const start = await hubFetch('/pair/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: host.publicKey, name: 'pc', pluginVersion: '0.0.1', protocol: 1 }) })
    const started = (await start.json()) as { pairingId: string; userCode: string; verifyUrl: string }
    expect(started.userCode).toMatch(/^[A-HJKMNP-Z2-9]{8}$/)
    expect(started.verifyUrl).toBe(`${ORIGIN}/pair?code=${started.userCode.slice(0, 4)}-${started.userCode.slice(4)}`)
    const forged = await hubFetch('/pair/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingId: started.pairingId, signature: await host.sign('something else') }) })
    expect(forged.status).toBe(403)

    // The approval page needs a fresh passkey check.
    const page = await owner.browser.fetch(`/pair?code=${started.userCode}`)
    expect(await page.text()).toContain('このホストを追加しますか')

    await host.pair(owner)
    expect(host.hostId).toMatch(/^h[a-z2-7]{20}$/)

    await host.connect({ ceiling: { level: 'request' } })
    const ready = await host.next('ready')
    expect(ready.t).toBe('ready')
    const creds = (await host.next('owner-credentials')) as Extract<HubFrame, { t: 'owner-credentials' }>
    expect(creds.credentials).toHaveLength(1)
    expect(creds.credentials[0]?.algorithm).toBe(-7)
    expect(creds.credentials[0]?.credentialId).toBe(owner.authenticator.id)

    // Relay with a deadline.
    host.respond = frame => frame.op === 'sessions.list' ? { ok: true, result: { sessions: [], nextCursor: null } } : undefined
    const listed = await hostObject(host.hostId).execute(call('sessions.list', {}))
    expect(listed).toEqual({ ok: true, result: { sessions: [], nextCursor: null } })
    const request = host.frames.find(frame => frame.t === 'request') as Extract<HubFrame, { t: 'request' }>
    expect(request.actor).toEqual(actor)
    expect(request.grant).toEqual({ level: 'request' })
    expect(request.deadline).toBeGreaterThan(Date.now())

    // The hub pre-checks with the reported ceiling and explains the layer.
    const tooHigh = await hostObject(host.hostId).execute(call('task.start', { target: { sessionId: 's' }, prompt: 'x', idempotencyKey: 'k' }, { grant: { level: 'view' } }))
    expect(tooHigh.ok).toBe(false)
    if (!tooHigh.ok) {
      expect(tooHigh.error.code).toBe('denied')
      expect(tooHigh.error.denial).toEqual({ layer: 'hub', reason: 'level-too-low' })
      expect(tooHigh.error.fix).toBe('hub:/connections')
    }
    const noScope = await hostObject(host.hostId).execute(call('session.read', { sessionId: 's', depth: 'page' }, { scopes: ['dsh.read'] }))
    expect(!noScope.ok && noScope.error.denial).toEqual({ layer: 'token', reason: 'missing-scope' })

    // A second connection wins; the older one is told why.
    const first = host.socket as WebSocket
    const second = await FakeHost.create()
    Object.assign(second, { keys: host.keys, publicKey: host.publicKey, hostId: host.hostId })
    await second.connect()
    await second.next('ready')
    const closed = await host.next('close')
    expect(closed).toMatchObject({ t: 'close', reason: 'duplicate_connection' })
    await eventually(async () => expect(host.closes[0]?.code).toBe(4002))
    expect(first).not.toBe(second.socket)
    const summary = await hostObject(host.hostId).summary()
    expect(summary.online).toBe(true)
    expect(summary.duplicateConnections).toBe(1)

    // A bad signature is refused.
    const thief = await FakeHost.create()
    thief.hostId = host.hostId
    await thief.connect({}, { badSignature: true })
    expect(await thief.next('close')).toMatchObject({ reason: 'auth_failed' })

    // Revoking closes the live connection.
    await reauth(owner)
    const revoked = await owner.browser.postForm(`/hosts/${host.hostId}/revoke`, {})
    expect(revoked.status).toBe(303)
    expect(await second.next('close')).toMatchObject({ reason: 'revoked' })
    const after = await hubFetch(`/ws/host/${host.hostId}`, { headers: { upgrade: 'websocket' } })
    expect(after.status).toBe(404)
  })

  it('keeps an idempotent task ledger, parks tasks while offline and waits for state changes', async () => {
    const owner = await setupOwner()
    const host = await FakeHost.create()
    await host.pair(owner)
    await host.connect()
    await host.next('ready')
    const answers: Extract<HubFrame, { t: 'request' }>[] = []
    host.respond = frame => {
      answers.push(frame)
      if (frame.op === 'task.start') return { ok: true, result: { taskId: frame.taskId, hostId: host.hostId, sessionId: 'sess-1', state: 'accepted', createdAt: Date.now(), updatedAt: Date.now() } }
      if (frame.op === 'task.get') return { ok: true, result: { taskId: frame.taskId, state: 'completed', result: { reply: 'done!' }, hasLiveClient: false } }
      return { ok: true, result: {} }
    }
    const stub = hostObject(host.hostId)
    const start = call('task.start', { target: { sessionId: 'sess-1' }, prompt: 'hello', idempotencyKey: 'key-1' })
    const first = await stub.execute(start)
    expect(first.ok).toBe(true)
    const task = (first as { result: TaskInfo }).result
    expect(task.taskId.startsWith(`${host.hostId}-`)).toBe(true)
    expect(task.state).toBe('accepted')
    expect(task.sessionId).toBe('sess-1')
    const delivered = answers.find(frame => frame.op === 'task.start')
    expect(delivered?.taskId).toBe(task.taskId)
    expect(delivered?.idempotencyKey).toBe('key-1')

    // Same client + key: the same task, nothing sent again.
    const again = await stub.execute(start)
    expect((again as { result: TaskInfo }).result.taskId).toBe(task.taskId)
    expect(answers.filter(frame => frame.op === 'task.start')).toHaveLength(1)
    // Another client with the same key gets its own task.
    const other = await stub.execute({ ...start, actor: { clientId: 'client-b', clientName: 'B' } })
    expect((other as { result: TaskInfo }).result.taskId).not.toBe(task.taskId)

    // State follows task events; task.wait returns early on completion and fetches the result.
    host.sendEvent([{ kind: 'task', taskId: task.taskId, state: 'running', sessionId: 'sess-1', updatedAt: Date.now() }])
    await eventually(async () => {
      const got = await stub.execute(call('task.get', { taskId: task.taskId }))
      expect((got as { result: TaskInfo }).result.state).toBe('running')
    })
    const started = Date.now()
    const waiting = stub.execute(call('task.wait', { taskId: task.taskId, timeoutMs: 10_000 }))
    await sleep(200)
    host.sendEvent([{ kind: 'task', taskId: task.taskId, state: 'completed', updatedAt: Date.now() }])
    const waited = await waiting
    expect(Date.now() - started).toBeLessThan(5000)
    const done = (waited as { result: TaskInfo }).result
    expect(done.state).toBe('completed')
    expect(done.result?.reply).toBe('done!')

    // Attention events replace the cache for a session.
    host.sendEvent([{ kind: 'attention', sessionId: 'sess-1', items: [{ attentionId: 'q1', hostId: host.hostId, sessionId: 'sess-1', kind: 'question', title: 'Which?', answerable: true, createdAt: Date.now() }] }])
    await eventually(async () => expect((await stub.summary()).attention).toHaveLength(1))

    // Offline: task.start parks, other operations fail fast.
    host.socket?.close(1000, 'bye')
    await eventually(async () => expect((await stub.summary()).online).toBe(false))
    const parked = await stub.execute(call('task.start', { target: { sessionId: 'sess-1' }, prompt: 'later', idempotencyKey: 'key-2' }))
    const parkedTask = (parked as { result: TaskInfo }).result
    expect(parkedTask.state).toBe('parked')
    const offline = await stub.execute(call('sessions.list', {}))
    expect(!offline.ok && offline.error.code).toBe('host_offline')

    // On reconnect the parked task is delivered with its hub task id.
    const back = await FakeHost.create()
    Object.assign(back, { keys: host.keys, publicKey: host.publicKey, hostId: host.hostId, respond: host.respond })
    await back.connect()
    const redelivered = (await back.next('request')) as Extract<HubFrame, { t: 'request' }>
    expect(redelivered.op).toBe('task.start')
    expect(redelivered.taskId).toBe(parkedTask.taskId)
    await eventually(async () => {
      const got = await stub.execute(call('task.get', { taskId: parkedTask.taskId }))
      expect((got as { result: TaskInfo }).result.state).toBe('accepted')
    })

    // Every call is in the host's audit log, without content.
    const audit = await stub.listAudit(100)
    expect(audit.some(row => row.operation === 'task.start' && row.outcome === 'ok')).toBe(true)
    expect(JSON.stringify(audit)).not.toContain('hello')
  })
})
