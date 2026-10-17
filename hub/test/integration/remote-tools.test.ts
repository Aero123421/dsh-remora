import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { HostDO } from '../../src/host-do.ts'
import { confirmationChallenge, fromBase64Url, type ConfirmationInfo, type HubFrame } from '../../src/vendor/protocol/index.ts'
import { FakeHost, ORIGIN, cliToken, eventually, hubFetch, mcpTool, setupOwner, type Owner } from './helpers.ts'

const MCP = `${ORIGIN}/mcp`
type RequestFrame = Extract<HubFrame, { t: 'request' }>

const ALL_OPERATIONS = ['workspaces.list', 'sessions.list', 'session.get', 'attention.list', 'sessions.search', 'session.fork', 'job.stop', 'schedules.list', 'schedule.create', 'schedule.delete', 'terminal.run']

async function fullHost(owner: Owner, answer: (frame: RequestFrame) => unknown = () => ({ ok: true, result: {} })) {
  const host = await FakeHost.create()
  await host.pair(owner, 'workbench')
  const requests: RequestFrame[] = []
  host.respond = frame => {
    requests.push(frame)
    if (frame.op === 'workspaces.list') return { ok: true, result: { workspaces: [{ workspaceId: 'ws-1', name: 'Project One', path: '/work/one', untrusted: false }] } }
    if (frame.op === 'sessions.list') return { ok: true, result: { sessions: [] } }
    if (frame.op === 'attention.list') return { ok: true, result: { items: [] } }
    return answer(frame)
  }
  await host.connect({ ceiling: { level: 'full' }, operations: ALL_OPERATIONS })
  await host.next('ready')
  return { host, requests }
}

/** What the owner's browser does on the confirm page: challenge over the stored params, sign, post. */
async function confirmInBrowser(owner: Owner, hostId: string, confirmationId: string, operation = 'terminal.run') {
  const options = await owner.browser.postJson('/auth/confirm/options', { hostId, operation, params: { command: 'something else' }, pendingId: confirmationId })
  if (options.status !== 200) return { status: options.status, prepared: null }
  const prepared = (await options.json()) as { requestId: string; issuedAt: number; params: Record<string, unknown>; options: { challenge: string; rpId: string } }
  const signed = await owner.authenticator.get(prepared.options)
  const sent = await owner.browser.postJson('/ops/confirmed', {
    hostId, operation, params: prepared.params, requestId: prepared.requestId, issuedAt: prepared.issuedAt, pendingId: confirmationId,
    assertion: { credentialId: signed.id, authenticatorData: signed.response.authenticatorData, clientDataJSON: signed.response.clientDataJSON, signature: signed.response.signature, userHandle: signed.response.userHandle },
  })
  return { status: sent.status, prepared, body: (await sent.json()) as { ok?: boolean; result?: ConfirmationInfo; error?: { code: string } } }
}

