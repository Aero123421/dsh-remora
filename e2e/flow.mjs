// Flow: hub + pairing + tokens + tasks, end to end.
//
//   hub.start        wrangler dev on 127.0.0.1:8788, empty state, SETUP_TOKEN set
//   hub.owner        owner passkey registration with a CDP virtual authenticator
//   host.pair        Remora tab shows a code → owner approves /pair?code=… (passkey re-auth) → tab says Connected
//   host.permit      DSH ceiling "Can request" and the default workspace in scope (Remora tab)
//   token.mint       personal token on /settings (passkey re-auth), granted "request" on /connections
//   task.complete    POST /api/v1/ops/task.start → task.wait until completed → reply is the mock's
//   task.attention   ask_user_question (timed mode) → needs_attention → attention.respond → completed
//   answer.web-open  blocking ask_user_question while DSH Web is open: Remora holds it too,
//                    attention.respond answers it (no deadline while the Web card waits)
//   answer.no-web    the same with no DSH Web tab: held with a deadline, answered on the hub page
//   approval.passkey a write asking for a sandbox escalation: approval.respond without the
//                    passkey is refused with the hub link; the owner allows it there with the passkey
//   approval.remote  "Allow approvals from MCP and CLI" on (this PC): approval.respond rejects it
//   sessions.search  sessions.search finds the first task's nonce in its prompt and reply
//   session.fork     session.fork copies up to the first task's turn into a new session
//   job.stop         the model starts a background bash job, which keeps the task running →
//                    session.get lists it, job.output reads it, job.stop stops it → task completes
//   schedule.create  a daily prompt is listed and deleted; a one-shot prompt arrives as a new turn
//   terminal.run     the "request" token is refused; with "Full remote access" on in DSH the
//                    owner runs a command from the host page, confirms it with the passkey on
//                    /confirm/… and reads its output there; a second one is denied
//   maintenance.audit  a personal token with dsh.admin asks for audit.export; the owner approves it
//                    on /confirm/hub/… with the passkey; every chain it gets verifies here
//   maintenance.rotate-key  the owner rotates the host key from the host page: the real plugin proves
//                    a new key, reconnects with it, and a task still completes
//   kill-switch      kill switch on in DSH → task.start is refused → off again → tasks run
//
// Each step detects features that are not there yet (501 from the hub, a
// missing control in the UI) and skips with the reason, so this scenario
// grows into the full E2E as the hub and plugin streams land.
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { ANSWERED_PREFIX, APPROVE_MARKER, ASK_BLOCKING_MARKER, ASK_MARKER, JOB_MARKER, JOB_PREFIX, REPLY_PREFIX, WRITE_PREFIX, approvalFile } from './lib/mock-llm.mjs'
import { addVirtualAuthenticator, firstPresent, instrument, mustBePresent, requirePresent, shot } from './lib/browser.mjs'
import { HUB_PATHS, dsh as DSH_SELECTORS, hub as HUB, remora as REMORA } from './lib/selectors.mjs'
import { hubApi, startHub } from './lib/hub.mjs'
import { verifyAuditRecords } from '../packages/protocol/src/audit.ts'
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

/** Path of a file named `name` under `root` (a few levels deep), or null. */
function findFile(root, name, depth = 5) {
  let entries
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { return null }
  for (const entry of entries) if (entry.isFile() && entry.name === name) return join(root, entry.name)
  if (depth === 0) return null
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const found = findFile(join(root, entry.name), name, depth - 1)
    if (found) return found
  }
  return null
}

