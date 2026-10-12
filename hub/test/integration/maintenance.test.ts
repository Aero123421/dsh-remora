import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { verifyAuditRecords, type AuditExportResult, type ConfirmationInfo, type HostRotateKeyResult, type HubExportResult } from '../../src/vendor/protocol/index.ts'
import { FakeHost, ORIGIN, cliToken, eventually, hubFetch, reauth, setupOwner, type Owner } from './helpers.ts'

const API = `${ORIGIN}/api/v1/ops`
const ADMIN = ['dsh.read', 'dsh.tasks', 'dsh.admin']

async function api(token: string, op: string, params: Record<string, unknown> = {}) {
  const response = await hubFetch(`/api/v1/ops/${op}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(params) })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function pairedHost(owner: Owner, operations = ['workspaces.list', 'sessions.list', 'attention.list', 'host.rotate-key']) {
  const host = await FakeHost.create()
  await host.pair(owner, 'keyring')
  host.respond = () => ({ ok: true, result: { workspaces: [], sessions: [], items: [] } })
  await host.connect({ ceiling: { level: 'request' }, operations })
  await host.next('ready')
  return host
}

describe('hub maintenance the owner approves on the hub', () => {
  it('audit.export waits for the owner, then hands out every audit chain, which verifies outside the hub', async () => {
    const owner = await setupOwner()
    const host = await pairedHost(owner)
    const token = await cliToken(owner, API, ADMIN)

    const asked = await api(token, 'audit.export')
    expect(asked.status).toBe(200)
    const parked = asked.body as unknown as ConfirmationInfo
    expect(parked.state).toBe('pending')
    expect(parked.confirmationId).toMatch(/^hub-[a-z2-7]+$/)
    expect(parked.confirmUrl).toBe(`${ORIGIN}/confirm/hub/${parked.confirmationId}`)
    expect(parked.result).toBeUndefined()

    // The owner sees it in the inbox and on its page; approving needs a fresh passkey.
    expect(await (await owner.browser.fetch('/attention')).text()).toContain(`href="/confirm/hub/${parked.confirmationId}"`)
    const page = await (await owner.browser.fetch(`/confirm/hub/${parked.confirmationId}`)).text()
    expect(page).toContain('監査ログの書き出し')
    expect(page).toContain(`action="/confirm/hub/${parked.confirmationId}/approve"`)
    await reauth(owner)
    const approved = await owner.browser.postForm(`/confirm/hub/${parked.confirmationId}/approve`, {})
    expect(approved.headers.get('location')).toBe(`/confirm/hub/${parked.confirmationId}?msg=approved`)

    const got = await api(token, 'confirmation.get', { confirmationId: parked.confirmationId })
    const info = got.body as unknown as ConfirmationInfo
    expect(info.state).toBe('done')
    const result = info.result as AuditExportResult
    expect(result.logs.map(log => log.log)).toEqual(expect.arrayContaining(['hub', host.hostId]))
    for (const log of result.logs) {
      expect(log.records.length).toBeGreaterThan(0)
      expect(await verifyAuditRecords(log.records)).toBeNull()
      expect(log.records[0]!.seq).toBeLessThan(log.records.at(-1)!.seq + 1)
    }
    const hubLog = result.logs.find(log => log.log === 'hub')!
    expect(hubLog.records.some(record => record.operation === 'audit.export.approved')).toBe(true)
    // A tampered copy does not verify.
    const tampered = hubLog.records.map((record, index) => (index === 0 ? { ...record, actorName: 'someone else' } : record))
    expect(await verifyAuditRecords(tampered)).toBe(hubLog.records[0]!.seq)

    // Another client cannot read it; a token without dsh.admin cannot ask.
    await reauth(owner)
    const issued = await owner.browser.postForm('/settings/tokens', { name: 'other script', scope: ['dsh.read'], days: '7' })
    const other = /rmr_pat_[A-Za-z0-9_-]+/.exec(await issued.text())?.[0] as string
    expect((await api(other, 'confirmation.get', { confirmationId: parked.confirmationId })).status).toBe(404)
    const refused = await api(other, 'audit.export')
    expect(refused.status).toBe(403)
    expect((refused.body.error as { denial: { reason: string } }).denial.reason).toBe('missing-scope')
  })

  it('hub.export carries the settings without secrets; the owner can refuse; waiting requests are capped', async () => {
    const owner = await setupOwner()
    const host = await pairedHost(owner)
    const token = await cliToken(owner, API, ADMIN)
    const parked = (await api(token, 'hub.export')).body as unknown as ConfirmationInfo
    await reauth(owner)
    await owner.browser.postForm(`/confirm/hub/${parked.confirmationId}/approve`, {})
    const done = (await api(token, 'confirmation.get', { confirmationId: parked.confirmationId })).body as unknown as ConfirmationInfo
    const exported = done.result as HubExportResult
    expect(exported.format).toBe('remora-hub-export/v1')
    expect(exported.hosts.find(item => item.hostId === host.hostId)?.publicKeyFingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(exported.clients.some(client => client.clientId === 'remora-cli')).toBe(true)
    expect(exported.passkeys.length).toBeGreaterThan(0)
    const text = JSON.stringify(exported)
    expect(text).not.toContain(token)
    expect(text).not.toContain(host.publicKey)
    expect(text).not.toContain('"publicKey"')
    // Built at most three times per approval.
    for (let i = 0; i < 2; i++) expect(((await api(token, 'confirmation.get', { confirmationId: parked.confirmationId })).body as unknown as ConfirmationInfo).result).toBeDefined()
    const spent = (await api(token, 'confirmation.get', { confirmationId: parked.confirmationId })).body as unknown as ConfirmationInfo
    expect(spent.state).toBe('done')
    expect(spent.result).toBeUndefined()

    // Refused: the client learns it, and nothing is handed out.
    const second = (await api(token, 'hub.export')).body as unknown as ConfirmationInfo
    const denied = await owner.browser.postForm(`/confirm/hub/${second.confirmationId}/deny`, {})
    expect(denied.headers.get('location')).toBe(`/confirm/hub/${second.confirmationId}?msg=confirmation-denied`)
    const after = (await api(token, 'confirmation.get', { confirmationId: second.confirmationId })).body as unknown as ConfirmationInfo
    expect(after.state).toBe('denied')
    expect(after.result).toBeUndefined()

    // At most five waiting per client.
    for (let i = 0; i < 5; i++) expect((await api(token, 'hub.export')).status).toBe(200)
    const sixth = await api(token, 'hub.export')
    expect(sixth.status).toBe(429)
    expect((sixth.body.error as { code: string }).code).toBe('rate_limited')

    // The owner downloads both directly from the pages.
    const download = await owner.browser.fetch('/settings/export.json')
    expect(download.headers.get('content-disposition')).toMatch(/attachment; filename="remora-hub-/)
    expect(((await download.json()) as HubExportResult).format).toBe('remora-hub-export/v1')
    const audit = (await (await owner.browser.fetch('/audit/export.json')).json()) as AuditExportResult
    expect(audit.logs[0]?.log).toBe('hub')
  })

  it('host.rotate-key: the owner approves, the host proves a new key and reconnects with it', async () => {
    const owner = await setupOwner()
    const host = await pairedHost(owner)
    const before = host.publicKey
    const token = await cliToken(owner, API, ADMIN)
    const parked = (await api(token, 'host.rotate-key', { hostId: host.hostId })).body as unknown as ConfirmationInfo
    expect(parked.state).toBe('pending')
    expect(parked.confirmUrl).toBe(`${ORIGIN}/confirm/${host.hostId}/${parked.confirmationId}`)
    const page = await (await owner.browser.fetch(`/confirm/${host.hostId}/${parked.confirmationId}`)).text()
    expect(page).toContain('ホスト鍵の更新')
    expect(page).toContain(`action="/confirm/${host.hostId}/${parked.confirmationId}/approve"`)
    expect(page).not.toContain('data-confirm-op')

    await reauth(owner)
    const approved = await owner.browser.postForm(`/confirm/${host.hostId}/${parked.confirmationId}/approve`, {})
    expect(approved.status).toBe(303)
    const info = (await api(token, 'confirmation.get', { confirmationId: parked.confirmationId, timeoutMs: 5000 })).body as unknown as ConfirmationInfo
    expect(info.state).toBe('done')
    const rotated = info.result as HostRotateKeyResult
    expect(host.publicKey).not.toBe(before)
    const record = await env.HUB.get(env.HUB.idFromName('hub')).getHost(host.hostId)
    expect(record?.publicKey).toBe(host.publicKey)
    expect(rotated.publicKeyFingerprint).toMatch(/^[0-9a-f]{16}$/)
    // The old key no longer gets in.
    await eventually(async () => expect((await env.HOST.get(env.HOST.idFromName(host.hostId)).summary()).online).toBe(true))
    expect(host.closes.some(close => close.code === 4002)).toBe(false)

    // From the host page, with a bad proof: refused, the key stays.
    host.rotation = 'bad-proof'
    await reauth(owner)
    const refused = await owner.browser.postForm(`/hosts/${host.hostId}/rotate-key`, {})
    expect(await refused.text()).toContain('did not verify')
    expect((await env.HUB.get(env.HUB.idFromName('hub')).getHost(host.hostId))?.publicKey).toBe(host.publicKey)

    // And a good one from the host page.
    host.rotation = 'follow'
    const current = host.publicKey
    await reauth(owner)
    const ok = await owner.browser.postForm(`/hosts/${host.hostId}/rotate-key`, {})
    expect(ok.headers.get('location')).toBe(`/hosts/${host.hostId}?msg=key-rotated`)
    expect(host.publicKey).not.toBe(current)
  })

  it('a host whose plugin cannot rotate is not offered the rotation', async () => {
    const owner = await setupOwner()
    const host = await pairedHost(owner, ['workspaces.list', 'sessions.list', 'attention.list'])
    const token = await cliToken(owner, API, ADMIN)
    const refused = await api(token, 'host.rotate-key', { hostId: host.hostId })
    expect(refused.status).toBe(503)
    expect(await (await owner.browser.fetch(`/hosts/${host.hostId}`)).text()).not.toContain('/rotate-key')
  })
})
