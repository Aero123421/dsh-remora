import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { HubFrame } from '../../src/vendor/protocol/index.ts'
import { FakeHost, eventually, reauth, setupOwner } from './helpers.ts'

const now = Date.now()

describe('owner pages', () => {
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
          { attentionId: 'ap1', hostId: host.hostId, sessionId: 's1', kind: 'approval', title: 'Run rm?', answerable: false, createdAt: now },
        ] } }
        case 'task.start': return { ok: true, result: { taskId: frame.taskId, state: 'accepted', sessionId: 's1', createdAt: now, updatedAt: now } }
        default: return { ok: true, result: { accepted: true } }
      }
    }
    await host.connect({ ceiling: { level: 'full', fullAccessExpiresAt: now + 3_600_000 }, operations: ['workspaces.list', 'sessions.list', 'session.get', 'attention.list', 'attention.respond', 'approval.respond', 'task.start', 'task.get', 'command.run'] })
    await host.next('ready')

    const home = await (await owner.browser.fetch('/')).text()
    expect(home).toContain('test-pc')
    expect(home).toContain('リモート全権')
    expect(home).toContain('無料枠')

    const hostPage = await (await owner.browser.fetch(`/hosts/${host.hostId}`)).text()
    expect(hostPage).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(hostPage).not.toContain('<script>alert(1)')
    expect(hostPage).toContain('child')

    const sessionPage = await (await owner.browser.fetch(`/hosts/${host.hostId}/sessions/s1`)).text()
    expect(sessionPage).toContain('deepseek / v4 / high')
    expect(sessionPage).toContain('DSH Web で誰かがこのセッションを見ています')
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
    expect(settings).toContain('パスキー（1 本）')
    expect(settings).toContain('2 本以上')

    const audit = await (await owner.browser.fetch('/audit')).text()
    expect(audit).toContain('ハッシュ連鎖は正常')
    expect(audit).toContain('task.start')

    // A dangerous-op confirmation request needs a signed-in owner.
    await reauth(owner)
    const options = await owner.browser.postJson('/auth/confirm/options', { hostId: host.hostId, operation: 'approval.respond', params: {} })
    expect(options.status).toBe(200)
    const body = (await options.json()) as { requestId: string; options: { challenge: string; allowCredentials: unknown[] } }
    expect(body.options.allowCredentials).toHaveLength(1)

    // The free-tier meter counts requests (flushed every 50 events or minute).
    await eventually(async () => {
      for (let i = 0; i < 5; i++) await owner.browser.fetch('/healthz')
      const meter = await env.HUB.get(env.HUB.idFromName('hub')).meterToday()
      expect(meter.workerRequests).toBeGreaterThan(0)
      expect(meter.durableObjectRequests).toBeGreaterThan(0)
    }, 10_000)
  })
})
