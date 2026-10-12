// Flow: hub + pairing + tokens + tasks, end to end.
//
//   hub.start        wrangler dev on 127.0.0.1:8788, empty state, SETUP_TOKEN set
//   hub.owner        owner passkey registration with a CDP virtual authenticator
//   host.pair        Remora tab shows a code → owner approves /pair?code=… → tab says Connected
//   token.mint       personal token from the hub UI, else OAuth 2.1 + PKCE (client remora-cli)
//   task.complete    POST /api/v1/ops/task.start → task.wait until completed → reply is the mock's
//   task.attention   ask_user_question → needs_attention → attention.respond → completed
//   kill-switch      kill switch on in DSH → task.start is refused → off again
//
// Each step detects features that are not there yet (501 from the hub, a
// missing control in the UI) and skips with the reason, so this scenario
// grows into the full E2E as the hub and plugin streams land.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { ANSWERED_PREFIX, ASK_MARKER, REPLY_PREFIX } from './lib/mock-llm.mjs'
import { addVirtualAuthenticator, firstPresent, instrument, mustBePresent, requirePresent, shot } from './lib/browser.mjs'
import { HUB_PATHS, hub as HUB, remora as REMORA } from './lib/selectors.mjs'
import { hubApi, startHub } from './lib/hub.mjs'
import { Skip } from './lib/steps.mjs'
import { openRemoraTab, openSettings } from './browser-check.mjs'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const CLI_CLIENT_ID = 'remora-cli'
const SCOPES = 'dsh.read dsh.content dsh.tasks'

const base64url = buffer => Buffer.from(buffer).toString('base64url')

/** Long-poll task.wait (≤ 25 s per call on the hub) until `until(state)` or the deadline. */
async function waitTask(api, taskId, until, deadlineMs = 120_000) {
  const deadline = Date.now() + deadlineMs
  let task
  while (Date.now() < deadline) {
    ;({ body: task } = await api('task.wait', { taskId, timeoutMs: Math.min(25_000, deadline - Date.now()) }))
    if (until(task.state)) return task
  }
  throw new Error(`task ${taskId} still ${task?.state} after ${deadlineMs} ms: ${JSON.stringify(task)}`)
}

async function ensureRemoraTab(page) {
  const close = await firstPresent(page, scope => scope.getByRole('dialog'), 500)
  if (!close) await openSettings(page)
  return openRemoraTab(page)
}