/** Poll task.get until an attention item matches, or throw with the last list. */
async function waitAttention(api, taskId, match, deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs
  let items = []
  while (Date.now() < deadline) {
    const { body } = await api('task.get', { taskId })
    items = body.attention ?? []
    const found = items.find(match)
    if (found) return found
    if (TERMINAL.has(body.state)) throw new Error(`task ${taskId} ended ${body.state} while waiting for attention: ${JSON.stringify(body)}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`no matching attention item after ${deadlineMs} ms: ${JSON.stringify(items)}`)
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
    state.firstNonce = nonce
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

  await r.step('answer.web-open', 'Blocking ask_user_question while DSH Web is open: Remora holds it too and attention.respond answers it', { needs: ['task.complete'], timeoutMs: 180_000, onFailure: failShot('answer-web', 'dsh') }, async () => {
    const nonce = `b${randomBytes(4).toString('hex')}`
    const { body: started } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: `Remora E2E blocking question ${ASK_BLOCKING_MARKER} nonce=${nonce}`, idempotencyKey: randomUUID() })
    const item = await waitAttention(state.api, started.taskId, entry => entry.kind === 'question' && entry.answerVia === 'remote')
    await shot(dshSession.page, artifacts, 'flow-dsh-blocking-question')
    if (!item.answerable) throw new Error(`held question is not answerable: ${JSON.stringify(item)}`)
    if (!item.answerUrl?.startsWith(state.hub.origin)) throw new Error(`no hub answerUrl on the item: ${JSON.stringify(item)}`)
    const option = item.options?.find(entry => /Navy/.test(entry.label))
    if (!option) throw new Error(`no Navy option: ${JSON.stringify(item.options)}`)
    await state.api('attention.respond', { hostId: state.host.hostId, attentionId: item.attentionId, sessionId: item.sessionId, answer: { optionId: option.id } })
    const done = await waitTask(state.api, started.taskId, value => TERMINAL.has(value))
    if (done.state !== 'completed' || !done.result?.reply?.includes(`${ANSWERED_PREFIX} ${nonce}`) || !done.result.reply.includes('Navy')) throw new Error(`after answering: ${JSON.stringify(done)}`)
    const path = await shot(dshSession.page, artifacts, 'flow-dsh-blocking-answered')
    const deadline = item.expiresAt === null || item.expiresAt === undefined ? 'no deadline (DSH Web holds the card too)' : `deadline in ${Math.round((item.expiresAt - Date.now()) / 1000)} s (DSH Web passed it on)`
    return `held question answered with Navy through the API; ${deadline}; reply "${done.result.reply}"; ${path}`
  })

  await r.step('answer.no-web', 'Blocking ask_user_question with no DSH Web tab: held with a deadline, answered on the hub page', { needs: ['answer.web-open'], timeoutMs: 180_000, onFailure: failShot('answer-no-web') }, async () => {
    const page = dshSession.page
    const back = page.url()
    // Leaving DSH Web closes its event stream: nothing but Remora can answer now.
    await page.goto('about:blank')
    await new Promise(resolve => setTimeout(resolve, 2000))
    try {
      const nonce = `n${randomBytes(4).toString('hex')}`
      const { body: started } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: `Remora E2E no-web question ${ASK_BLOCKING_MARKER} nonce=${nonce}`, idempotencyKey: randomUUID() })
      const item = await waitAttention(state.api, started.taskId, entry => entry.kind === 'question' && entry.answerVia === 'remote' && typeof entry.expiresAt === 'number')
      const left = Math.round((item.expiresAt - Date.now()) / 1000)
      if (left <= 0 || left > 10 * 60 + 30) throw new Error(`deadline ${left} s away; expected about 10 minutes`)
      const hubPage = state.hubPage
      await hubPage.goto(item.answerUrl)
      const card = await mustBePresent(hubPage, HUB.attentionItem, 'the attention item on its answer page')
      await shot(hubPage, artifacts, 'flow-hub-question-page')
      await HUB.questionOption('Teal')(card).check()
      await Promise.all([hubPage.waitForURL(/\/attention\?msg=sent/, { timeout: 20_000 }), (await mustBePresent(card, HUB.questionAnswer, 'the answer button')).click()])
      const done = await waitTask(state.api, started.taskId, value => TERMINAL.has(value))
      if (done.state !== 'completed' || !done.result?.reply?.includes(`${ANSWERED_PREFIX} ${nonce}`) || !done.result.reply.includes('Teal')) throw new Error(`after answering on the hub: ${JSON.stringify(done)}`)
      return `deadline ${left} s away with no DSH Web tab; answered Teal on ${new URL(item.answerUrl).pathname}; reply "${done.result.reply}"`
    } finally {
      await page.goto(back)
      const notice = await firstPresent(page, DSH_SELECTORS.previewNoticeContinue, 3000)
      if (notice) await notice.click()
      await mustBePresent(page, DSH_SELECTORS.shellReady, 'DSH Web again after the no-web test', 30_000)
    }
  })

  await r.step('approval.passkey', 'An approval (write asking for a sandbox escalation): approval.respond without the passkey is refused with the hub link; the owner allows it there', { needs: ['task.complete'], timeoutMs: 180_000, onFailure: failShot('approval-passkey') }, async () => {
    const nonce = `p${randomBytes(4).toString('hex')}`
    const { body: started } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: `Remora E2E approval ${APPROVE_MARKER} nonce=${nonce}`, idempotencyKey: randomUUID() })
    const item = await waitAttention(state.api, started.taskId, entry => entry.kind === 'approval' && entry.answerable)
    if (item.answerVia !== 'hub-passkey') throw new Error(`expected the hub-passkey route by default: ${JSON.stringify(item)}`)
    const params = { hostId: state.host.hostId, sessionId: item.sessionId, attentionId: item.attentionId, answer: { approve: true } }
    const refused = await state.api('approval.respond', params, { allow: [403] })
    if (refused.status !== 403 || refused.body?.error?.denial?.reason !== 'confirmation-failed') throw new Error(`approval.respond without a passkey: ${refused.status} ${JSON.stringify(refused.body)}`)
    const link = refused.body.error.fix ?? refused.body.error.answerUrl
    if (!link?.startsWith(state.hub.origin)) throw new Error(`the refusal carries no hub link: ${JSON.stringify(refused.body)}`)
    const hubPage = state.hubPage
    await hubPage.goto(link)
    const card = await mustBePresent(hubPage, HUB.attentionItem, 'the approval on its answer page')
    await shot(hubPage, artifacts, 'flow-hub-approval-page')
    await Promise.all([hubPage.waitForURL(/\/attention\?msg=sent/, { timeout: 30_000 }), (await mustBePresent(card, HUB.approvalAllow, 'the "allow once with passkey" button')).click()])
    const done = await waitTask(state.api, started.taskId, value => TERMINAL.has(value))
    if (done.state !== 'completed' || !done.result?.reply?.includes(`${WRITE_PREFIX} ${nonce} done`)) throw new Error(`after allowing: ${JSON.stringify(done)}`)
    const written = findFile(world.root, approvalFile(nonce))
    if (!written) throw new Error(`the allowed write left no ${approvalFile(nonce)} under ${world.root}`)
    return `MCP/CLI refused (${refused.body.error.denial.reason}) with ${new URL(link).pathname}; allowed with the passkey on the hub; reply "${done.result.reply}"; wrote ${written.slice(world.root.length + 1)}`
  })

  await r.step('approval.remote', '"Allow approvals from MCP and CLI" on (this PC): approval.respond answers without the passkey', { needs: ['approval.passkey'], timeoutMs: 180_000, onFailure: failShot('approval-remote', 'dsh') }, async () => {
    const page = dshSession.page
    const toggle = async on => {
      const { section } = await ensureRemoraTab(page)
      await openRemoraSubTab(section, REMORA.tabs.permissions)
      const control = await mustBePresent(section, REMORA.approvalsFromRemote, 'the "Allow approvals from MCP and CLI" switch')
      if ((await control.getAttribute('aria-checked') === 'true') === on) return
      const reply = page.waitForResponse(response => /\/api\/remora\/answers$/.test(response.url()), { timeout: 15_000 })
      await control.click()
      const body = await rpcBody(await reply)
      if (!body?.result?.ok || body.result.value.settings.approvalsFromRemote !== on) throw new Error(`answers RPC failed: ${JSON.stringify(body)}`)
    }
    await toggle(true)
    const shotPath = await shot(page, artifacts, 'flow-dsh-approvals-from-remote')
    try {
      const nonce = `m${randomBytes(4).toString('hex')}`
      const { body: started } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: `Remora E2E approval ${APPROVE_MARKER} nonce=${nonce}`, idempotencyKey: randomUUID() })
      const item = await waitAttention(state.api, started.taskId, entry => entry.kind === 'approval' && entry.answerVia === 'remote')
      await state.api('approval.respond', { hostId: state.host.hostId, sessionId: item.sessionId, attentionId: item.attentionId, answer: { approve: false } })
      const done = await waitTask(state.api, started.taskId, value => TERMINAL.has(value))
      if (done.state !== 'completed' || !done.result?.reply?.includes(`${WRITE_PREFIX} ${nonce} refused`)) throw new Error(`after rejecting: ${JSON.stringify(done)}`)
      if (findFile(world.root, approvalFile(nonce))) throw new Error('the rejected write happened anyway')
      return `switch on (${shotPath}); approval.respond rejected it without a passkey; reply "${done.result.reply}"; no file written`
    } finally {
      await toggle(false)
    }
  })

  await r.step('sessions.search', 'sessions.search finds the first task\'s nonce in its prompt and in the reply', { needs: ['task.complete'], timeoutMs: 60_000 }, async () => {
    const { body } = await state.api('sessions.search', { hostId: state.host.hostId, query: state.firstNonce })
    const mine = (body.hits ?? []).filter(hit => hit.sessionId === state.target.sessionId)
    const roles = [...new Set(mine.map(hit => hit.role))].sort()
    if (!roles.includes('user') || !roles.includes('assistant')) throw new Error(`expected user and assistant hits in ${state.target.sessionId}: ${JSON.stringify(body)}`)
    if (!mine.every(hit => hit.snippet.includes(state.firstNonce))) throw new Error(`a snippet lacks the nonce: ${JSON.stringify(mine)}`)
    const { body: none } = await state.api('sessions.search', { hostId: state.host.hostId, query: `${state.firstNonce} zz-not-there-${randomBytes(3).toString('hex')}` })
    if (none.hits.length !== 0) throw new Error(`an impossible query matched: ${JSON.stringify(none)}`)
    return `${mine.length} hit(s) (${roles.join(', ')}) for "${state.firstNonce}" after scanning ${body.scanned} session(s); an impossible query found nothing`
  })

  await r.step('session.fork', 'session.fork copies the session up to the first task\'s turn into a new session in the same workspace', { needs: ['task.complete'], timeoutMs: 60_000 }, async () => {
    const title = `Remora E2E fork ${randomBytes(2).toString('hex')}`
    // The turn of task.complete (DSH Web's own smoke turn may come first).
    const { body: history } = await state.api('session.read', { hostId: state.host.hostId, sessionId: state.target.sessionId, depth: 'turns', limit: 50 })
    const atTurn = (history.turns ?? []).find(turn => turn.request.includes(`nonce=${state.firstNonce}`))?.index
    if (!atTurn) throw new Error(`no turn with nonce=${state.firstNonce}: ${JSON.stringify(history.turns)}`)
    const { body } = await state.api('session.fork', { hostId: state.host.hostId, sessionId: state.target.sessionId, atTurn, title })
    if (body.forkedFrom !== state.target.sessionId || !body.session?.sessionId || body.session.sessionId === state.target.sessionId) throw new Error(`unexpected fork result: ${JSON.stringify(body)}`)
    const { body: listed } = await state.api('sessions.list', { hostId: state.host.hostId, limit: 50 })
    const original = listed.sessions.find(item => item.sessionId === state.target.sessionId)
    const fork = listed.sessions.find(item => item.sessionId === body.session.sessionId)
    if (!fork || fork.workspaceId !== original?.workspaceId || fork.title !== title) throw new Error(`the fork is not listed in the workspace with its title: ${JSON.stringify(fork)}`)
    const { body: read } = await state.api('session.read', { hostId: state.host.hostId, sessionId: fork.sessionId, depth: 'turns' })
    const turns = read.turns ?? []
    if (turns.length !== atTurn || !turns.at(-1).request.includes(`nonce=${state.firstNonce}`)) throw new Error(`the fork does not end at turn ${atTurn}: ${JSON.stringify(turns)}`)
    return `fork ${fork.sessionId} "${fork.title}" holds turns 1–${atTurn}, ending with "${turns.at(-1).reply.slice(0, 60)}"`
  })

  await r.step('job.stop', 'A background bash job started by the model keeps its task running: session.get lists it, job.output reads it, job.stop stops it and the task completes', { needs: ['task.complete'], timeoutMs: 180_000, onFailure: failShot('job', 'dsh') }, async () => {
    const nonce = `j${randomBytes(4).toString('hex')}`
    const { body: started } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: `Remora E2E background job ${JOB_MARKER} nonce=${nonce}`, idempotencyKey: randomUUID() })
    const findJob = async () => {
      const { body } = await state.api('session.get', { hostId: state.host.hostId, sessionId: state.target.sessionId })
      return (body.jobs ?? []).find(job => job.label.includes(`remora-e2e-job-${nonce}`))
    }
    let job
    for (const deadline = Date.now() + 60_000; !job; ) {
      job = await findJob()
      if (job) break
      if (Date.now() > deadline) throw new Error('session.get never listed the background job')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (job.status !== 'running') throw new Error(`the job is not running: ${JSON.stringify(job)}`)
    const { body: during } = await state.api('task.wait', { taskId: started.taskId, timeoutMs: 3000 })
    if (TERMINAL.has(during.state)) throw new Error(`the task ended (${during.state}) while its job still runs`)
    let output = ''
    for (const deadline = Date.now() + 15_000; !output.includes(`REMORA-JOB-${nonce}`) && Date.now() < deadline;) {
      ;({ body: { output } } = await state.api('job.output', { hostId: state.host.hostId, jobId: job.jobId }))
      if (!output.includes(`REMORA-JOB-${nonce}`)) await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (!output.includes(`REMORA-JOB-${nonce}`)) throw new Error(`job.output never showed the marker: ${JSON.stringify(output)}`)
    const { body: stopped } = await state.api('job.stop', { hostId: state.host.hostId, jobId: job.jobId })
    if (stopped.stopped !== true) throw new Error(`job.stop: ${JSON.stringify(stopped)}`)
    let after = job
    for (const deadline = Date.now() + 15_000; after?.status === 'running' && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 500))
      after = await findJob()
    }
    if (after?.status === 'running') throw new Error(`the job is still running after job.stop: ${JSON.stringify(after)}`)
    const { body: again } = await state.api('job.stop', { hostId: state.host.hostId, jobId: job.jobId })
    if (again.stopped !== false) throw new Error(`a second job.stop claimed to stop it: ${JSON.stringify(again)}`)
    const task = await waitTask(state.api, started.taskId, value => TERMINAL.has(value) || value === 'needs_attention', 60_000)
    // DSH tells the agent that the job ended, which may add a follow-up turn to the task: its reply carries the nonce too.
    if (task.state !== 'completed' || !task.result?.reply?.includes(nonce)) throw new Error(`after the stop the task ended ${task.state}: ${JSON.stringify(task)}`)
    return `job ${job.jobId} ("${job.label}") listed running while its task ran; output had the marker; job.stop → ${stopped.status}, now ${after?.status ?? 'gone'}; a second stop is a no-op; the task then completed ("${task.result.reply}")`
  })

  await r.step('schedule.create', 'A daily prompt is listed and deleted; a one-shot prompt arrives as a new turn', { needs: ['task.complete'], timeoutMs: 180_000, onFailure: failShot('schedule', 'dsh') }, async () => {
    const hostId = state.host.hostId
    const sessionId = state.target.sessionId
    const dailyParams = { hostId, sessionId, title: 'Remora E2E daily', prompt: 'Remora E2E daily check', when: { daily: { time: '09:00', timeZone: 'Asia/Tokyo' } }, idempotencyKey: randomUUID() }
    const { body: daily } = await state.api('schedule.create', dailyParams)
    const { body: same } = await state.api('schedule.create', dailyParams)
    if (same.schedule.scheduleId !== daily.schedule.scheduleId) throw new Error(`the same idempotencyKey created a second schedule: ${JSON.stringify(same)}`)
    if (daily.schedule.rule !== 'daily 09:00 Asia/Tokyo' || !(daily.schedule.nextAt > Date.now())) throw new Error(`unexpected daily schedule: ${JSON.stringify(daily)}`)
    const nonce = `s${randomBytes(4).toString('hex')}`
    const { body: once } = await state.api('schedule.create', { hostId, sessionId, title: 'Remora E2E once', prompt: `Remora E2E scheduled prompt nonce=${nonce}`, when: { afterSeconds: 2 }, idempotencyKey: randomUUID() })
    const { body: listed } = await state.api('schedules.list', { hostId, sessionId })
    if (!listed.schedules.some(item => item.scheduleId === daily.schedule.scheduleId && item.status === 'active' && item.prompt === 'Remora E2E daily check')) throw new Error(`schedules.list lacks the daily one: ${JSON.stringify(listed)}`)
    for (const deadline = Date.now() + 90_000; ;) {
      const { body } = await state.api('session.read', { hostId, sessionId, depth: 'turns', limit: 5 })
      // DSH frames a scheduled prompt as a reminder (source "schedule"); the mock answers with its nonce.
      if ((body.turns ?? []).some(item => item.reply?.includes(`${REPLY_PREFIX} ${nonce}`))) break
      if (Date.now() > deadline) throw new Error(`the one-shot prompt never ran: ${JSON.stringify(body.turns?.slice(-2))}`)
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    const { body: removed } = await state.api('schedule.delete', { hostId, sessionId, scheduleId: daily.schedule.scheduleId })
    if (removed.deleted !== true) throw new Error(`schedule.delete: ${JSON.stringify(removed)}`)
    const { body: left } = await state.api('schedules.list', { hostId, sessionId })
    if (left.schedules.some(item => item.scheduleId === daily.schedule.scheduleId)) throw new Error('the deleted schedule is still listed')
    const onceNow = left.schedules.find(item => item.scheduleId === once.schedule.scheduleId)
    // One left in place: the kill switch must take it away (kill-switch.enforced checks).
    const { body: kept } = await state.api('schedule.create', { hostId, sessionId, title: 'Remora E2E hourly', prompt: 'Remora E2E hourly', when: { everySeconds: 3600 }, idempotencyKey: randomUUID() })
    if (kept.schedule.createdBy === undefined) throw new Error(`a schedule made through Remora does not say by whom: ${JSON.stringify(kept)}`)
    state.remoteSchedule = kept.schedule.scheduleId
    return `daily listed with its prompt, then deleted; one-shot ${once.schedule.scheduleId} ran as a turn (now ${onceNow ? onceNow.status : 'gone from the list'}); an hourly one left for the kill switch (by ${kept.schedule.createdBy})`
  })

  await r.step('terminal.run', 'Terminal: a "request" token is refused; with full access the owner runs a command and confirms it with the passkey on the hub', { needs: ['task.complete', 'hub.owner'], timeoutMs: 180_000, onFailure: failShot('terminal') }, async () => {
    const hostId = state.host.hostId
    // The personal token ("request", no dsh.admin) is refused before anything is parked.
    const refused = await state.api('terminal.run', { hostId, command: 'echo nope', cwdWorkspaceId: 'x' }, { allow: [403] })
    if (refused.status !== 403 || refused.body?.error?.code !== 'denied') throw new Error(`terminal.run from a "request" token: ${refused.status} ${JSON.stringify(refused.body)}`)
    const page = dshSession.page
    const setCeiling = async level => {
      const { section } = await ensureRemoraTab(page)
      await openRemoraSubTab(section, REMORA.tabs.permissions)
      const control = await mustBePresent(section, level === 'full' ? REMORA.ceilingFull : REMORA.ceilingRequest, `the "${level}" level`)
      if (await control.getAttribute('aria-checked') === 'true') return
      const reply = page.waitForResponse(response => /\/api\/remora\/permission$/.test(response.url()), { timeout: 15_000 })
      await control.click()
      if (level === 'full') await (await mustBePresent(page, REMORA.fullConfirm, 'the "Turn on" button of the full-access dialog')).click()
      const body = await rpcBody(await reply)
      if (!body?.result?.ok) throw new Error(`permission RPC failed: ${JSON.stringify(body)}`)
    }
    await setCeiling('full')
    const dshShot = await shot(page, artifacts, 'flow-dsh-full-access')
    try {
      const hubPage = state.hubPage
      // The hub offers the form once the host reported the raised ceiling.
      let form
      for (const deadline = Date.now() + 30_000; ;) {
        await hubPage.goto(`${state.hub.origin}/hosts/${hostId}`)
        const open = HUB.terminalOpen(hubPage)
        if (await open.count() > 0) {
          await open.first().click()
          form = await firstPresent(hubPage, HUB.terminalForm, 1000)
          if (form) break
        }
        if (Date.now() > deadline) throw new Error('the host page never offered the terminal form')
        await hubPage.waitForTimeout(1000)
      }
      const nonce = `c${randomBytes(4).toString('hex')}`
      await form.locator('textarea[name="command"]').fill(`echo REMORA-TERMINAL-${nonce}; pwd`)
      await Promise.all([hubPage.waitForURL(/\/confirm\/[^/]+\/[^/?]+$/, { timeout: 20_000 }), form.locator('button[type="submit"]').click()])
      const confirmPath = new URL(hubPage.url()).pathname
      const command = await mustBePresent(hubPage, HUB.confirmCommand, 'the command on the confirm page')
      if (!(await command.innerText()).includes(`REMORA-TERMINAL-${nonce}`)) throw new Error(`the confirm page shows "${await command.innerText()}"`)
      await shot(hubPage, artifacts, 'flow-hub-terminal-confirm')
      await (await mustBePresent(hubPage, HUB.confirmRun, 'the "confirm with passkey and run" button')).click()
      const stdout = await mustBePresent(hubPage, HUB.terminalStdout, 'the command output on the confirm page', 60_000)
      const text = await stdout.innerText()
      if (!text.includes(`REMORA-TERMINAL-${nonce}`) || !text.includes(realpathSync(world.root))) throw new Error(`unexpected output (expected a folder under ${world.root}): ${JSON.stringify(text)}`)
      const outputShot = await shot(hubPage, artifacts, 'flow-hub-terminal-output')
      // A second command, refused by the owner, never runs.
      const denied = await state.hubPage.goto(`${state.hub.origin}/hosts/${hostId}`)
      if (!denied?.ok()) throw new Error('the host page did not load again')
      await HUB.terminalOpen(hubPage).first().click()
      const again = await mustBePresent(hubPage, HUB.terminalForm, 'the terminal form again')
      await again.locator('textarea[name="command"]').fill(`echo REMORA-NEVER-${nonce}`)
      await Promise.all([hubPage.waitForURL(/\/confirm\//, { timeout: 20_000 }), again.locator('button[type="submit"]').click()])
      await Promise.all([hubPage.waitForURL(/msg=confirmation-denied/, { timeout: 20_000 }), (await mustBePresent(hubPage, HUB.confirmDeny, 'the deny button')).click()])
      const deniedState = await (await mustBePresent(hubPage, HUB.confirmState, 'the state on the confirm page')).innerText()
      if (!deniedState.includes('拒否')) throw new Error(`after denying, the page says "${deniedState}"`)
      return `token refused (${refused.body.error.denial?.layer}: ${refused.body.error.denial?.reason}); full access on (${dshShot}); ran on ${confirmPath} with the passkey → "${text.trim().split('\n').join(' | ')}" (${outputShot}); a second command denied`
    } finally {
      await setCeiling('request')
    }
  })

  await r.step('maintenance.audit', 'audit.export from a dsh.admin token waits for the owner\'s passkey on the hub; the chains verify outside the hub', { needs: ['task.complete', 'hub.owner'], timeoutMs: 120_000, onFailure: failShot('maintenance-audit') }, async () => {
    const page = state.hubPage
    await page.goto(`${state.hub.origin}${HUB_PATHS.tokens}`)
    const form = await requirePresent(page, HUB.tokenForm, `no personal-token form at ${HUB_PATHS.tokens}`)
    const name = `remora-e2e-admin-${randomBytes(3).toString('hex')}`
    await (await mustBePresent(form, HUB.tokenName, 'the token name field')).fill(name)
    for (const scope of ['dsh.read', 'dsh.admin']) await HUB.tokenScope(scope)(form).check()
    await (await mustBePresent(form, HUB.tokenCreate, 'the issue button')).click()
    const admin = hubApi(state.hub.origin, (await (await mustBePresent(page, HUB.tokenValue, 'the new token value', 20_000)).innerText()).trim())
    const { body: parked } = await admin('audit.export')
    if (parked.state !== 'pending' || !parked.confirmUrl?.startsWith(`${state.hub.origin}/confirm/hub/`)) throw new Error(`audit.export did not wait for the owner: ${JSON.stringify(parked)}`)
    const { body: early } = await admin('confirmation.get', { confirmationId: parked.confirmationId })
    if (early.state !== 'pending' || early.result !== undefined) throw new Error(`before approval: ${JSON.stringify(early)}`)
    await page.goto(parked.confirmUrl)
    await shot(page, artifacts, 'flow-hub-approve-audit')
    await Promise.all([page.waitForURL(/msg=approved/, { timeout: 30_000 }), page.locator('form[action$="/approve"] button[type="submit"]').click()])
    const { body: done } = await admin('confirmation.get', { confirmationId: parked.confirmationId })
    if (done.state !== 'done' || !Array.isArray(done.result?.logs)) throw new Error(`after approval: ${JSON.stringify(done).slice(0, 500)}`)
    const summary = []
    for (const log of done.result.logs) {
      const broken = await verifyAuditRecords(log.records)
      if (broken !== null) throw new Error(`the ${log.log} chain breaks at #${broken}`)
      summary.push(`${log.log === 'hub' ? 'hub' : 'host'} ${log.records.length} rows`)
    }
    if (!done.result.logs.some(log => log.log === state.host.hostId)) throw new Error('the host\'s log is missing from the export')
    return `token "${name}" asked; the owner approved on ${new URL(parked.confirmUrl).pathname} with the passkey; chains verify: ${summary.join(', ')}`
  })

  await r.step('maintenance.rotate-key', 'The owner rotates the host key from the host page: the plugin proves a new key, reconnects with it, and tasks still run', { needs: ['task.complete', 'hub.owner'], timeoutMs: 180_000, onFailure: failShot('rotate-key') }, async () => {
    const hubPage = state.hubPage
    await hubPage.goto(`${state.hub.origin}/hosts/${state.host.hostId}`)
    const summary = hubPage.locator('details.card').filter({ hasText: 'ホスト鍵の更新' }).locator('summary')
    if (await summary.count() === 0) throw new Error('the host page offers no key rotation (does the plugin advertise host.rotate-key?)')
    await summary.first().click()
    await Promise.all([hubPage.waitForURL(/msg=key-rotated/, { timeout: 60_000 }), hubPage.locator(`form[action="/hosts/${state.host.hostId}/rotate-key"] button[type="submit"]`).click()])
    const shotPath = await shot(hubPage, artifacts, 'flow-hub-key-rotated')
    // The DSH tab is connected again, and work goes on over the new key.
    const { section } = await ensureRemoraTab(dshSession.page)
    await openRemoraSubTab(section, REMORA.tabs.connection)
    await mustBePresent(section, REMORA.hubConnected, 'Connected after the key rotation', 60_000)
    const nonce = `r${randomBytes(4).toString('hex')}`
    const { body: started } = await state.api('task.start', { hostId: state.host.hostId, target: state.target, prompt: `Remora E2E after key rotation nonce=${nonce}`, idempotencyKey: randomUUID() })
    const task = await waitTask(state.api, started.taskId, value => TERMINAL.has(value) || value === 'needs_attention')
    if (task.state !== 'completed' || !task.result?.reply?.includes(`${REPLY_PREFIX} ${nonce}`)) throw new Error(`after the rotation: ${JSON.stringify(task)}`)
    // The old key is gone from wherever the plugin keeps keys (DSH's credential store, or its data folder).
    const keyFile = findFile(world.root, 'host-key-previous.json')
    if (keyFile) throw new Error(`the previous key is still on disk: ${keyFile}`)
    let store = ''
    try { store = readFileSync(join(world.dshHome, '.credentials.yaml'), 'utf8') } catch { /* no credential store file */ }
    if (store.includes('dsh-remora/host-key-previous')) throw new Error('the previous key is still in the DSH credential store')
    if (store !== '' && !store.includes('dsh-remora/host-key')) throw new Error('the DSH credential store holds no host key')
    return `rotated from the host page (${shotPath}); the DSH tab reconnected; a task completed over the new key ("${task.result.reply}")`
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
    let schedules = ''
    if (state.remoteSchedule) {
      const { body } = await state.api('schedules.list', { hostId: state.host.hostId })
      if (body.schedules.some(item => item.scheduleId === state.remoteSchedule)) throw new Error('the schedule made through Remora survived the kill switch')
      schedules = '; the schedule made through Remora is gone'
    }
    return `refused: ${refused}; after resume a task completed again${schedules}`
  })

  return state
}

export async function stopFlow(state) {
  await state?.authenticator?.detach()
  await state?.hubContext?.close().catch(() => {})
  await state?.hub?.proc?.stop()
}