describe('terminal commands wait for the owner\'s passkey on the hub', () => {
  it('parks a client\'s command, shows it to the owner, runs it once confirmed and hands back the output', async () => {
    const owner = await setupOwner()
    const output = { exitCode: 0, signal: null, timedOut: false, stdout: 'On branch main\n', stderr: '', truncated: false, durationMs: 120, untrusted: true }
    const { host, requests } = await fullHost(owner, frame => (frame.op === 'terminal.run' ? { ok: true, result: output } : { ok: true, result: {} }))
    const token = await cliToken(owner, MCP, ['dsh.read', 'dsh.content', 'dsh.tasks', 'dsh.admin'])
    await env.HUB.get(env.HUB.idFromName('hub')).setGrant('remora-cli', host.hostId, 'full', 'full')

    const asked = await mcpTool(token, 'dsh_terminal_run', { hostId: host.hostId, command: 'git status', cwdWorkspaceId: 'ws-1', timeoutMs: 30_000 })
    expect(asked.isError).toBe(false)
    const pending = asked.structuredContent as unknown as ConfirmationInfo
    expect(pending.state).toBe('pending')
    expect(pending.operation).toBe('terminal.run')
    expect(pending.confirmUrl).toBe(`${ORIGIN}/confirm/${host.hostId}/${pending.confirmationId}`)
    expect(asked.content[0]?.text).toContain(`Give the user this link to review and confirm it with a passkey on the Remora hub: ${pending.confirmUrl}`)
    expect(requests.some(frame => frame.op === 'terminal.run'), 'nothing reaches the host before the owner confirms').toBe(false)

    const waiting = await mcpTool(token, 'dsh_confirmation_get', { confirmationId: pending.confirmationId })
    expect((waiting.structuredContent as unknown as ConfirmationInfo).state).toBe('pending')

    // The owner sees it on the home page and on its own page.
    const home = await (await owner.browser.fetch('/')).text()
    expect(home).toContain('data-testid="hub-confirmation-item"')
    expect(home).toContain(`href="/confirm/${host.hostId}/${pending.confirmationId}"`)
    const page = await (await owner.browser.fetch(`/confirm/${host.hostId}/${pending.confirmationId}`)).text()
    expect(page).toContain('git status')
    expect(page).toContain('Project One')
    expect(page).toContain(`data-pending="${pending.confirmationId}"`)
    expect(page).toContain('data-testid="hub-confirm-run"')
    expect(page).toContain('30 秒')

    // The browser signs over the stored params, whatever it sends itself.
    const { status, prepared, body } = await confirmInBrowser(owner, host.hostId, pending.confirmationId)
    expect(status).toBe(200)
    expect(prepared?.params).toEqual({ hostId: host.hostId, command: 'git status', cwdWorkspaceId: 'ws-1', timeoutMs: 30_000 })
    expect(body?.result?.state).toBe('running')
    const frame = await eventually(async () => {
      const found = requests.find(item => item.op === 'terminal.run')
      expect(found).toBeDefined()
      return found as RequestFrame
    })
    expect(frame.id).toBe(prepared?.requestId)
    expect(frame.params).toEqual(prepared?.params)
    expect(frame.actor.clientId).toBe('remora-cli')
    expect(frame.grant.level).toBe('full')
    expect(frame.confirmation?.issuedAt).toBe(prepared?.issuedAt)
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(frame.confirmation?.assertion.clientDataJSON as string))).challenge)
      .toBe(await confirmationChallenge({ hubOrigin: ORIGIN, hostId: host.hostId, requestId: frame.id, operation: 'terminal.run', params: frame.params, issuedAt: frame.confirmation?.issuedAt as number }))

    // The client gets the output.
    const done = await mcpTool(token, 'dsh_confirmation_get', { confirmationId: pending.confirmationId, timeoutMs: 5000 })
    const info = done.structuredContent as unknown as ConfirmationInfo
    expect(info.state).toBe('done')
    expect(info.result).toEqual({ ...output })
    expect(done.content[0]?.text).toContain('untrusted data')
    const shown = await (await owner.browser.fetch(`/confirm/${host.hostId}/${pending.confirmationId}`)).text()
    expect(shown).toContain('On branch main')
    expect(shown).toContain('終了コード 0')

    // Confirming twice does not run it twice.
    const again = await confirmInBrowser(owner, host.hostId, pending.confirmationId)
    expect(again.status).toBe(409)
    expect(requests.filter(item => item.op === 'terminal.run')).toHaveLength(1)

    // An hour after it settled, the hub drops the command and the output; the outcome stays.
    const stub = env.HOST.get(env.HOST.idFromName(host.hostId))
    await runInDurableObject(stub, (_instance: HostDO, state) => {
      state.storage.sql.exec('UPDATE confirmations SET updated_at = updated_at - ? WHERE id = ?', 2 * 3600_000, pending.confirmationId)
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const kept = await runInDurableObject(stub, (_instance: HostDO, state) => state.storage.sql.exec<{ params: string; result: string | null; state: string }>('SELECT params, result, state FROM confirmations WHERE id = ?', pending.confirmationId).one())
    expect(kept).toEqual({ params: '{}', result: null, state: 'done' })
    const later = (await mcpTool(token, 'dsh_confirmation_get', { confirmationId: pending.confirmationId })).structuredContent as unknown as ConfirmationInfo
    expect(later.state).toBe('done')
    expect(later.result).toBeUndefined()
    expect(await (await owner.browser.fetch(`/confirm/${host.hostId}/${pending.confirmationId}`)).text()).toContain('出力は 1 時間を過ぎたので消しました')
  })

  it('shows invisible characters in a command as visible marks, never raw', async () => {
    const owner = await setupOwner()
    const { host } = await fullHost(owner)
    const token = await cliToken(owner, MCP, ['dsh.read', 'dsh.tasks', 'dsh.admin'])
    await env.HUB.get(env.HUB.idFromName('hub')).setGrant('remora-cli', host.hostId, 'full', 'full')
    const parked = (await mcpTool(token, 'dsh_terminal_run', { hostId: host.hostId, command: 'echo safe \u202e; rm -rf ~ #\u200b', cwdWorkspaceId: 'ws-1' })).structuredContent as unknown as ConfirmationInfo
    const page = await (await owner.browser.fetch(`/confirm/${host.hostId}/${parked.confirmationId}`)).text()
    expect(page).toContain('echo safe ⟦U+202E⟧; rm -rf ~ #⟦U+200B⟧')
    expect(page).not.toContain('\u202e')
    expect(page).toContain('data-testid="hub-confirm-hidden"')
    const home = await (await owner.browser.fetch('/')).text()
    expect(home).toContain('⟦U+202E⟧')
  })

  it('lets the owner refuse, hides other clients\' requests, and expires what nobody confirmed', async () => {
    const owner = await setupOwner()
    const { host, requests } = await fullHost(owner)
    const token = await cliToken(owner, MCP, ['dsh.read', 'dsh.tasks', 'dsh.admin'])
    await env.HUB.get(env.HUB.idFromName('hub')).setGrant('remora-cli', host.hostId, 'full', 'full')

    const first = (await mcpTool(token, 'dsh_terminal_run', { hostId: host.hostId, command: 'rm -rf build', cwdWorkspaceId: 'ws-1' })).structuredContent as unknown as ConfirmationInfo
    const denied = await owner.browser.postForm(`/confirm/${host.hostId}/${first.confirmationId}/deny`, {})
    expect(denied.headers.get('location')).toBe(`/confirm/${host.hostId}/${first.confirmationId}?msg=confirmation-denied`)
    const after = await mcpTool(token, 'dsh_confirmation_get', { confirmationId: first.confirmationId })
    expect((after.structuredContent as unknown as ConfirmationInfo).state).toBe('denied')
    expect((await confirmInBrowser(owner, host.hostId, first.confirmationId)).status).toBe(409)

    // The owner's own request from the host page goes straight to its confirm page.
    const fromForm = await owner.browser.postForm(`/hosts/${host.hostId}/terminal`, { cwdWorkspaceId: 'ws-1', command: 'ls', timeoutSeconds: '5' })
    expect(fromForm.status).toBe(303)
    const location = fromForm.headers.get('location') as string
    expect(location).toMatch(new RegExp(`^/confirm/${host.hostId}/${host.hostId}-[a-z2-7]+$`))
    const ownId = location.split('/').at(-1) as string

    // A client never sees a request it did not make.
    const hidden = await mcpTool(token, 'dsh_confirmation_get', { confirmationId: ownId })
    expect(hidden.isError).toBe(true)
    expect((hidden.structuredContent.error as { code: string }).code).toBe('not_found')

    // Past its deadline a request expires and its params are dropped.
    const stub = env.HOST.get(env.HOST.idFromName(host.hostId))
    await runInDurableObject(stub, (_instance: HostDO, state) => {
      state.storage.sql.exec('UPDATE confirmations SET expires_at = ? WHERE id = ?', Date.now() - 1, ownId)
    })
    const expired = await (await owner.browser.fetch(location)).text()
    expect(expired).toContain('期限が切れました')
    expect((await confirmInBrowser(owner, host.hostId, ownId)).status).toBe(409)
    const params = await runInDurableObject(stub, (_instance: HostDO, state) => state.storage.sql.exec<{ params: string }>('SELECT params FROM confirmations WHERE id = ?', ownId).one().params)
    expect(params).toBe('{}')
    expect(requests.some(frame => frame.op === 'terminal.run')).toBe(false)
  })

  it('refuses terminal commands without full access before parking anything', async () => {
    const owner = await setupOwner()
    const { host } = await fullHost(owner)
    const token = await cliToken(owner, MCP, ['dsh.read', 'dsh.tasks', 'dsh.admin'])
    await env.HUB.get(env.HUB.idFromName('hub')).setGrant('remora-cli', host.hostId, 'request', 'full')
    const refused = await mcpTool(token, 'dsh_terminal_run', { hostId: host.hostId, command: 'ls', cwdWorkspaceId: 'ws-1' })
    expect(refused.isError).toBe(true)
    expect((refused.structuredContent.error as { code: string }).code).toBe('denied')
    const live = await env.HOST.get(env.HOST.idFromName(host.hostId)).summary()
    expect(live.confirmations).toEqual([])
  })
})