export async function flowSteps(r, { browser, artifacts, hubDir, hubPort, hubUrl, setupToken, world, mock, dshSession, log }) {
  const state = { setupToken: setupToken ?? `e2e-${randomUUID()}` }
  const failShot = (name, which = 'hub') => async () => {
    const page = which === 'hub' ? state.hubPage : dshSession?.page
    if (page) await shot(page, artifacts, `flow-FAILED-${name}`).catch(() => {})
  }

  await r.step('hub.start', hubUrl ? `Use the already running hub at ${hubUrl}` : `Hub runs under wrangler dev on :${hubPort} with an empty state`, { timeoutMs: 360_000 }, async () => {
    const started = hubUrl
      ? { origin: new URL(hubUrl).origin, health: await (await fetch(new URL('/healthz', hubUrl))).json() }
      : await startHub({ hubDir, port: hubPort, stateDir: world.hubState, setupToken: state.setupToken, logFile: `${artifacts}/hub.log` })
    state.hub = started
    state.api = hubApi(started.origin)
    const unauth = await fetch(`${started.origin}/api/v1/ops/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    return `${started.origin} version=${started.health.version}; unauthenticated /api/v1/ops/status → ${unauth.status}${unauth.status === 501 ? ' (HTTP API not implemented yet)' : ''}`
  })

  await r.step('hub.owner', 'Owner registers a passkey (virtual authenticator) with the SETUP_TOKEN', { needs: ['hub.start'], timeoutMs: 90_000, onFailure: failShot('owner') }, async () => {
    const context = await browser.newContext({ viewport: { width: 430, height: 900 }, locale: 'en-US', timezoneId: 'UTC' })
    state.hubContext = context
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    state.hubIssues = instrument(page, 'hub', log)
    state.hubPage = page
    state.authenticator = await addVirtualAuthenticator(page)
    await page.goto(`${state.hub.origin}${HUB_PATHS.home}`)
    let tokenInput = await firstPresent(page, HUB.setupTokenInput, 3000)
    if (!tokenInput) {
      await page.goto(`${state.hub.origin}${HUB_PATHS.setup}`)
      tokenInput = await firstPresent(page, HUB.setupTokenInput, 3000)
    }
    const register = await firstPresent(page, HUB.registerPasskey, 2000)
    if (!tokenInput && !register) {
      await shot(page, artifacts, 'flow-hub-home')
      throw new Skip(`the hub has no owner setup UI yet (no setup-token field or "register passkey" button on ${HUB_PATHS.home} or ${HUB_PATHS.setup})`)
    }
    if (tokenInput) await tokenInput.fill(state.setupToken)
    await (register ?? await mustBePresent(page, HUB.registerPasskey, 'register passkey button')).click()
    // Recovery codes may be shown first; acknowledge them if they are.
    const next = await firstPresent(page, [...HUB.signedIn, ...HUB.recoveryAcknowledge], 15_000)
    const ack = next && !(await firstPresent(page, HUB.signedIn, 100)) ? next : null
    if (ack) {
      await shot(page, artifacts, 'flow-hub-recovery-codes')
      await ack.click()
    }
    await mustBePresent(page, HUB.signedIn, 'a signed-in marker after passkey registration', 20_000)
    const credentials = await state.authenticator.credentials()
    if (credentials.length < 1) throw new Error('the virtual authenticator holds no credential after registration')
    const path = await shot(page, artifacts, 'flow-hub-signed-in')
    return `${credentials.length} passkey(s) on the virtual authenticator (rpId ${credentials[0].rpId}); ${path}`
  })

  await r.step('host.pair', 'DSH host pairs: code from the Remora tab, approved on /pair, tab shows Connected', { needs: ['hub.owner', 'browser.remora-tab'], timeoutMs: 120_000, onFailure: failShot('pair', 'dsh') }, async () => {
    const page = dshSession.page
    const { section } = await ensureRemoraTab(page)
    const hubUrl = await requirePresent(section, REMORA.hubUrlInput, 'the Remora tab has no hub URL field yet (pairing UI not implemented)')
    await hubUrl.fill(state.hub.origin)
    const pair = await requirePresent(section, REMORA.pairStart, 'the Remora tab has no "Pair" button yet')
    await pair.click()
    const codeLocator = await mustBePresent(section, REMORA.pairCode, 'a XXXX-XXXX pairing code in the Remora tab', 20_000)
    const code = (await codeLocator.innerText()).trim().match(/[A-Z0-9]{4}-?[A-Z0-9]{4}/)?.[0]
    if (!code) throw new Error(`could not read a pairing code from "${await codeLocator.innerText()}"`)
    await shot(page, artifacts, 'flow-dsh-pair-code')
    const hubPage = state.hubPage
    await hubPage.goto(`${state.hub.origin}/pair?code=${encodeURIComponent(code)}`)
    const shown = await firstPresent(hubPage, HUB.pairCode, 5000)
    if (shown && !(await shown.innerText()).replace(/-/g, '').includes(code.replace(/-/g, ''))) throw new Error(`hub shows code "${await shown.innerText()}", DSH showed ${code}`)
    await (await mustBePresent(hubPage, HUB.pairApprove, 'the Approve button on /pair')).click()
    await firstPresent(hubPage, HUB.pairApproved, 15_000)
    await shot(hubPage, artifacts, 'flow-hub-pair-approved')
    await mustBePresent(section, REMORA.hubConnected, 'the Remora tab switching to Connected', 60_000)
    const path = await shot(page, artifacts, 'flow-dsh-connected')
    return `code ${code} approved; DSH tab shows Connected; ${path}`
  })

  await r.step('token.mint', 'Mint an API token: personal token, else OAuth 2.1 + PKCE (client remora-cli)', { needs: ['hub.owner'], timeoutMs: 90_000, onFailure: failShot('token') }, async () => {
    const page = state.hubPage
    await page.goto(`${state.hub.origin}${HUB_PATHS.tokens}`)
    const create = await firstPresent(page, HUB.tokenCreate, 3000)
    if (create) {
      const name = await firstPresent(page, HUB.tokenName, 1000)
      if (name) await name.fill('remora-e2e')
      const tasks = await firstPresent(page, HUB.tokenScopeRequest, 1000)
      if (tasks && !(await tasks.isChecked().catch(() => true))) await tasks.check()
      await create.click()
      const value = await mustBePresent(page, HUB.tokenValue, 'the new token value', 15_000)
      state.token = (await value.innerText()).trim() || await value.inputValue()
      await shot(page, artifacts, 'flow-hub-token')
      state.api = hubApi(state.hub.origin, state.token)
      return `personal token (${state.token.length} chars) from ${HUB_PATHS.tokens}`
    }
    // OAuth 2.1 authorization code + PKCE, the CLI's loopback flow driven by the browser.
    const metadata = await fetch(`${state.hub.origin}/.well-known/oauth-authorization-server`)
    if (metadata.status === 501 || metadata.status === 404) throw new Skip(`no personal-token UI at ${HUB_PATHS.tokens} and OAuth metadata answers ${metadata.status}`)
    const meta = await metadata.json()
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    // A loopback redirect (RFC 8252); Playwright intercepts it, nothing needs to listen.
    const redirectUri = `${mock.url}/remora-e2e/callback`
    const oauthState = base64url(randomBytes(12))
    const authorize = new URL(meta.authorization_endpoint ?? `${state.hub.origin}/oauth/authorize`)
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: CLI_CLIENT_ID, redirect_uri: redirectUri, scope: SCOPES, state: oauthState, code_challenge: challenge, code_challenge_method: 'S256' })) authorize.searchParams.set(key, value)
    let resolveCode
    const codePromise = new Promise(resolve => { resolveCode = resolve })
    await page.route(`${redirectUri}**`, route => { resolveCode(new URL(route.request().url())); void route.fulfill({ status: 200, contentType: 'text/plain', body: 'remora e2e: authorization received' }) })
    const response = await page.goto(authorize.href)
    if (response?.status() === 501) throw new Skip('/oauth/authorize answers 501 (OAuth not implemented yet)')
    const approve = await firstPresent(page, HUB.consentApprove, 8000)
    if (approve) {
      await shot(page, artifacts, 'flow-hub-consent')
      await approve.click()
    }
    const redirected = await Promise.race([codePromise, new Promise((_, reject) => setTimeout(() => reject(new Error('no redirect to the loopback callback within 20 s')), 20_000))])
    if (redirected.searchParams.get('state') !== oauthState) throw new Error('OAuth state mismatch')
    const code = redirected.searchParams.get('code')
    if (!code) throw new Error(`callback without code: ${redirected.href}`)
    const tokenResponse = await fetch(meta.token_endpoint ?? `${state.hub.origin}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: CLI_CLIENT_ID, code_verifier: verifier }),
    })
    const tokens = await tokenResponse.json().catch(() => ({}))
    if (!tokenResponse.ok || !tokens.access_token) throw new Error(`token exchange failed: ${tokenResponse.status} ${JSON.stringify(tokens)}`)
    state.token = tokens.access_token
    state.api = hubApi(state.hub.origin, state.token)
    return `OAuth access token (scope "${tokens.scope ?? SCOPES}", expires_in ${tokens.expires_in ?? '?'})`
  })

  await r.step('task.complete', 'task.start on a DSH session → task.wait → completed with the mock model\'s reply', { needs: ['host.pair', 'token.mint'], timeoutMs: 180_000, onFailure: failShot('task', 'dsh') }, async () => {
    // task.start needs "Can request" on the DSH side; raise the ceiling when the tab offers it.
    const { section } = await ensureRemoraTab(dshSession.page)
    const ceiling = await firstPresent(section, REMORA.ceilingRequest, 2000)
    if (ceiling) await ceiling.click()
    const { body: hosts } = await state.api('hosts.list')
    const host = hosts.hosts?.find(item => item.online)
    if (!host) throw new Error(`no online host in hosts.list: ${JSON.stringify(hosts)}`)
    let target = { latest: true }
    try {
      const { body } = await state.api('sessions.list', { hostId: host.hostId, limit: 20 })
      const session = body.sessions?.find(item => !item.archived && !item.parentSessionId)
      if (session) target = { sessionId: session.sessionId }
    } catch (error) { if (!(error instanceof Skip)) throw error }
    const nonce = `t${randomBytes(4).toString('hex')}`
    const idempotencyKey = randomUUID()
    const params = { hostId: host.hostId, target, prompt: `Remora E2E: reply with the nonce. nonce=${nonce}`, idempotencyKey }
    const { body: started } = await state.api('task.start', params)
    const { body: again } = await state.api('task.start', params)
    if (again.taskId !== started.taskId) throw new Error(`same idempotencyKey started a second task: ${started.taskId} vs ${again.taskId}`)
    const task = await waitTask(state.api, started.taskId, value => TERMINAL.has(value) || value === 'needs_attention')
    if (task.state !== 'completed') throw new Error(`task ended ${task.state}: ${JSON.stringify(task)}`)
    const expected = `${REPLY_PREFIX} ${nonce}`
    if (!task.result?.reply?.includes(expected)) throw new Error(`reply "${task.result?.reply}" does not contain "${expected}"`)
    if (!mock.requests.some(request => request.lastUserText.includes(`nonce=${nonce}`))) throw new Error('the mock LLM never saw the prompt')
    state.host = host
    state.target = target
    await shot(dshSession.page, artifacts, 'flow-dsh-after-task')
    return `task ${started.taskId} on ${JSON.stringify(target)} completed; reply "${task.result.reply}"; idempotent re-start returned the same task`
  })

  await r.step('task.attention', 'ask_user_question → needs_attention → attention.respond → completed', { needs: ['task.complete'], timeoutMs: 180_000, onFailure: failShot('attention', 'dsh') }, async () => {
    const nonce = `a${randomBytes(4).toString('hex')}`
    const { body: started } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: `Remora E2E attention test ${ASK_MARKER} nonce=${nonce}`, idempotencyKey: randomUUID() })
    const waiting = await waitTask(state.api, started.taskId, value => TERMINAL.has(value) || value === 'needs_attention')
    if (waiting.state !== 'needs_attention') throw new Error(`expected needs_attention, got ${waiting.state}: ${JSON.stringify(waiting)}`)
    const item = waiting.attention?.find(entry => entry.kind === 'question')
    if (!item) throw new Error(`no question in attention: ${JSON.stringify(waiting.attention)}`)
    await shot(dshSession.page, artifacts, 'flow-dsh-question')
    if (!item.answerable) throw new Skip(`question ${item.attentionId} reached the hub as needs_attention, but it is not answerable remotely (legacy question mode)`)
    const option = item.options?.[0]
    await state.api('attention.respond', { hostId: state.host.hostId, attentionId: item.attentionId, sessionId: item.sessionId, answer: option ? { optionId: option.id } : { text: 'Teal' } })
    const done = await waitTask(state.api, started.taskId, value => TERMINAL.has(value))
    if (done.state !== 'completed' || !done.result?.reply?.includes(`${ANSWERED_PREFIX} ${nonce}`)) throw new Error(`after answering: ${JSON.stringify(done)}`)
    return `question "${item.title}" answered with ${option?.label ?? 'text'}; reply "${done.result.reply}"`
  })

  await r.step('kill-switch.enforced', 'With the kill switch on, task.start is refused; off again afterwards', { needs: ['task.complete'], timeoutMs: 90_000, onFailure: failShot('kill-switch', 'dsh') }, async () => {
    const page = dshSession.page
    let { killSwitch } = await ensureRemoraTab(page)
    if (await killSwitch.getAttribute('aria-pressed') !== 'true') await killSwitch.click()
    await page.waitForTimeout(1500)
    let refused
    try {
      const { status, body } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: 'Remora E2E: must be refused nonce=killed', idempotencyKey: randomUUID() }, { allow: [403, 409, 423, 503] })
      refused = status >= 400 ? `${status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}` : undefined
      if (!refused) throw new Error(`task.start was accepted with the kill switch on: ${JSON.stringify(body)}`)
    } finally {
      ;({ killSwitch } = await ensureRemoraTab(page))
      if (await killSwitch.getAttribute('aria-pressed') === 'true') await killSwitch.click()
    }
    return `refused: ${refused}`
  })

  return state
}

export async function stopFlow(state) {
  await state?.authenticator?.detach()
  await state?.hubContext?.close().catch(() => {})
  await state?.hub?.proc?.stop()
}

