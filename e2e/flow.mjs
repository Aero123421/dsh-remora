// Flow: hub + pairing + tokens + tasks, end to end.
//
//   hub.start        wrangler dev on 127.0.0.1:8788, empty state, SETUP_TOKEN set
//   hub.owner        owner passkey registration with a CDP virtual authenticator
//   host.pair        Remora tab shows a code → owner approves /pair?code=… (passkey re-auth) → tab says Connected
//   host.permit      DSH ceiling "Can request" and the default workspace in scope (Remora tab)
//   token.mint       personal token on /settings (passkey re-auth), granted "request" on /connections
//   task.complete    POST /api/v1/ops/task.start → task.wait until completed → reply is the mock's
//   task.attention   ask_user_question (timed mode) → needs_attention → attention.respond → completed
//   kill-switch      kill switch on in DSH → task.start is refused → off again → tasks run
//
// Each step detects features that are not there yet (501 from the hub, a
// missing control in the UI) and skips with the reason, so this scenario
// grows into the full E2E as the hub and plugin streams land.
import { randomBytes, randomUUID } from 'node:crypto'
import { ANSWERED_PREFIX, ASK_MARKER, REPLY_PREFIX } from './lib/mock-llm.mjs'
import { addVirtualAuthenticator, firstPresent, instrument, mustBePresent, requirePresent, shot } from './lib/browser.mjs'
import { HUB_PATHS, hub as HUB, remora as REMORA } from './lib/selectors.mjs'
import { hubApi, startHub } from './lib/hub.mjs'
import { Skip } from './lib/steps.mjs'
import { killSwitchOn, openRemoraSubTab, openRemoraTab, openSettings, rpcBody, toggleKillSwitch } from './browser-check.mjs'

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const SCOPES = 'dsh.read dsh.content dsh.tasks'


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
    const context = await browser.newContext({ viewport: { width: 430, height: 900 }, locale: 'ja-JP', timezoneId: 'UTC' })
    state.hubContext = context
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    state.hubIssues = instrument(page, 'hub', log)
    state.hubPage = page
    state.authenticator = await addVirtualAuthenticator(page)
    await page.goto(`${state.hub.origin}${HUB_PATHS.setup}`)
    const tokenInput = await firstPresent(page, HUB.setupTokenInput, 5000)
    if (!tokenInput) {
      await shot(page, artifacts, 'flow-hub-home')
      throw new Skip(`the hub has no owner setup form at ${HUB_PATHS.setup}`)
    }
    await tokenInput.fill(state.setupToken)
    const label = await firstPresent(page, HUB.setupLabelInput, 500)
    if (label) await label.fill('Remora E2E (virtual authenticator)')
    await (await mustBePresent(page, HUB.registerPasskey, 'the "register passkey" button')).click()
    const codes = await firstPresent(page, HUB.recoveryCodes, 20_000)
    if (!codes) {
      const status = await firstPresent(page, HUB.setupStatus, 100)
      throw new Error(`no recovery codes after registration${status ? `: ${await status.innerText()}` : ''}`)
    }
    const recovery = (await codes.innerText()).split('\n').filter(Boolean)
    await shot(page, artifacts, 'flow-hub-recovery-codes')
    await (await mustBePresent(page, HUB.recoveryAcknowledge, 'the "saved them, continue" link')).click()
    await mustBePresent(page, HUB.signedIn, 'the signed-in navigation after setup', 20_000)
    const credentials = await state.authenticator.credentials()
    if (credentials.length < 1) throw new Error('the virtual authenticator holds no credential after registration')
    const path = await shot(page, artifacts, 'flow-hub-signed-in')
    return `${credentials.length} passkey(s) on the virtual authenticator (rpId ${credentials[0].rpId}), ${recovery.length} recovery codes shown once; ${path}`
  })

  await r.step('host.pair', 'DSH host pairs: code from the Remora tab, approved on /pair with passkey re-auth, tab shows Connected', { needs: ['hub.owner', 'browser.remora-tab'], timeoutMs: 150_000, onFailure: failShot('pair', 'dsh') }, async () => {
    const page = dshSession.page
    const { section } = await ensureRemoraTab(page)
    await openRemoraSubTab(section, REMORA.tabs.connection)
    const hubUrl = await requirePresent(section, REMORA.hubUrlInput, 'the Remora tab has no hub URL field')
    await hubUrl.fill(state.hub.origin)
    const pair = await requirePresent(section, REMORA.pairStart, 'the Remora tab has no "Start pairing" button')
    await pair.click()
    const codeLocator = await mustBePresent(section, REMORA.pairCode, 'a pairing code in the Remora tab', 20_000)
    const code = (await codeLocator.innerText()).trim().match(/[A-Z0-9]{4}-?[A-Z0-9]{4}/)?.[0]
    if (!code) throw new Error(`could not read a pairing code from "${await codeLocator.innerText()}"`)
    await shot(page, artifacts, 'flow-dsh-pair-code')
    const hubPage = state.hubPage
    await hubPage.goto(`${state.hub.origin}/pair?code=${encodeURIComponent(code)}`)
    const shown = await firstPresent(hubPage, HUB.pairCode, 5000)
    if (shown && !(await shown.innerText()).replace(/-/g, '').includes(code.replace(/-/g, ''))) throw new Error(`hub shows code "${await shown.innerText()}", DSH showed ${code}`)
    await shot(hubPage, artifacts, 'flow-hub-pair-confirm')
    await (await mustBePresent(hubPage, HUB.pairApprove, 'the approve button on /pair')).click()
    await hubPage.waitForURL(/\/hosts\/[^/?]+\?paired=1/, { timeout: 20_000 })
    state.hostId = new URL(hubPage.url()).pathname.split('/').pop()
    await shot(hubPage, artifacts, 'flow-hub-pair-approved')
    await mustBePresent(section, REMORA.hubConnected, 'the Remora tab switching to Connected', 60_000)
    const path = await shot(page, artifacts, 'flow-dsh-connected')
    return `code ${code} approved (passkey re-auth); host ${state.hostId}; DSH tab shows Connected; ${path}`
  })

  await r.step('host.permit', 'DSH side: ceiling "Can request" and the default workspace in scope', { needs: ['host.pair'], timeoutMs: 60_000, onFailure: failShot('permit', 'dsh') }, async () => {
    const page = dshSession.page
    const { section } = await ensureRemoraTab(page)
    await openRemoraSubTab(section, REMORA.tabs.permissions)
    const request = await mustBePresent(section, REMORA.ceilingRequest, 'the "Can request" level')
    if (await request.getAttribute('aria-checked') !== 'true') {
      const reply = page.waitForResponse(response => /\/api\/remora\/permission$/.test(response.url()), { timeout: 15_000 })
      await request.click()
      const body = await rpcBody(await reply)
      if (!body?.result?.ok) throw new Error(`permission RPC failed: ${JSON.stringify(body)}`)
    }
    await shot(page, artifacts, 'flow-dsh-permissions')
    await openRemoraSubTab(section, REMORA.tabs.scope)
    // The first allow list is the workspaces; DSH created exactly one (the default workspace).
    const workspace = await mustBePresent(section, REMORA.scopeSwitches, 'a workspace switch in the Scope tab', 15_000)
    const name = await workspace.getAttribute('aria-label') ?? await workspace.innerText()
    if (await workspace.getAttribute('aria-checked') !== 'true') {
      const reply = page.waitForResponse(response => /\/api\/remora\/settings$/.test(response.url()), { timeout: 15_000 })
      await workspace.click()
      const body = await rpcBody(await reply)
      if (!body?.result?.ok) throw new Error(`settings RPC failed: ${JSON.stringify(body)}`)
    }
    const path = await shot(page, artifacts, 'flow-dsh-scope')
    return `ceiling request; workspace "${name}" in scope; ${path}`
  })

  await r.step('token.mint', 'Personal token (dsh.read, dsh.content, dsh.tasks) with passkey re-auth, granted "request" on the host', { needs: ['host.permit'], timeoutMs: 90_000, onFailure: failShot('token') }, async () => {
    const page = state.hubPage
    await page.goto(`${state.hub.origin}${HUB_PATHS.tokens}`)
    const form = await requirePresent(page, HUB.tokenForm, `no personal-token form at ${HUB_PATHS.tokens}`)
    const name = `remora-e2e-${randomBytes(3).toString('hex')}`
    await (await mustBePresent(form, HUB.tokenName, 'the token name field')).fill(name)
    for (const scope of SCOPES.split(' ')) await HUB.tokenScope(scope)(form).check()
    await (await mustBePresent(form, HUB.tokenCreate, 'the issue button')).click()
    const value = await mustBePresent(page, HUB.tokenValue, 'the new token value', 20_000)
    state.token = (await value.innerText()).trim()
    if (state.token.length < 20) throw new Error(`token looks wrong: "${state.token}"`)
    state.api = hubApi(state.hub.origin, state.token)
    // The hub offers "request" once the host's status frame carried the raised ceiling.
    let select
    let options = []
    for (const deadline = Date.now() + 30_000; ;) {
      await page.goto(`${state.hub.origin}${HUB_PATHS.connections}`)
      const card = HUB.clientCard(name)(page).first()
      await card.waitFor({ timeout: 10_000 })
      select = await mustBePresent(card, HUB.grantSelect, 'the grant level select on the token card')
      options = await select.locator('option').evaluateAll(nodes => nodes.map(node => node.value))
      if (options.includes('request')) break
      if (Date.now() > deadline) throw new Error(`grant levels offered: ${options.join(', ')} (the hub never learned the DSH ceiling)`)
      await page.waitForTimeout(1000)
    }
    await Promise.all([page.waitForURL(/msg=grant-saved/, { timeout: 20_000 }), select.selectOption('request')])
    const path = await shot(page, artifacts, 'flow-hub-grant')
    const { body } = await state.api('hosts.list')
    const host = body.hosts?.find(item => item.hostId === state.hostId)
    if (host?.grant?.level !== 'request') throw new Error(`hosts.list shows grant ${JSON.stringify(host?.grant)}`)
    return `token "${name}" (${state.token.length} chars), grant request on ${state.hostId}; ${path}`
  })

  await r.step('task.complete', 'task.start on a DSH session → task.wait → completed with the mock model\'s reply', { needs: ['token.mint'], timeoutMs: 180_000, onFailure: failShot('task', 'dsh') }, async () => {
    const { body: hosts } = await state.api('hosts.list')
    const host = hosts.hosts?.find(item => item.hostId === state.hostId)
    if (!host?.online) throw new Error(`host is not online in hosts.list: ${JSON.stringify(hosts)}`)
    const { body } = await state.api('sessions.list', { hostId: host.hostId, limit: 20 })
    const session = body.sessions?.find(item => !item.archived && !item.parentSessionId)
    if (!session) throw new Error(`sessions.list returned no usable session: ${JSON.stringify(body)}`)
    const target = { sessionId: session.sessionId }
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
    return `task ${started.taskId} on session "${session.title}" completed; reply "${task.result.reply}"; idempotent re-start returned the same task`
  })

  await r.step('task.attention', 'ask_user_question (timed mode) → needs_attention → attention.respond → completed', { needs: ['task.complete'], timeoutMs: 180_000, onFailure: failShot('attention', 'dsh') }, async () => {
    const nonce = `a${randomBytes(4).toString('hex')}`
    const { body: started } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: `Remora E2E attention test ${ASK_MARKER} nonce=${nonce}`, idempotencyKey: randomUUID() })
    const waiting = await waitTask(state.api, started.taskId, value => TERMINAL.has(value) || value === 'needs_attention')
    if (waiting.state !== 'needs_attention') throw new Error(`expected needs_attention, got ${waiting.state}: ${JSON.stringify(waiting)}`)
    let item = waiting.attention?.find(entry => entry.kind === 'question')
    for (let tries = 0; (!item || !item.answerable) && tries < 20; tries++) {
      await new Promise(resolve => setTimeout(resolve, 500))
      const { body } = await state.api('task.get', { taskId: started.taskId })
      item = body.attention?.find(entry => entry.kind === 'question') ?? item
    }
    if (!item) throw new Error(`no question in attention: ${JSON.stringify(waiting.attention)}`)
    await shot(dshSession.page, artifacts, 'flow-dsh-question')
    if (!item.answerable) throw new Error(`question ${item.attentionId} is not answerable remotely (is tool-ask-user in timed mode?)`)
    const { body: listed } = await state.api('attention.list', { hostId: state.host.hostId })
    if (!listed.items?.some(entry => entry.attentionId === item.attentionId)) throw new Error(`attention.list does not include ${item.attentionId}`)
    const option = item.options?.find(entry => /Teal/.test(entry.label)) ?? item.options?.[0]
    await state.api('attention.respond', { hostId: state.host.hostId, attentionId: item.attentionId, sessionId: item.sessionId, answer: option ? { optionId: option.id } : { text: 'Teal' } })
    const done = await waitTask(state.api, started.taskId, value => TERMINAL.has(value))
    if (done.state !== 'completed' || !done.result?.reply?.includes(`${ANSWERED_PREFIX} ${nonce}`)) throw new Error(`after answering: ${JSON.stringify(done)}`)
    return `question "${item.title}" answered with ${option?.label ?? 'text'}; reply "${done.result.reply}"`
  })

  await r.step('kill-switch.enforced', 'With the kill switch on, task.start is refused; off again and tasks run', { needs: ['task.complete'], timeoutMs: 120_000, onFailure: failShot('kill-switch', 'dsh') }, async () => {
    const page = dshSession.page
    let { killSwitch } = await ensureRemoraTab(page)
    if (!(await killSwitchOn(killSwitch))) await toggleKillSwitch(page, killSwitch)
    let refused
    try {
      // The host reports the switch to the hub before it drops the connection.
      const deadline = Date.now() + 20_000
      for (;;) {
        const { status, body } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: 'Remora E2E: must be refused nonce=killed', idempotencyKey: randomUUID() }, { allow: [403, 409, 423, 503] })
        if (status >= 400) { refused = `${status} ${body?.error?.code ?? ''}: ${body?.error?.message ?? ''}`; break }
        if (Date.now() > deadline) throw new Error(`task.start was accepted with the kill switch on: ${JSON.stringify(body)}`)
        await page.waitForTimeout(1000)
      }
    } finally {
      ;({ killSwitch } = await ensureRemoraTab(page))
      if (await killSwitchOn(killSwitch)) await toggleKillSwitch(page, killSwitch)
    }
    const { section } = await ensureRemoraTab(page)
    await openRemoraSubTab(section, REMORA.tabs.connection)
    await mustBePresent(section, REMORA.hubConnected, 'Connected again after the kill switch is off', 60_000)
    const nonce = `k${randomBytes(4).toString('hex')}`
    const { body: started } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: `Remora E2E after resume nonce=${nonce}`, idempotencyKey: randomUUID() })
    const task = await waitTask(state.api, started.taskId, value => TERMINAL.has(value) || value === 'needs_attention')
    if (task.state !== 'completed' || !task.result?.reply?.includes(`${REPLY_PREFIX} ${nonce}`)) throw new Error(`after resume: ${JSON.stringify(task)}`)
    return `refused: ${refused}; after resume a task completed again`
  })

  return state
}

export async function stopFlow(state) {
  await state?.authenticator?.detach()
  await state?.hubContext?.close().catch(() => {})
  await state?.hub?.proc?.stop()
}