describe('sessions: search, fork, jobs and schedules from the hub pages', () => {
  it('relays each form to the host with the right operation and params', async () => {
    const owner = await setupOwner()
    const { host, requests } = await fullHost(owner, frame => {
      switch (frame.op) {
        case 'session.get':
          return { ok: true, result: { session: { sessionId: 's1', title: 'Fix login', workspaceId: 'ws-1', running: false, updatedAt: Date.now() }, recentTurns: [], queueLength: 0, hasLiveClient: false, context: null, jobs: [{ jobId: 'bash-1', kind: 'bash', label: 'npm run dev', status: 'running' }] } }
        case 'schedules.list':
          return { ok: true, result: { schedules: [{ scheduleId: 'schedule-1', sessionId: 's1', title: 'Morning CI', prompt: 'Check CI', kind: 'daily', rule: 'daily 09:00 Asia/Tokyo', nextAt: Date.now() + 3600_000, status: 'active', lastDeliveredAt: null }] } }
        case 'sessions.search':
          return { ok: true, result: { hits: [{ sessionId: 's1', title: 'Fix login', workspaceId: 'ws-1', role: 'user', turn: 2, at: Date.now(), snippet: 'the login form breaks on Safari' }], scanned: 4, partial: false, untrusted: true } }
        case 'session.fork':
          return { ok: true, result: { session: { sessionId: 's2', title: 'Try B', workspaceId: 'ws-1' }, forkedFrom: 's1' } }
        case 'job.stop':
          return { ok: true, result: { stopped: true, status: 'killed' } }
        case 'schedule.create':
          return { ok: true, result: { schedule: { scheduleId: 'schedule-2' } } }
        case 'schedule.delete':
          return { ok: true, result: { deleted: true } }
        default:
          return { ok: true, result: {} }
      }
    })
    const base = `/hosts/${host.hostId}/sessions/s1`

    const page = await (await owner.browser.fetch(base)).text()
    expect(page).toContain('data-testid="hub-jobs"')
    expect(page).toContain('npm run dev')
    expect(page).toContain('data-testid="hub-schedules"')
    expect(page).toContain('daily 09:00 Asia/Tokyo')
    expect(page).toContain(`action="${base}/fork"`)

    const search = await (await owner.browser.fetch(`/hosts/${host.hostId}?q=login%20safari`)).text()
    expect(search).toContain('data-testid="hub-search"')
    expect(search).toContain('the login form breaks on Safari')
    expect(requests.find(frame => frame.op === 'sessions.search')?.params).toEqual({ hostId: host.hostId, query: 'login safari', limit: 30 })
    const hostPage = await (await owner.browser.fetch(`/hosts/${host.hostId}`)).text()
    expect(hostPage).toContain(`action="/hosts/${host.hostId}/terminal"`)

    const forked = await owner.browser.postForm(`${base}/fork`, { atTurn: '2', title: 'Try B' })
    expect(forked.headers.get('location')).toBe(`/hosts/${host.hostId}/sessions/s2?msg=forked`)
    expect(requests.find(frame => frame.op === 'session.fork')?.params).toEqual({ hostId: host.hostId, sessionId: 's1', atTurn: 2, title: 'Try B' })

    const stopped = await owner.browser.postForm(`${base}/job-stop`, { jobId: 'bash-1' })
    expect(stopped.headers.get('location')).toBe(`${base}?msg=job-stopped`)
    expect(requests.find(frame => frame.op === 'job.stop')?.params).toEqual({ hostId: host.hostId, jobId: 'bash-1' })

    const created = await owner.browser.postForm(`${base}/schedule-create`, { idempotencyKey: 'key-1', title: 'Weekly report', prompt: 'Summarize the week', kind: 'weekly', time: '18:30', timeZone: 'Asia/Tokyo', weekday: ['5', '1'] })
    expect(created.headers.get('location')).toBe(`${base}?msg=schedule-created`)
    expect(requests.find(frame => frame.op === 'schedule.create')?.params).toEqual({ hostId: host.hostId, sessionId: 's1', title: 'Weekly report', prompt: 'Summarize the week', when: { weekly: { time: '18:30', timeZone: 'Asia/Tokyo', weekdays: [1, 5] } }, idempotencyKey: 'key-1' })
    const bad = await owner.browser.postForm(`${base}/schedule-create`, { idempotencyKey: 'key-2', title: 'x', prompt: 'y', kind: 'weekly', time: '18:30', timeZone: 'Asia/Tokyo' })
    expect(await bad.text()).toContain('曜日を 1 つ以上選んでください')
    expect(requests.filter(frame => frame.op === 'schedule.create')).toHaveLength(1)

    const deleted = await owner.browser.postForm(`${base}/schedule-delete`, { scheduleId: 'schedule-1' })
    expect(deleted.headers.get('location')).toBe(`${base}?msg=schedule-deleted`)
    expect(requests.find(frame => frame.op === 'schedule.delete')?.params).toEqual({ hostId: host.hostId, sessionId: 's1', scheduleId: 'schedule-1' })
  })

  it('serves the new operations over MCP and the HTTP API', async () => {
    const owner = await setupOwner()
    const { host, requests } = await fullHost(owner, frame => ({ ok: true, result: frame.op === 'schedules.list' ? { schedules: [] } : { hits: [], scanned: 0, partial: false, untrusted: true } }))
    const token = await cliToken(owner, MCP, ['dsh.read', 'dsh.content', 'dsh.tasks'])
    await env.HUB.get(env.HUB.idFromName('hub')).setGrant('remora-cli', host.hostId, 'request', 'full')
    const tools = await hubFetch('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }) })
    const definitions = ((await tools.json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean } }[] } }).result.tools
    const names = definitions.map(tool => tool.name)
    for (const name of ['dsh_task_start', 'dsh_task_steer', 'dsh_task_resubmit', 'dsh_attention_respond', 'dsh_goal_manage', 'dsh_command_run', 'dsh_schedule_create', 'dsh_approval_respond', 'dsh_terminal_run']) {
      expect(definitions.find(tool => tool.name === name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true })
    }
    expect(definitions.find(tool => tool.name === 'dsh_status')?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
    for (const name of ['dsh_sessions_search', 'dsh_session_fork', 'dsh_job_stop', 'dsh_schedules_list', 'dsh_schedule_create', 'dsh_schedule_delete', 'dsh_terminal_run', 'dsh_confirmation_get']) expect(names).toContain(name)
    const searched = await mcpTool(token, 'dsh_sessions_search', { hostId: host.hostId, query: 'deploy' })
    expect(searched.isError).toBe(false)
    expect(searched.content[0]?.text).toContain('untrusted data')
    const api = await cliToken(owner, `${ORIGIN}/api/v1/ops`, ['dsh.read'])
    const listed = await hubFetch('/api/v1/ops/schedules.list', { method: 'POST', headers: { authorization: `Bearer ${api}`, 'content-type': 'application/json' }, body: JSON.stringify({ hostId: host.hostId }) })
    expect(listed.status).toBe(200)
    expect(requests.map(frame => frame.op)).toEqual(expect.arrayContaining(['sessions.search', 'schedules.list']))
  })
})
