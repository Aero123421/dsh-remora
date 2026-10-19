import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { confirmationChallenge, fromBase64Url, type HubFrame } from '../../src/vendor/protocol/index.ts'
import { FakeHost, ORIGIN, eventually, reauth, setupOwner } from './helpers.ts'

const now = Date.now()

describe('owner pages', () => {
  it('keeps host-provided repair links on this hub', async () => {
    const owner = await setupOwner()
    const host = await FakeHost.create()
    await host.pair(owner, 'repair-link-pc')
    let fix = 'hub:/connections#reauthorize'
    host.respond = () => ({ ok: false, error: { code: 'unavailable', message: 'Try the repair link', fix } })
    await host.connect({ ceiling: { level: 'view' }, operations: ['session.get'] })
    await host.next('ready')
    try {
      for (const [hint, target] of [
        ['hub:/connections#reauthorize', '/connections#reauthorize'],
        ['hub:https://evil.example/', '/'],
        ['hub://evil.example/', '/'],
        ['hub:/\\evil.example/', '/'],
        ['hub:javascript:alert(1)', '/'],
      ]) {
        fix = hint as string
        const page = await (await owner.browser.fetch(`/hosts/${host.hostId}/sessions/s1`, { headers: { 'accept-language': 'en' } })).text()
        expect(page).toContain(`<a href="${target}">this hub</a>`)
        expect(page).not.toContain('href="https://evil.example/')
        expect(page).not.toContain('href="//evil.example/')
        expect(page).not.toContain('href="javascript:')
      }
    } finally {
      host.socket?.close(1000, 'done')
    }
  })

  it('renders the inbox, hosts, sessions, tasks, attention, connections, audit and settings', async () => {
    const owner = await setupOwner()
    const host = await FakeHost.create()
    await host.pair(owner, '<b>desk</b>')
    const requests: Extract<HubFrame, { t: 'request' }>[] = []
    host.respond = frame => {
      requests.push(frame)
      switch (frame.op) {
        case 'workspaces.list': return { ok: true, result: { workspaces: [{ workspaceId: 'w1', name: 'proj', path: '/home/me/proj', pinned: false, archived: false, untrusted: false }], placements: [] } }
        case 'sessions.list': return { ok: true, result: { sessions: [
          { sessionId: 's1', title: '<script>alert(1)</script>', workspaceId: 'w1', parentSessionId: null, pinned: true, archived: false, running: true, updatedAt: now, agentPreset: 'standard', model: null },
          { sessionId: 's2', title: 'child', workspaceId: 'w1', parentSessionId: 's1', pinned: false, archived: false, running: false, updatedAt: now, agentPreset: 'standard', model: null },
        ], nextCursor: null } }
        case 'session.get': return { ok: true, result: { session: { sessionId: 's1', title: 'Session one', workspaceId: 'w1', parentSessionId: null, pinned: false, archived: false, running: false, updatedAt: now, agentPreset: 'ptc', model: { provider: 'deepseek', model: 'v4', effort: 'high' } }, context: { usedTokens: 5000, maxTokens: 10000, ratio: 0.5 }, recentTurns: [{ index: 0, request: 'hi', reply: 'hello <i>there</i>', at: now }], queueLength: 0, attention: [], hasLiveClient: true, untrusted: true } }
        case 'attention.list': return { ok: true, result: { items: [
          { attentionId: 'q1', hostId: host.hostId, sessionId: 's1', kind: 'question', title: 'Pick one', detail: 'Which file?', options: [{ id: 'a', label: 'A' }], answerable: true, createdAt: now },
          { attentionId: 'ap1', hostId: host.hostId, sessionId: 's1', kind: 'approval', title: 'Run rm?', answerable: true, createdAt: now },
          { attentionId: 'q2', hostId: host.hostId, sessionId: 's1', kind: 'question', title: 'Legacy question', answerable: false, createdAt: now },
        ] } }
        case 'task.start': return { ok: true, result: { taskId: frame.taskId, state: 'accepted', sessionId: 's1', createdAt: now, updatedAt: now } }
        case 'task.get': return { ok: true, result: { taskId: frame.taskId, state: 'accepted', sessionId: 's1', createdAt: now, updatedAt: now } }
        default: return { ok: true, result: { accepted: true } }
      }
    }
    await host.connect({ ceiling: { level: 'full', fullAccessExpiresAt: now + 3_600_000 }, operations: ['workspaces.list', 'sessions.list', 'session.get', 'attention.list', 'attention.respond', 'approval.respond', 'task.start', 'task.get', 'command.run'] })
    await host.next('ready')

    const home = await (await owner.browser.fetch('/')).text()
    expect(home).toContain('test-pc')
    expect(home).toContain('リモート全権')
    expect(home).toContain('無料枠')
    expect(home).toContain('実行時間・保存容量などは含みません')
    expect(home).toContain('Workers Free では無料枠の上限で利用が止まります')
    expect(home).toContain('Workers Paid では超えた分が課金')

    const hostPage = await (await owner.browser.fetch(`/hosts/${host.hostId}`)).text()
    expect(hostPage).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(hostPage).not.toContain('<script>alert(1)')
    expect(hostPage).toContain('child')

    const sessionPage = await (await owner.browser.fetch(`/hosts/${host.hostId}/sessions/s1`)).text()
    expect(sessionPage).toContain('deepseek / v4 / high')
    expect(sessionPage).toContain('DSH Web でこのセッションが開かれています')
    expect(sessionPage).toContain('hello &lt;i&gt;there&lt;/i&gt;')

    // Sending a prompt from the session page starts a task and shows it.
    const sent = await owner.browser.postForm(`/hosts/${host.hostId}/sessions/s1/prompt`, { prompt: 'please', idempotencyKey: 'ui-1', skills: '/review' })
    expect(sent.status).toBe(303)
    const taskUrl = sent.headers.get('location') as string
    expect(taskUrl).toMatch(/^\/tasks\/h[a-z2-7]{20}-/)
    const start = requests.find(frame => frame.op === 'task.start')
    expect(start?.params).toMatchObject({ target: { sessionId: 's1' }, prompt: 'please', skills: ['review'] })
    expect(start?.actor.clientId).toBe('hub-ui')
    expect((await owner.browser.fetch(taskUrl.split('?')[0] as string)).status).toBe(200)

    const attention = await (await owner.browser.fetch('/attention')).text()
    expect(attention).toContain('Which file?')
    expect(attention).toContain('data-confirm-op="approval.respond"')
    expect(attention).toContain('<details class="plain confirm-preview"><summary>パスキーで署名する内容</summary>')
    expect(attention).not.toContain('confirm-preview" open')
    expect(attention).toContain('legacy モードのため')
    const answered = await owner.browser.postForm('/attention/respond', { hostId: host.hostId, sessionId: 's1', attentionId: 'q1', optionId: 'a' })
    expect(answered.headers.get('location')).toBe('/attention?msg=sent')

    // Dangerous operations carry the browser's passkey confirmation in the request frame.
    const confirmed = await owner.browser.postJson('/ops/confirmed', {
      hostId: host.hostId, operation: 'approval.respond', params: { hostId: host.hostId, sessionId: 's1', attentionId: 'ap1', answer: { approve: true } },
      requestId: 'r_test_request', issuedAt: Date.now(), assertion: { credentialId: 'c', authenticatorData: 'a', clientDataJSON: 'b', signature: 's' },
    })
    expect(confirmed.status).toBe(200)
    const approval = requests.find(frame => frame.op === 'approval.respond')
    expect(approval?.id).toBe('r_test_request')
    expect(approval?.confirmation?.assertion.credentialId).toBe('c')

    const connections = await (await owner.browser.fetch('/connections')).text()
    expect(connections).toContain('https://hub.example.com/mcp')
    expect(connections).toContain('chatgpt.com/plugins')

    const settings = await (await owner.browser.fetch('/settings')).text()
    expect(settings).toContain('<h2>パスキー <span class="count">1</span></h2>')
    expect(settings).toContain('2 本目のパスキー')

    const audit = await (await owner.browser.fetch('/audit')).text()
    expect(audit).toContain('ハッシュ連鎖は正常')
    expect(audit).toContain('task.start')

    // A dangerous-op confirmation request needs a signed-in owner.
    await reauth(owner)
    const options = await owner.browser.postJson('/auth/confirm/options', { hostId: host.hostId, operation: 'approval.respond', params: {} })
    expect(options.status).toBe(200)
    const body = (await options.json()) as { requestId: string; options: { challenge: string; allowCredentials: unknown[] } }
    expect(body.options.allowCredentials).toHaveLength(1)

    // The challenge covers the final params (hostId filled in) and the frame id is the requestId.
    const params = { sessionId: 's1', attentionId: 'ap1', answer: { approve: false } }
    const prepared = await owner.browser.postJson('/auth/confirm/options', { hostId: host.hostId, operation: 'approval.respond', params })
    const ready = (await prepared.json()) as { requestId: string; issuedAt: number; params: Record<string, unknown>; options: { challenge: string; rpId: string } }
    expect(ready.params).toEqual({ ...params, hostId: host.hostId })
    const signed = await owner.authenticator.get(ready.options)
    const confirmedSigned = await owner.browser.postJson('/ops/confirmed', {
      hostId: host.hostId, operation: 'approval.respond', params, requestId: ready.requestId, issuedAt: ready.issuedAt,
      assertion: { credentialId: signed.id, authenticatorData: signed.response.authenticatorData, clientDataJSON: signed.response.clientDataJSON, signature: signed.response.signature, userHandle: signed.response.userHandle },
    })
    expect(confirmedSigned.status).toBe(200)
    const frame = requests.filter(item => item.op === 'approval.respond').at(-1) as Extract<HubFrame, { t: 'request' }>
    expect(frame.id).toBe(ready.requestId)
    const expected = await confirmationChallenge({ hubOrigin: ORIGIN, hostId: host.hostId, requestId: frame.id, operation: frame.op, params: frame.params, issuedAt: frame.confirmation?.issuedAt as number })
    const clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(frame.confirmation?.assertion.clientDataJSON as string))) as { challenge: string }
    expect(clientData.challenge).toBe(expected)

    // The free-tier meter counts requests (flushed every 50 events or minute).
    await eventually(async () => {
      for (let i = 0; i < 5; i++) await owner.browser.fetch('/healthz')
      const meter = await env.HUB.get(env.HUB.idFromName('hub')).meterToday()
      expect(meter.workerRequests).toBeGreaterThan(0)
      expect(meter.durableObjectRequests).toBeGreaterThan(0)
    }, 10_000)
  })

  it('preserves escaped prompt and schedule drafts after validation and host operation failures', async () => {
    const owner = await setupOwner()
    const host = await FakeHost.create()
    await host.pair(owner, 'draft-pc')
    const requests: Extract<HubFrame, { t: 'request' }>[] = []
    host.respond = frame => {
      requests.push(frame)
      if (frame.op === 'session.get') return { ok: true, result: { session: { sessionId: 's1', title: 'Draft test', workspaceId: 'w1', parentSessionId: null, pinned: false, archived: false, running: false, updatedAt: now, agentPreset: 'standard', model: null }, context: null, recentTurns: [], queueLength: 0, attention: [], hasLiveClient: false, untrusted: true } }
      if (frame.op === 'schedules.list') return { ok: true, result: { schedules: [] } }
      return { ok: false, error: { code: 'unavailable', message: 'Please try again later' } }
    }
    await host.connect({ ceiling: { level: 'request' }, operations: ['session.get', 'task.start', 'task.steer', 'schedules.list', 'schedule.create'] })
    await host.next('ready')
    const base = `/hosts/${host.hostId}/sessions/s1`
    const prompt = '</textarea><script>draft()</script> & keep this'
    const draft = await owner.browser.postForm(`${base}/prompt`, { prompt, skills: '/review /test', idempotencyKey: 'retry-prompt' })
    expect(draft.status).toBe(200)
    const page = await draft.text()
    expect(page).toContain('&lt;/textarea&gt;&lt;script&gt;draft()&lt;/script&gt; &amp; keep this</textarea>')
    expect(page).not.toContain('<script>draft()')
    expect(page).toContain('value="/review /test"')
    expect(page).toContain('value="retry-prompt"')
    expect(page).toContain('Please try again later')
    const steer = await owner.browser.postForm(`${base}/steer`, { prompt: 'keep my extra instruction', idempotencyKey: 'retry-steer' })
    expect(await steer.text()).toContain('keep my extra instruction</textarea>')
    const fields = { title: 'Saved <title>', prompt, kind: 'weekly', time: 'bad time', minutes: '13', timeZone: 'Europe/London', weekday: ['1', '5'], at: '2030-10-17T09:30', cron: '0 9 * * 1-5', idempotencyKey: 'retry-schedule' }
    const post = (data: typeof fields) => owner.browser.fetch(`${base}/schedule-create`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(data).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(value => [key, value]))).toString() })
    const invalid = await post(fields)
    const invalidPage = await invalid.text()
    expect(invalidPage).toContain('value="Saved &lt;title&gt;"')
    expect(invalidPage).toContain('value="weekly" selected')
    expect(invalidPage).toContain('value="bad time"')
    expect(invalidPage).toContain('name="weekday" value="1" checked')
    expect(invalidPage).toContain('name="weekday" value="5" checked')
    expect(invalidPage).toContain('value="Europe/London"')
    expect(invalidPage).toContain('value="2030-10-17T09:30"')
    expect(invalidPage).toContain('value="0 9 * * 1-5"')
    expect(invalidPage).toContain('value="retry-schedule"')
    expect(requests.some(frame => frame.op === 'schedule.create')).toBe(false)
    const failed = await post({ ...fields, time: '09:30' })
    const failedPage = await failed.text()
    expect(failedPage).toContain('Please try again later')
    expect(failedPage).toContain('value="Saved &lt;title&gt;"')
    expect(failedPage).toContain('value="retry-schedule"')
    expect(failedPage).toContain('&lt;/textarea&gt;&lt;script&gt;draft()&lt;/script&gt; &amp; keep this</textarea>')
    expect(requests.some(frame => frame.op === 'schedule.create')).toBe(true)
    host.socket?.close(1000, 'done')
  })
})
