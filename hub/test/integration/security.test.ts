import { env } from 'cloudflare:workers'
import { listDurableObjectIds, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { appendAudit, listAudit, verifyAuditChain } from '../../src/audit.ts'
import type { ExecuteCall, HostDO } from '../../src/host-do.ts'
import type { HubFrame, TaskInfo } from '../../src/vendor/protocol/index.ts'
import { FakeHost, eventually, hubFetch, reauth, setupOwner } from './helpers.ts'

const hub = () => env.HUB.get(env.HUB.idFromName('hub'))
const hostObject = (hostId: string) => env.HOST.get(env.HOST.idFromName(hostId))
const call = (clientId: string, op: string, params: Record<string, unknown>, grant: ExecuteCall['grant'] = { level: 'request' }): ExecuteCall => ({
  op, params, actor: { clientId, clientName: clientId }, scopes: ['dsh.read', 'dsh.content', 'dsh.tasks'], grant,
})
const taskOf = (outcome: { ok: boolean }): TaskInfo => {
  if (!outcome.ok) throw new Error(`expected success: ${JSON.stringify(outcome)}`)
  return (outcome as unknown as { result: TaskInfo }).result
}

async function pairedHost(name = 'pc') {
  const owner = await setupOwner()
  const host = await FakeHost.create()
  await host.pair(owner, name)
  host.respond = frame => frame.op === 'task.start'
    ? { ok: true, result: { taskId: frame.taskId, state: 'accepted', createdAt: Date.now(), updatedAt: Date.now() } }
    : frame.op === 'task.get' ? { ok: true, result: { taskId: frame.taskId, state: 'accepted' } }
    : { ok: true, result: {} }
  await host.connect({ ceiling: { level: 'request' } })
  await host.next('ready')
  return { owner, host }
}

async function goOffline(host: FakeHost) {
  host.socket?.close(1000, 'bye')
  await eventually(async () => expect((await hostObject(host.hostId).summary()).online).toBe(false))
}

async function reconnect(host: FakeHost): Promise<FakeHost> {
  const back = await FakeHost.create()
  Object.assign(back, { keys: host.keys, publicKey: host.publicKey, hostId: host.hostId, respond: host.respond })
  await back.connect({ ceiling: { level: 'request' } })
  await back.next('ready')
  return back
}

describe('security fixes', () => {
  it('re-checks the grant of parked tasks when narrowed, revoked or finally delivered', async () => {
    const { host } = await pairedHost()
    const h = hub()
    for (const clientId of ['narrowed', 'revoked', 'stale', 'kept']) {
      await h.upsertClient({ clientId, name: clientId, kind: 'cimd', domain: null, redirectHost: null })
      expect((await h.setGrant(clientId, host.hostId, 'request', 'request')).ok).toBe(true)
    }
    await goOffline(host)
    const stub = hostObject(host.hostId)
    const park = async (clientId: string) => taskOf(await stub.execute(call(clientId, 'task.start', { target: { sessionId: 's' }, prompt: 'p', idempotencyKey: `k-${clientId}` })))
    const narrowed = await park('narrowed')
    const revoked = await park('revoked')
    const stale = await park('stale')
    const kept = await park('kept')
    expect(narrowed.state).toBe('parked')

    // Narrowing through the owner UI fails that client's parked tasks right away.
    const ownerSession = await setupOwner()
    await ownerSession.browser.postForm('/connections/grant', { clientId: 'narrowed', hostId: host.hostId, level: 'view' })
    const afterNarrow = taskOf(await stub.execute(call('narrowed', 'task.get', { taskId: narrowed.taskId }, { level: 'view' })))
    expect(afterNarrow.state).toBe('failed')
    expect(afterNarrow.error?.denial).toEqual({ layer: 'hub', reason: 'level-too-low' })

    // Revoking the client fails its parked tasks too.
    await reauth(ownerSession)
    await ownerSession.browser.postForm('/connections/revoke', { clientId: 'revoked' })
    const rows = await runInDurableObject(stub, (_instance: HostDO, state) => state.storage.sql.exec<{ task_id: string; state: string }>('SELECT task_id, state FROM tasks').toArray())
    expect(rows.find(row => row.task_id === revoked.taskId)?.state).toBe('failed')

    // A change made without the refresh is still caught at delivery time.
    await h.setGrant('stale', host.hostId, 'none', 'request')
    const back = await reconnect(host)
    await eventually(async () => expect(back.frames.some(frame => frame.t === 'request' && frame.taskId === kept.taskId)).toBe(true))
    await eventually(async () => {
      const staleRow = (await runInDurableObject(stub, (_i: HostDO, state) => state.storage.sql.exec<{ task_id: string; state: string }>('SELECT task_id, state FROM tasks').toArray())).find(row => row.task_id === stale.taskId)
      expect(staleRow?.state).toBe('failed')
    })
    const sent = back.frames.filter((frame): frame is Extract<HubFrame, { t: 'request' }> => frame.t === 'request')
    expect(sent.map(frame => frame.taskId)).not.toContain(stale.taskId)
    expect(sent.map(frame => frame.taskId)).not.toContain(narrowed.taskId)
    expect(sent.map(frame => frame.taskId)).not.toContain(revoked.taskId)
    expect(sent.find(frame => frame.taskId === kept.taskId)?.grant).toEqual({ level: 'request' })
  })

  it('isolates the task ledger per client and keeps the approved host name', async () => {
    const { host, owner } = await pairedHost('approved-name')
    const stub = hostObject(host.hostId)
    const mine = taskOf(await stub.execute(call('alice', 'task.start', { target: { sessionId: 's' }, prompt: 'p', idempotencyKey: 'a1' })))
    const other = await stub.execute(call('bob', 'task.get', { taskId: mine.taskId }))
    expect(!other.ok && other.error.code).toBe('not_found')
    const cancel = await stub.execute(call('bob', 'task.cancel', { taskId: mine.taskId }))
    expect(!cancel.ok && cancel.error.code).toBe('not_found')
    expect(taskOf(await stub.execute(call('alice', 'task.get', { taskId: mine.taskId }))).taskId).toBe(mine.taskId)
    expect((await stub.summary('bob')).running).toHaveLength(0)
    expect((await stub.summary('alice')).running.map(task => task.taskId)).toContain(mine.taskId)
    expect((await stub.summary()).running.map(task => task.taskId)).toContain(mine.taskId)
    const live = await stub.summary()
    expect(live.name).toBe('approved-name')
    expect(live.reportedName).toBe('test-pc')
    const page = await (await owner.browser.fetch(`/hosts/${host.hostId}`)).text()
    expect(page).toContain('approved-name')
    expect(page).toContain('ホストの申告名: test-pc')
  })

  it('never creates a host object for an unpaired id', async () => {
    const stray = 'h' + 'a'.repeat(20)
    const before = (await listDurableObjectIds(env.HOST)).map(id => id.toString())
    const response = await hubFetch(`/ws/host/${stray}`, { headers: { upgrade: 'websocket' } })
    expect(response.status).toBe(404)
    const after = (await listDurableObjectIds(env.HOST)).map(id => id.toString())
    expect(after).toEqual(before)
    // Even a direct call leaves no tables behind.
    const stub = hostObject('h' + 'b'.repeat(20))
    expect((await stub.summary()).online).toBe(false)
    const tables = await runInDurableObject(stub, (_i: HostDO, state) => state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray())
    expect(tables).toEqual([])
  })

  it('refuses open redirects after login', async () => {
    for (const next of ['/%09/evil.com', '//evil.com', '/%5Cevil.com', 'https://evil.com']) {
      const html = await (await hubFetch(`/login?next=${next}`)).text()
      expect(html, next).toContain('data-next="/"')
    }
    const kept = await (await hubFetch(`/login?next=${encodeURIComponent('/settings#tokens')}`)).text()
    expect(kept).toContain('data-next="/settings#tokens"')
  })

  it('caps pending pairings per source and drops idle ones near the cap', async () => {
    const start = (ip: string) => hubFetch('/pair/start', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify({ publicKey: 'A'.repeat(43), name: 'x', pluginVersion: '1', protocol: 1 }) })
    for (let i = 0; i < 3; i++) expect((await start('10.0.0.1')).status).toBe(200)
    expect((await start('10.0.0.1')).status).toBe(429)
    for (let i = 0; i < 20; i++) expect((await start(`10.1.0.${i}`)).status).toBe(200)
    // Everyone stopped polling a while ago: the next start clears them instead of being blocked.
    await runInDurableObject(hub(), (_i, state) => state.storage.sql.exec('UPDATE pairings SET last_seen_at = ?', Date.now() - 60_000))
    expect((await start('10.2.0.1')).status).toBe(200)
    const pending = await runInDurableObject(hub(), (_i, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending' AND expires_at > ?", Date.now()).one().n)
    expect(pending).toBe(1)
  })

  it('caps the audit log and keeps the chain verifiable', async () => {
    const stub = hostObject('h' + 'c'.repeat(20))
    await stub.provision('h' + 'c'.repeat(20), 'A'.repeat(43), 'x')
    await runInDurableObject(stub, async (_i: HostDO, state) => {
      for (let i = 0; i < 260; i++) await appendAudit(state.storage.sql, { at: i, actor: 'a', actorName: 'a', operation: 'op', hostId: null, outcome: 'ok', layer: null, reason: null }, 100)
    })
    const rows = await runInDurableObject(stub, (_i: HostDO, state) => listAudit(state.storage.sql, 1000))
    expect(rows.length).toBeLessThanOrEqual(150)
    expect(rows[0]?.seq).toBe(260)
    expect(await verifyAuditChain(rows)).toBeNull()
  })

  it('explains passkey removal, previews confirmations and rejects bad op encodings', async () => {
    const owner = await setupOwner()
    const settings = await (await owner.browser.fetch('/settings')).text()
    expect(settings).toContain('新しい一覧を受け取り')
    await reauth(owner)
    const issued = await owner.browser.postForm('/settings/tokens', { name: 'enc', scope: ['dsh.read'], days: '7' })
    const pat = /rmr_pat_[A-Za-z0-9_-]+/.exec(await issued.text())?.[0] as string
    const bad = await hubFetch('/api/v1/ops/%E0%A4%A', { method: 'POST', headers: { authorization: `Bearer ${pat}`, 'content-type': 'application/json' }, body: '{}' })
    expect(bad.status).toBe(400)
  })
})
