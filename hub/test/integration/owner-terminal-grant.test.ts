import { describe, expect, it } from 'vitest'
import type { ConfirmationInfo, HubFrame } from '../../src/vendor/protocol/index.ts'
import { FakeHost, setupOwner, type Owner } from './helpers.ts'

type RequestFrame = Extract<HubFrame, { t: 'request' }>

async function fullHost(owner: Owner) {
  const host = await FakeHost.create()
  await host.pair(owner, 'workbench')
  const requests: RequestFrame[] = []
  host.respond = frame => {
    requests.push(frame)
    if (frame.op === 'terminal.run') return { ok: true, result: { exitCode: 0, signal: null, timedOut: false, stdout: 'ok', stderr: '', truncated: false, durationMs: 1, untrusted: true } }
    return { ok: true, result: {} }
  }
  await host.connect({ ceiling: { level: 'full', fullAccessExpiresAt: Date.now() + 24 * 60 * 60_000 }, operations: ['terminal.run', 'workspaces.list'] })
  await host.next('ready')
  return { host, requests }
}

async function confirmInBrowser(owner: Owner, hostId: string, confirmationId: string) {
  const options = await owner.browser.postJson('/auth/confirm/options', { hostId, operation: 'terminal.run', params: { command: 'ignored' }, pendingId: confirmationId })
  expect(options.status).toBe(200)
  const prepared = (await options.json()) as { requestId: string; issuedAt: number; params: Record<string, unknown>; options: { challenge: string; rpId: string } }
  const signed = await owner.authenticator.get(prepared.options)
  const sent = await owner.browser.postJson('/ops/confirmed', {
    hostId, operation: 'terminal.run', params: prepared.params, requestId: prepared.requestId, issuedAt: prepared.issuedAt, pendingId: confirmationId,
    assertion: { credentialId: signed.id, authenticatorData: signed.response.authenticatorData, clientDataJSON: signed.response.clientDataJSON, signature: signed.response.signature, userHandle: signed.response.userHandle },
  })
  return { status: sent.status, body: (await sent.json()) as { ok?: boolean; result?: ConfirmationInfo; error?: { message?: string } } }
}

describe('owner terminal grant', () => {
  it('covers a 120 second command and still expires', async () => {
    const owner = await setupOwner()
    const { host, requests } = await fullHost(owner)
    const fromForm = await owner.browser.postForm(`/hosts/${host.hostId}/terminal`, { cwdWorkspaceId: 'ws-1', command: 'sleep 120', timeoutSeconds: '120' })
    expect(fromForm.status).toBe(303)
    const confirmationId = (fromForm.headers.get('location') ?? '').split('/').at(-1) as string
    const started = Date.now()
    const confirmed = await confirmInBrowser(owner, host.hostId, confirmationId)
    expect(confirmed.status).toBe(200)
    const frame = requests.find(item => item.op === 'terminal.run')
    expect(frame?.grant.level).toBe('full')
    const expires = frame?.grant.fullAccessExpiresAt ?? 0
    expect(expires).toBeGreaterThanOrEqual(started + 120_000 + 30_000)
    expect(expires).toBeLessThanOrEqual(Date.now() + 120_000 + 30_000)
    expect(Number.isFinite(expires)).toBe(true)
    host.socket?.close(1000, 'done')
  })
})
