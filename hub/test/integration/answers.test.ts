import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { confirmationChallenge, fromBase64Url, type AttentionItem, type HubFrame } from '../../src/vendor/protocol/index.ts'
import { FakeHost, ORIGIN, cliToken, eventually, hubFetch, mcpTool, setupOwner, type Owner } from './helpers.ts'

const MCP = `${ORIGIN}/mcp`
const API = `${ORIGIN}/api/v1/ops`
type RequestFrame = Extract<HubFrame, { t: 'request' }>

async function hostWithItems(owner: Owner, items: (host: FakeHost) => AttentionItem[], refuseApprovals = true) {
  const host = await FakeHost.create()
  await host.pair(owner, 'desk')
  const requests: RequestFrame[] = []
  host.respond = frame => {
    requests.push(frame)
    if (frame.op === 'attention.list') return { ok: true, result: { items: items(host).map(item => ({ ...item, hostId: '' })) } }
    if (frame.op === 'approval.respond' && refuseApprovals && !frame.confirmation) {
      return { ok: false, error: { code: 'denied', message: 'approval.respond needs a passkey confirmation.', denial: { layer: 'dsh', reason: 'confirmation-failed' }, fix: 'dsh:settings/remora#permissions' } }
    }
    return { ok: true, result: { accepted: true } }
  }
  await host.connect({ ceiling: { level: 'request' }, operations: ['attention.list', 'attention.respond', 'approval.respond', 'sessions.list', 'workspaces.list'] })
  await host.next('ready')
  return { host, requests }
}

describe('answering questions, plan reviews and approvals from outside', () => {
  it('gives every item an answerUrl and points AI clients at the hub page for passkey approvals', async () => {
    const owner = await setupOwner()
    const expiresAt = Date.now() + 5 * 60_000
    const { host, requests } = await hostWithItems(owner, () => [
      { attentionId: 'approval:1', hostId: '', sessionId: 's1', kind: 'approval', title: 'Approve shell: rm -rf build', detail: 'rm -rf build', answerable: true, answerVia: 'hub-passkey', expiresAt, createdAt: Date.now() },
      { attentionId: 'call-q', hostId: '', sessionId: 's1', kind: 'question', title: 'Which branch?', answerable: true, answerVia: 'remote', expiresAt, createdAt: Date.now() },
    ])
    const token = await cliToken(owner, MCP)
    await env.HUB.get(env.HUB.idFromName('hub')).setGrant('remora-cli', host.hostId, 'request', 'request')

    const listed = await mcpTool(token, 'dsh_attention_list', { hostId: host.hostId })
    const items = listed.structuredContent.items as AttentionItem[]
    expect(items.map(item => item.answerUrl)).toEqual([`${ORIGIN}/attention/${host.hostId}/approval%3A1`, `${ORIGIN}/attention/${host.hostId}/call-q`])
    expect(items[0]?.hostId).toBe(host.hostId)

    // status carries the cached items with their links too (from the host's attention event).
    host.sendEvent([{ kind: 'attention', sessionId: 's1', items: items.map(({ answerUrl: _, ...item }) => ({ ...item, hostId: '' })) }])
    const apiToken = await cliToken(owner, API)
    await eventually(async () => {
      const status = (await (await hubFetch('/api/v1/ops/status', { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: '{}' })).json()) as { attention: AttentionItem[] }
      expect(status.attention.map(item => item.answerUrl)).toContain(`${ORIGIN}/attention/${host.hostId}/approval%3A1`)
    })

    // dsh_approval_respond is relayed without a confirmation; the host's refusal comes back with the link.
    const refused = await mcpTool(token, 'dsh_approval_respond', { sessionId: 's1', attentionId: 'approval:1', answer: { approve: true } })
    const frame = requests.find(item => item.op === 'approval.respond') as RequestFrame
    expect(frame.params).toEqual({ hostId: host.hostId, sessionId: 's1', attentionId: 'approval:1', answer: { approve: true } })
    expect(frame.confirmation).toBeUndefined()
    expect(refused.isError).toBe(true)
    const error = refused.structuredContent.error as { code: string; message: string; denial: { reason: string }; fix: string }
    expect(error.denial.reason).toBe('confirmation-failed')
    expect(error.fix).toBe(`${ORIGIN}/attention/${host.hostId}/approval%3A1`)
    expect(error.message).toContain(`Give the user this link to allow or reject it on the Remora hub: ${ORIGIN}/attention/${host.hostId}/approval%3A1`)
    expect(refused.structuredContent.answerUrl).toBe(error.fix)

    // The same refusal over HTTP.
    const viaApi = await hubFetch('/api/v1/ops/approval.respond', { method: 'POST', headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's1', attentionId: 'approval:1', answer: { approve: false } }) })
    expect(viaApi.status).toBe(403)
    expect(((await viaApi.json()) as { error: { fix: string } }).error.fix).toBe(`${ORIGIN}/attention/${host.hostId}/approval%3A1`)

    // attention.respond on an approval points at the right tool and the page, without reaching the host.
    const before = requests.length
    const wrongTool = await mcpTool(token, 'dsh_attention_respond', { sessionId: 's1', attentionId: 'approval:1', answer: { optionId: 'yes' } })
    expect(wrongTool.isError).toBe(true)
    expect((wrongTool.structuredContent.error as { message: string }).message).toContain('dsh_approval_respond')
    expect(wrongTool.structuredContent.answerUrl).toBe(`${ORIGIN}/attention/${host.hostId}/approval%3A1`)
    expect(requests.slice(before).some(item => item.op === 'attention.respond')).toBe(false)

    // A remote question is answered through attention.respond.
    const answered = await mcpTool(token, 'dsh_attention_respond', { sessionId: 's1', attentionId: 'call-q', answer: { text: 'main' } })
    expect(answered.isError).toBe(false)
  })

  it('answers an approval on the hub page with a passkey confirmation bound to the frame', async () => {
    const owner = await setupOwner()
    const expiresAt = Date.now() + 4 * 60_000
    const { host, requests } = await hostWithItems(owner, () => [
      { attentionId: 'approval:9', hostId: '', sessionId: 's9', kind: 'approval', title: 'Approve write_file: /etc/hosts', detail: 'edit /etc/hosts', answerable: true, answerVia: 'hub-passkey', expiresAt, createdAt: Date.now() },
      { attentionId: 'plan-1', hostId: '', sessionId: 's9', kind: 'plan-review', title: 'Plan ready', detail: '1. Do this\n2. Do that', answerable: true, answerVia: 'remote', expiresAt, createdAt: Date.now() },
      { attentionId: 'old', hostId: '', sessionId: 's9', kind: 'question', title: 'Too late', answerable: true, answerVia: 'remote', expiresAt: Date.now() - 1000, createdAt: Date.now() - 600_000 },
      { attentionId: 'legacy', hostId: '', sessionId: 's9', kind: 'question', title: 'Legacy', answerable: false, answerVia: 'dsh-web', createdAt: Date.now() },
    ])
    const page = await (await owner.browser.fetch(`/attention/${host.hostId}/approval%3A9`)).text()
    expect(page).toContain('Approve write_file: /etc/hosts')
    expect(page).toContain('edit /etc/hosts')
    expect(page).toContain('s9')
    expect(page).toContain('desk')
    expect(page).toContain('data-testid="hub-approval-allow"')
    expect(page).toContain(`data-expires-at="${expiresAt}"`)
    expect(page).not.toContain('Plan ready')

    const all = await (await owner.browser.fetch('/attention')).text()
    expect(all).toContain('1. Do this')
    expect(all).toContain('data-testid="hub-plan-reject"')
    expect(all).toContain('期限が切れました')
    expect(all).toContain('tool-ask-user を timed に切り替える')

    // The browser asks for a challenge over the final params, signs it, and posts the assertion.
    const params = { sessionId: 's9', attentionId: 'approval:9', answer: { approve: true } }
    const prepared = (await (await owner.browser.postJson('/auth/confirm/options', { hostId: host.hostId, operation: 'approval.respond', params })).json()) as { requestId: string; issuedAt: number; params: Record<string, unknown>; options: { challenge: string; rpId: string } }
    expect(prepared.params).toEqual({ ...params, hostId: host.hostId })
    const signed = await owner.authenticator.get(prepared.options)
    const sent = await owner.browser.postJson('/ops/confirmed', {
      hostId: host.hostId, operation: 'approval.respond', params: prepared.params, requestId: prepared.requestId, issuedAt: prepared.issuedAt,
      assertion: { credentialId: signed.id, authenticatorData: signed.response.authenticatorData, clientDataJSON: signed.response.clientDataJSON, signature: signed.response.signature, userHandle: signed.response.userHandle },
    })
    expect(sent.status).toBe(200)
    const frame = requests.filter(item => item.op === 'approval.respond').at(-1) as RequestFrame
    expect(frame.id).toBe(prepared.requestId)
    expect(frame.params).toEqual({ ...params, hostId: host.hostId })
    expect(frame.confirmation?.issuedAt).toBe(prepared.issuedAt)
    const clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(frame.confirmation?.assertion.clientDataJSON as string))) as { challenge: string; type: string }
    expect(clientData.type).toBe('webauthn.get')
    expect(clientData.challenge).toBe(await confirmationChallenge({ hubOrigin: ORIGIN, hostId: host.hostId, requestId: frame.id, operation: 'approval.respond', params: frame.params, issuedAt: frame.confirmation?.issuedAt as number }))

    // A plan review is answered with attention.respond.
    const plan = await owner.browser.postForm('/attention/respond', { hostId: host.hostId, sessionId: 's9', attentionId: 'plan-1', approve: 'false', text: 'smaller steps' })
    expect(plan.headers.get('location')).toBe('/attention?msg=sent')
    expect(requests.find(item => item.op === 'attention.respond')?.params).toMatchObject({ attentionId: 'plan-1', answer: { approve: false, text: 'smaller steps' } })

    // Gone items say so.
    const gone = await (await owner.browser.fetch(`/attention/${host.hostId}/nothing-here`)).text()
    expect(gone).toContain('hub-attention-gone')

    // Home and host pages put the cached items first, with their countdown.
    host.sendEvent([{ kind: 'attention', sessionId: 's9', items: [{ attentionId: 'approval:9', hostId: '', sessionId: 's9', kind: 'approval', title: 'Approve write_file: /etc/hosts', answerable: true, answerVia: 'hub-passkey', expiresAt, createdAt: Date.now() }] }])
    await eventually(async () => {
      const home = await (await owner.browser.fetch('/')).text()
      expect(home).toContain('hub-home-attention')
      expect(home).toContain(`href="/attention/${host.hostId}/approval%3A9"`)
      expect(home).toContain(`data-expires-at="${expiresAt}"`)
    })
    const hostPage = await (await owner.browser.fetch(`/hosts/${host.hostId}`)).text()
    expect(hostPage).toContain('hub-host-attention')
    expect(hostPage).toContain(`data-expires-at="${expiresAt}"`)
  })
})
