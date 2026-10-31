/**
 * The owner's pages: setup, sign-in, inbox, hosts, sessions, tasks,
 * attention, connections, audit log and settings. Server-rendered in the
 * reader's language (see ../i18n); scripts in /js only enhance the forms.
 */
import { answerPath, answerRoute, pushText } from '../attention.ts'
import type { AuditRow } from '../audit.ts'
import { verifyAuditChain } from '../audit.ts'
import { getSession, rpIdOf, type OwnerSession } from '../auth.ts'
import { FREE_TIER, FREE_TIER_WARN, OWNER_CLIENT_ID, RELEASES_URL, dcrEnabled, hubOrigin, secrets } from '../config.ts'
import type { HostLive, PendingConfirmation } from '../host-do.ts'
import { html, json, readForm, readJson, redirect, sameOrigin } from '../http.ts'
import { hasMessage, isLocale, langCookie, type MessageKey } from '../i18n/index.ts'
import { hostStub, hubStub } from '../meter.ts'
import { oauthEnv, oauthFor, resourcesFor } from '../oauth.ts'
import { confirmations, finalParams, liveHosts, maintenanceResult, ownerGrantFor, refreshParked, revokeHostEverywhere, runOperation, type Caller } from '../ops.ts'
import { PUSH_TYPES, type ClientWithGrants, type GrantLevel, type PushType } from '../types.ts'
import { isPushEndpoint, isSubscriptionKey } from '../webpush.ts'
import { safeNext } from '../next.ts'
import { randomToken } from '../util.ts'
import { HUB_VERSION } from '../version.ts'
import {
  CLI_CLIENT_ID, LEVEL_RANK, OWNER_APPROVED_OPERATIONS, PROTOCOL_VERSION, RELEASE_ASSETS, SCOPES,
  type AttentionItem, type Confirmation, type ConfirmationInfo, type HostSummary, type RemoraError, type ScheduleInfo, type SearchHit, type SessionForkResult,
  type HostRotateKeyResult, type SessionGetResult, type SessionSummary, type TaskInfo, type TerminalRunOutput, type WorkspaceSummary,
} from '../vendor/protocol/index.ts'
import { approvalSignedPayloads } from './approval-preview.ts'
import { whenFromForm } from './schedule-form.ts'
import { copyField, flash, h, page, pageHead, raw, reauthForm, uiFor, visibleText, type NavKey, type Raw, type Ui } from './layout.ts'

/** The hub's own pages acting as a client of the hosts. The name shows in DSH's audit log. */
const OWNER: Caller = { clientId: OWNER_CLIENT_ID, clientName: 'Remora hub', scopes: [...SCOPES], kind: 'owner' }


/** Flash messages, by the `msg` query parameter. */
const MESSAGES: Readonly<Record<string, ['ok' | 'error' | 'warn']>> = {
  'passkey-added': ['ok'],
  'passkey-removed': ['warn'],
  'passkey-last': ['error'],
  'passkey-missing': ['error'],
  'token-revoked': ['ok'],
  'client-revoked': ['ok'],
  'grant-saved': ['ok'],
  'grant-above-ceiling': ['error'],
  'grant-ceiling-unknown': ['error'],
  'host-revoked': ['ok'],
  reauth: ['error'],
  'settings-saved': ['ok'],
  sent: ['ok'],
  'answer-empty': ['error'],
  'push-removed': ['ok'],
  'push-saved': ['ok'],
  'push-on': ['ok'],
  'push-test-sent': ['ok'],
  'push-test-none': ['error'],
  'confirmation-denied': ['ok'],
  'confirmation-gone': ['error'],
  forked: ['ok'],
  'job-stopped': ['ok'],
  'job-not-running': ['ok'],
  'schedule-created': ['ok'],
  'schedule-deleted': ['ok'],
  'schedule-gone': ['ok'],
  approved: ['ok'],
  'key-rotated': ['ok'],
}

function message(ui: Ui, url: URL): Raw {
  const key = url.searchParams.get('msg')
  const entry = key ? MESSAGES[key] : undefined
  const id = `msg.${key}`
  return entry && hasMessage(id) ? flash(ui.t(id), entry[0]) : raw('')
}

function label(ui: Ui, prefix: string, value: string): string {
  const key = `${prefix}.${value}`
  return hasMessage(key) ? ui.t(key) : value
}

const levelLabel = (ui: Ui, level: string) => label(ui, 'level', level)
const stateLabel = (ui: Ui, state: string) => label(ui, 'state', state)
const kindLabel = (ui: Ui, kind: string) => label(ui, 'kind', kind)
const opLabel = (ui: Ui, operation: string) => label(ui, 'op', operation)

/** Where to fix a denial, as words or a link on this hub. */
function fixHint(ui: Ui, fix: string | undefined): Raw {
  if (!fix) return raw('')
  if (fix.startsWith('hub:')) {
    // Host errors are wire input; a hub hint may only link inside this hub.
    const target = safeNext(fix.slice(4), 'https://remora.invalid')
    return h`<p class="detail">${ui.i18n.rich('error.fixHub', { link: h`<a href="${target}">${ui.t('error.fixHubLink')}</a>` })}</p>`
  }
  if (fix.startsWith('dsh:')) return h`<p class="detail">${ui.t(fix.includes('kill-switch') ? 'error.fixDshKillSwitch' : 'error.fixDsh')}</p>`
  return raw('')
}

/** A host or hub error in words: a known denial reason or code first, the original text underneath. */
function errorFlash(ui: Ui, error: RemoraError | undefined, title?: string): Raw {
  if (!error) return raw('')
  const reason = error.denial?.reason
  const summary = reason && hasMessage(`reason.${reason}`) ? ui.t(`reason.${reason}` as MessageKey) : label(ui, 'error.code', error.code)
  return h`<div class="notice error" role="alert"><strong>${title ?? ui.t('error.failed')}</strong> ${summary}
${fixHint(ui, error.fix)}
<p class="detail mono">${error.code}: ${error.message}</p></div>`
}

function view(ui: Ui, title: string, nav: NavKey, body: Raw, scripts: string[] = ['/js/webauthn.js', '/js/live.js'], extra: { refreshSeconds?: number; status?: number } = {}): Response {
  return html(page({ i18n: ui.i18n, title, nav, body, scripts, path: ui.path, ...(extra.refreshSeconds ? { refreshSeconds: extra.refreshSeconds } : {}) }), extra.status ? { status: extra.status } : {})
}

function narrowPage(ui: Ui, title: string, body: Raw, status?: number): Response {
  return html(page({ i18n: ui.i18n, title, narrow: true, body, scripts: ['/js/webauthn.js'], path: ui.path }), status ? { status } : {})
}

const pct = (ratio: number) => `${Math.min(100, Math.round(ratio * 100))}%`

const pluginUrl = () => `${RELEASES_URL}/download/v${HUB_VERSION}/${RELEASE_ASSETS.plugin(HUB_VERSION)}`

// --- setup and sign-in -------------------------------------------------------------------------

function setupPage(ui: Ui, env: Env): Response {
  const { t } = ui
  const configured = (secrets(env).SETUP_TOKEN ?? '').length >= 16
  return narrowPage(ui, t('setup.title'), h`<div class="page-head"><h1 data-after-title="${t('setup.doneTitle')}">${t('setup.title')}</h1><p class="subtitle" data-before-setup>${t('setup.lead')}</p></div>
${configured ? '' : flash(t('setup.tokenMissing'), 'error')}
<div class="notice error" data-needs-webauthn hidden>${t('auth.noWebauthn')}</div>
<form class="stack" data-setup>
  <label class="field"><span class="label">${t('setup.token')}</span><input name="setupToken" type="password" autocomplete="off" required data-testid="hub-setup-token"${raw(configured ? '' : ' disabled')}><span class="hint">${t('setup.tokenHint')}</span></label>
  <label class="field"><span class="label">${t('setup.passkeyName')}</span><input name="label" maxlength="60" placeholder="${t('setup.passkeyNamePlaceholder')}" data-testid="hub-setup-label" data-device-label></label>
  <button class="primary large wide-btn" type="submit" data-testid="hub-register-passkey" data-busy-label="${t('setup.busy')}"${raw(configured ? '' : ' disabled')}>${t('setup.submit')}</button>
  <div data-status role="status" hidden></div>
</form>
<section data-after-setup hidden>
  <h2>${t('setup.recovery.title')}</h2>
  <p class="muted">${t('setup.recovery.lead')}</p>
  <pre class="codes" id="recovery" data-recovery-codes data-testid="hub-recovery-codes"></pre>
  <div class="actions"><button type="button" data-copy="#recovery">${t('common.copy')}</button><button type="button" data-download="#recovery" data-filename="remora-recovery-codes.txt">${t('setup.recovery.download')}</button></div>
  <p class="muted">${t('setup.recovery.next')}</p>
  <div class="actions"><a class="btn primary" href="/" data-testid="hub-recovery-ack">${t('setup.recovery.continue')}</a></div>
</section>`)
}

function loginPage(ui: Ui, url: URL): Response {
  const { t } = ui
  const error = url.searchParams.get('error')
  return narrowPage(ui, t('login.title'), h`${pageHead(t('login.title'), { subtitle: t('login.lead') })}
<div class="notice error" data-needs-webauthn hidden>${t('auth.noWebauthn')}</div>
${error === 'recovery' ? flash(t('login.recoveryWrong'), 'error') : ''}
${error === 'rate' ? flash(t('login.rate'), 'error') : ''}
<section class="stack">
  <button class="primary large wide-btn" type="button" data-login data-next="${safeNext(url.searchParams.get('next'), url.origin)}" data-busy-label="${t('login.busy')}">${t('login.submit')}</button>
  <div data-status role="status" hidden></div>
</section>
<details class="plain recovery" ${raw(error === 'recovery' ? 'open' : '')}>
  <summary>${t('login.recovery.summary')}</summary>
  <form method="post" action="/auth/recovery" class="stack">
    <p class="muted">${t('login.recovery.hint')}</p>
    <label class="field"><span class="label">${t('login.recovery.code')}</span><input name="code" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="xxxx-xxxx-xxxx" required></label>
    <button type="submit">${t('login.recovery.submit')}</button>
  </form>
</details>`)
}

// --- home -------------------------------------------------------------------------------------

interface Overview {
  hosts: { summary: HostSummary; live: HostLive }[]
  clients: ClientWithGrants[]
  /** Hub maintenance waiting for the owner, as inbox rows. */
  approvals: PendingConfirmation[]
}

async function overview(env: Env): Promise<Overview> {
  const hub = hubStub(env)
  const hosts = (await hub.listHosts()).map(host => ({ hostId: host.hostId, name: host.name }))
  const context = { ok: true, hosts, grants: Object.fromEntries(hosts.map(host => [host.hostId, { level: 'full' as const }])) }
  const [live, clients, approvals] = await Promise.all([liveHosts(env, context), hub.listClients(), hub.pendingApprovals()])
  return { hosts: live, clients, approvals: approvals.map(row => ({ confirmationId: row.id, operation: row.operation, clientName: row.clientName, what: row.operation, createdAt: row.createdAt, expiresAt: row.expiresAt })) }
}

function fullAccessOn(summary: HostSummary, clients: ClientWithGrants[], now = Date.now()): boolean {
  const ceiling = summary.ceiling
  const dshFull = ceiling?.level === 'full' && (ceiling.fullAccessExpiresAt === undefined || ceiling.fullAccessExpiresAt > now)
  const hubFull = clients.some(client => !client.revokedAt && client.grants.some(grant => grant.hostId === summary.hostId && grant.level === 'full' && (grant.fullAccessExpiresAt ?? 0) > now))
  return dshFull || hubFull
}

function hostStatus(ui: Ui, online: boolean, lastSeenAt: number | null): string {
  if (online) return ui.t('host.online')
  return lastSeenAt ? ui.t('host.offlineSince', { when: ui.i18n.relative(lastSeenAt) }) : ui.t('host.neverConnected')
}

function hostRow(ui: Ui, entry: { summary: HostSummary; live: HostLive }, clients: ClientWithGrants[]): Raw {
  const { t } = ui
  const { summary, live } = entry
  const meta = [
    hostStatus(ui, summary.online, summary.lastSeenAt),
    summary.ceiling ? t('host.limit', { level: levelLabel(ui, summary.ceiling.level) }) : t('host.limitUnknown'),
    live.running.length > 0 ? t('host.runningCount', { count: live.running.length }) : null,
    live.attention.length > 0 ? t('host.attentionCount', { count: live.attention.length }) : null,
  ].filter(Boolean).join(' · ')
  return h`<a class="item" href="/hosts/${summary.hostId}">
  <span class="dot ${summary.online ? 'on' : ''}" aria-hidden="true"></span>
  <div class="item-body">
    <div class="item-title">${summary.name}${live.reportedName && live.reportedName !== summary.name ? h` <span class="faint">(${t('host.reportedName', { name: live.reportedName })})</span>` : ''}
    ${fullAccessOn(summary, clients) ? h`<span class="tag danger">${t('level.full')}</span>` : ''}${summary.killSwitch ? h`<span class="tag danger">${t('host.killSwitch')}</span>` : ''}</div>
    <div class="item-meta">${meta}</div>
    ${live.duplicateConnections > 0 ? h`<div class="item-meta state failed">${t('host.duplicate', { count: live.duplicateConnections })}</div>` : ''}
  </div>
  <span class="chev" aria-hidden="true">›</span>
</a>`
}

function taskRow(ui: Ui, task: TaskInfo, hostName: string): Raw {
  return h`<a class="item" href="/tasks/${task.taskId}"><div class="item-body"><div class="item-title"><span class="state ${task.state}">${stateLabel(ui, task.state)}</span> <span>${hostName}</span></div>
<div class="item-meta">${ui.i18n.relative(task.updatedAt)}</div></div><span class="chev" aria-hidden="true">›</span></a>`
}

function countdown(ui: Ui, expiresAt: number | null | undefined): Raw {
  if (typeof expiresAt !== 'number') return raw('')
  return h`<span class="countdown${expiresAt <= Date.now() ? ' expired' : ''}" data-expires-at="${expiresAt}" data-testid="hub-countdown">${ui.i18n.countdown(expiresAt)}</span>`
}

/** Approvals first, then whatever expires soonest, then the oldest. */
function byUrgency(a: AttentionItem, b: AttentionItem): number {
  const rank = (item: AttentionItem) => (item.kind === 'approval' ? 0 : item.kind === 'question' || item.kind === 'plan-review' ? 1 : 2)
  return rank(a) - rank(b) || (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER) || (a.createdAt ?? 0) - (b.createdAt ?? 0)
}

const join = (parts: (Raw | string | null | false)[]): Raw => h`${parts.filter(Boolean).map((part, index) => h`${index > 0 ? ' · ' : ''}${part as Raw | string}`)}`

/** One line in an inbox (home, host, task pages): what it is, where, how long is left, and a way in. */
function attentionRow(ui: Ui, item: AttentionItem, hostName: string): Raw {
  const { t } = ui
  const route = answerRoute(item)
  const action = route === 'passkey' ? t('attention.actionPasskey') : route === 'remote' ? t('attention.actionAnswer') : t('attention.actionOpen')
  return h`<div class="item kind-${item.kind}${route === 'expired' ? ' expired' : ''}"${raw(typeof item.expiresAt === 'number' ? ' data-expiring' : '')} data-testid="hub-inbox-item">
  <div class="item-body">
    <div class="item-title"><span class="tag ${item.kind === 'approval' ? 'danger' : 'warn'}">${kindLabel(ui, item.kind)}</span> <a class="untrusted" href="${answerPath(item.hostId, item.attentionId)}">${item.title}</a></div>
    <div class="item-meta">${join([hostName, typeof item.expiresAt === 'number' ? countdown(ui, item.expiresAt) : null, ui.i18n.relative(item.createdAt)])}</div>
  </div>
  ${route === 'expired' ? '' : h`<div class="item-actions"><a class="btn small${route === 'dsh-web' ? '' : ' primary'}" href="${answerPath(item.hostId, item.attentionId)}">${action}</a></div>`}
</div>`
}

const confirmPath = (hostId: string, confirmationId: string) => `/confirm/${hostId}/${confirmationId}`

/** One request a client parked for the owner's passkey. */
function confirmationRow(ui: Ui, item: PendingConfirmation, hostId: string, hostName: string): Raw {
  const { t } = ui
  return h`<div class="item kind-confirmation" data-expiring data-testid="hub-confirmation-item">
  <div class="item-body">
    <div class="item-title"><span class="tag danger">${t('kind.confirmation')}</span> <a href="${confirmPath(hostId, item.confirmationId)}">${opLabel(ui, item.operation)}</a></div>
    <div class="item-meta"><code class="untrusted">${visibleText(item.what).text}</code></div>
    <div class="item-meta">${join([t('confirm.from', { client: visibleText(item.clientName).text }), hostName, countdown(ui, item.expiresAt), ui.i18n.relative(item.createdAt)])}</div>
  </div>
  <div class="item-actions"><a class="btn small primary" href="${confirmPath(hostId, item.confirmationId)}">${t('confirm.review')}</a></div>
</div>`
}

function confirmationList(ui: Ui, entries: { item: PendingConfirmation; hostId: string; name: string }[]): Raw {
  return h`${entries.map(entry => confirmationRow(ui, entry.item, entry.hostId, entry.name))}`
}

function inboxRows(ui: Ui, items: AttentionItem[], names: Map<string, string>): Raw {
  return h`${[...items].sort(byUrgency).map(item => attentionRow(ui, item, names.get(item.hostId) ?? item.hostId))}`
}

/** Whether any online host lets clients reach at least one workspace; null when no host can tell. */
async function anyReachableWorkspace(env: Env, hosts: Overview['hosts']): Promise<boolean | null> {
  let known = false
  for (const { summary } of hosts) {
    if (!summary.online) continue
    const listed = await runOperation(env, OWNER, 'workspaces.list', { hostId: summary.hostId })
    if (!listed.ok) continue
    known = true
    if (((listed.result as { workspaces?: WorkspaceSummary[] }).workspaces ?? []).length > 0) return true
  }
  return known ? false : null
}

interface Step { done: boolean; title: string; body: Raw }

/** How to get a DSH host to show a pairing code: install the plugin, paste this hub's address, start pairing. */
export function pairSteps(ui: Ui, origin: string, withCodeLink: boolean): Raw {
  const { t, i18n } = ui
  return h`<ol>
  <li><p>${i18n.rich('start.pair.install', { where: h`<strong>${t('start.pair.installWhere')}</strong>` })}</p>${copyField(i18n, 'plugin-url', pluginUrl())}</li>
  <li><p>${i18n.rich('start.pair.connect', { where: h`<strong>${t('start.pair.connectWhere')}</strong>` })}</p>${copyField(i18n, 'hub-url', origin)}</li>
  <li><p>${withCodeLink ? i18n.rich('start.pair.approve', { link: h`<a href="/pair">${t('start.pair.approveLink')}</a>` }) : t('start.pair.approveHere')}</p></li>
</ol>`
}

function getStarted(ui: Ui, steps: Step[], extras: Raw[]): Raw {
  const { t } = ui
  const current = steps.findIndex(step => !step.done)
  return h`<section class="block" data-testid="hub-get-started"><div class="block-head"><h2>${t('start.title')}</h2><span class="count">${t('start.progress', { done: steps.filter(step => step.done).length, total: steps.length })}</span></div>
<ol class="box steps">${steps.map((step, index) => h`<li class="step ${step.done ? 'done' : index === current ? 'current' : 'todo'}"${raw(index === current ? ' aria-current="step"' : '')}>
  <span class="step-mark" aria-hidden="true"></span>
  <div class="step-body"><div class="step-title">${step.title}${step.done ? h`<span class="sr-only"> (${t('start.done')})</span>` : ''}</div>${index === current ? step.body : ''}</div>
</li>`)}</ol>
${extras.length > 0 ? h`<div class="extra">${extras}</div>` : ''}</section>`
}

async function homePage(ui: Ui, env: Env, url: URL, origin: string): Promise<Response> {
  const { t, i18n } = ui
  const hub = hubStub(env)
  const [state, data, meter] = await Promise.all([hub.state(), overview(env), hub.meterToday()])
  const names = new Map(data.hosts.map(entry => [entry.summary.hostId, entry.summary.name]))
  const attention = data.hosts.flatMap(entry => entry.live.attention)
  const pending = [
    ...data.approvals.map(item => ({ item, hostId: 'hub', name: t('common.hub') })),
    ...data.hosts.flatMap(entry => entry.live.confirmations.map(item => ({ item, hostId: entry.summary.hostId, name: entry.summary.name }))),
  ]
  const waiting = attention.length + pending.length
  const running = data.hosts.flatMap(entry => entry.live.running)
  const recent = data.hosts.flatMap(entry => entry.live.recent).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)

  const paired = data.hosts.length > 0
  const connected = data.clients.some(client => !client.revokedAt)
  const tasked = data.hosts.some(entry => entry.live.hadTasks)
  const showStart = !(paired && connected && tasked)
  const reachable = showStart && paired && !tasked ? await anyReachableWorkspace(env, data.hosts) : paired
  const steps: Step[] = [
    {
      done: paired,
      title: t('start.pair.title'),
      body: pairSteps(ui, origin, true),
    },
    {
      done: reachable === true,
      title: t('start.scope.title'),
      body: h`<p class="muted">${t('start.scope.lead')}</p><ol>
  <li>${i18n.rich('start.scope.permissions', { where: h`<strong>${t('start.scope.permissionsWhere')}</strong>` })}</li>
  <li>${i18n.rich('start.scope.scope', { where: h`<strong>${t('start.scope.scopeWhere')}</strong>` })}</li>
</ol>${reachable === null ? h`<p class="muted small">${t('start.scope.offline')}</p>` : ''}`,
    },
    {
      done: connected,
      title: t('start.client.title'),
      body: h`<p class="muted">${t('start.client.lead')}</p><div class="actions"><a class="btn" href="/connections#setup">${t('start.client.action')}</a></div>`,
    },
    {
      done: tasked,
      title: t('start.task.title'),
      body: h`<p class="muted">${t('start.task.lead')}</p><blockquote class="quote">${t('start.task.example')}</blockquote>`,
    },
  ]
  const extras: Raw[] = []
  if (state.passkeys < 2) extras.push(h`<a href="/settings#passkeys">${t('start.extra.passkey', { count: state.passkeys })}</a>`)
  if (state.pushDevices === 0) extras.push(h`<a href="/settings#notifications">${t('start.extra.push')}</a>`)

  const meters: [string, number, number][] = [
    [t('usage.worker'), meter.workerRequests, FREE_TIER.workerRequests],
    [t('usage.durable'), meter.durableObjectRequests, FREE_TIER.durableObjectRequests],
    [t('usage.kv'), meter.kvWrites, FREE_TIER.kvWrites],
  ]
  const high = meters.some(([, used, limit]) => used / limit >= FREE_TIER_WARN)
  const body = h`${message(ui, url)}
<h1 class="sr-only">${t('nav.home')}</h1><span data-refresh-on-show hidden></span>
${showStart ? getStarted(ui, steps, extras) : ''}
<section class="block" data-testid="hub-home-attention"><div class="block-head"><h2>${t('home.attention')} <span class="count">${waiting}</span></h2>${waiting > 0 ? h`<a class="small" href="/attention">${t('home.attentionAll')}</a>` : ''}</div>
${waiting === 0 ? h`<p class="empty">${t('home.attentionEmpty')}</p>` : h`<div class="box">${confirmationList(ui, pending)}${inboxRows(ui, attention, names)}</div>`}</section>
<section class="block"><div class="block-head"><h2>${t('home.running')} <span class="count">${running.length}</span></h2></div>
${running.length === 0 ? h`<p class="empty">${t('home.runningEmpty')}</p>` : h`<div class="box">${running.map(task => taskRow(ui, task, names.get(task.hostId) ?? task.hostId))}</div>`}</section>
${recent.length > 0 ? h`<section class="block"><div class="block-head"><h2>${t('home.recent')}</h2></div><div class="box">${recent.map(task => taskRow(ui, task, names.get(task.hostId) ?? task.hostId))}</div></section>` : ''}
<section class="block"><div class="block-head"><h2>${t('home.hosts')}</h2><a class="btn small" href="/pair">${t('home.addHost')}</a></div>
${data.hosts.length === 0 ? h`<p class="empty">${t('home.hostsEmpty')}</p>` : h`<div class="box">${data.hosts.map(entry => hostRow(ui, entry, data.clients))}</div>`}</section>
<section class="block" data-testid="hub-usage"><div class="block-head"><h2>${t('usage.title')}</h2></div>
${high ? flash(t('usage.high'), 'warn') : ''}
<div class="box box-pad"><div class="meters">${meters.map(([name, used, limit]) => h`<div class="meter ${used / limit >= FREE_TIER_WARN ? 'warn' : ''}"><span>${name}</span><span class="muted">${i18n.number(used)} / ${i18n.number(limit)}</span><progress max="${limit}" value="${Math.min(used, limit)}">${pct(used / limit)}</progress></div>`)}</div>
<details class="plain"><summary>${t('usage.aboutSummary')}</summary><p class="muted small">${t('usage.about')}</p><p class="muted small">${t('usage.plans')}</p></details></div></section>`
  return view(ui, t('nav.home'), 'home', body, ['/js/webauthn.js', '/js/live.js'])
}

// --- hosts and sessions -------------------------------------------------------------------------

async function hostPage(ui: Ui, env: Env, url: URL, hostId: string): Promise<Response> {
  const { t, i18n } = ui
  const host = await hubStub(env).getHost(hostId)
  if (!host || host.revokedAt) return notFound(ui)
  const live = await hostStub(env, hostId).summary()
  const name = host.name
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
  const justPaired = url.searchParams.get('paired') === '1'
  let content: Raw
  let tools: Raw = raw('')
  let reachable: WorkspaceSummary[] = []
  let refreshSeconds: number | undefined
  if (!live.online) {
    if (justPaired && !live.lastSeenAt) {
      content = h`<div class="notice" role="status" data-testid="hub-host-waiting">${t('host.waiting')}</div>`
      refreshSeconds = 3
    } else {
      content = h`<p class="empty">${t('host.offlineHelp')}</p>`
    }
  } else {
    const [workspaces, sessions] = await Promise.all([
      runOperation(env, OWNER, 'workspaces.list', { hostId }),
      runOperation(env, OWNER, 'sessions.list', { hostId, limit: 200 }),
    ])
    if (!workspaces.ok || !sessions.ok) {
      content = h`${errorFlash(ui, !workspaces.ok ? workspaces.error : undefined, t('host.workspacesFailed'))}${errorFlash(ui, !sessions.ok ? sessions.error : undefined, t('host.sessionsFailed'))}`
    } else {
      const list = (workspaces.result as { workspaces?: WorkspaceSummary[] }).workspaces ?? []
      reachable = list
      const all = (sessions.result as { sessions?: SessionSummary[] }).sessions ?? []
      const children = (parent: string) => all.filter(session => session.parentSessionId === parent)
      const sessionItem = (session: SessionSummary): Raw => h`<li><a href="/hosts/${hostId}/sessions/${encodeURIComponent(session.sessionId)}"><span class="untrusted">${session.title || t('session.untitled')}</span></a>
        ${session.pinned ? h` <span class="tag">${t('session.pinned')}</span>` : ''}${session.running ? h` <span class="tag ok">${t('session.running')}</span>` : ''} <span class="faint small">${i18n.relative(session.updatedAt)}</span>
        ${children(session.sessionId).length > 0 ? h`<ul class="sub">${children(session.sessionId).map(sessionItem)}</ul>` : ''}</li>`
      const top = (workspaceId: string | null) => all.filter(session => session.workspaceId === workspaceId && !session.parentSessionId)
      const group = (title: Raw, meta: Raw | string, items: SessionSummary[]) => h`<div class="box"><div class="item top"><div class="item-body"><div class="item-title">${title}</div>${meta ? h`<div class="item-meta mono small">${meta}</div>` : ''}</div></div>
        <div class="box-pad">${items.length === 0 ? h`<p class="muted">${t('host.noSessions')}</p>` : h`<ul class="plain-list">${items.map(sessionItem)}</ul>`}</div></div>`
      content = list.length === 0 && top(null).length === 0
        ? h`<div class="notice warn" data-testid="hub-host-nothing-reachable"><strong>${t('host.nothingReachable')}</strong><p>${t('host.nothingReachableHelp')}</p></div>`
        : h`<div class="stack">${list.map(workspace => group(h`<span class="untrusted">${workspace.name}</span>${workspace.untrusted ? h` <span class="tag warn">${t('host.untrusted')}</span>` : ''}${workspace.state && workspace.state !== 'ready' ? h` <span class="tag">${label(ui, 'workspace.state', workspace.state)}</span>` : ''}`, workspace.path ?? '', top(workspace.workspaceId)))}
        ${top(null).length > 0 ? group(h`${t('host.outside')}`, '', top(null)) : ''}</div>`
      tools = await searchSection(ui, env, hostId, live, query)
    }
  }
  const status = [
    hostStatus(ui, live.online, live.lastSeenAt),
    live.pluginVersion ? t('host.plugin', { version: live.pluginVersion }) : null,
    live.dshVersion ? t('host.dsh', { version: live.dshVersion }) : null,
    live.ceiling ? t('host.limit', { level: levelLabel(ui, live.ceiling.level) }) : t('host.limitUnknown'),
  ].filter(Boolean).join(' · ')
  const attentionCount = live.attention.length + live.confirmations.length
  const body = h`${message(ui, url)}
${justPaired && live.online ? flash(t('host.paired'), 'ok') : ''}
${pageHead(h`<span class="dot ${live.online ? 'on' : ''}" aria-hidden="true"></span> ${name}${live.reportedName && live.reportedName !== name ? h` <span class="faint">(${t('host.reportedName', { name: live.reportedName })})</span>` : ''}${live.killSwitch ? h` <span class="tag danger">${t('host.killSwitch')}</span>` : ''}`, { subtitle: status, crumbs: h`<a href="/">${t('nav.home')}</a> / ${t('host.crumb')}` })}
${attentionCount > 0 ? h`<section class="block" data-testid="hub-host-attention"><div class="block-head"><h2>${t('home.attention')} <span class="count">${attentionCount}</span></h2></div>
<div class="box">${confirmationList(ui, live.confirmations.map(item => ({ item, hostId, name: '' })))}${inboxRows(ui, live.attention, new Map([[hostId, '']]))}</div></section>` : ''}
${tools}
<section class="block"><div class="block-head"><h2>${t('host.workspaces')}</h2></div>${content}</section>
<section class="block"><div class="block-head"><h2>${t('host.manage')}</h2></div><div class="box">
${live.online ? terminalSection(ui, hostId, live, reachable) : ''}
<details class="disclosure"><summary>${t('host.operations', { count: live.operations.length })}</summary><div class="disclosure-body"><p class="mono small">${live.operations.join(', ') || '—'}</p></div></details>
${live.online && live.operations.includes('host.rotate-key') ? h`<details class="disclosure" data-testid="hub-rotate-key"><summary>${t('host.rotate')}</summary><div class="disclosure-body">
<p class="muted">${t('explain.host.rotate-key')} ${t('host.rotateLeak')}</p>
${reauthForm(`/hosts/${hostId}/rotate-key`, {}, t('host.rotateSubmit'), '')}</div></details>` : ''}
<details class="disclosure danger-zone"><summary>${t('host.unpair')}</summary><div class="disclosure-body">
<p class="muted">${t('host.unpairHelp')}</p>
${reauthForm(`/hosts/${hostId}/revoke`, {}, t('host.unpairSubmit'), 'danger')}</div></details>
</div></section>`
  return view(ui, name, 'home', body, ['/js/webauthn.js', '/js/live.js'], refreshSeconds ? { refreshSeconds } : {})
}

/** Find words in the sessions of one host (GET ?q=). */
async function searchSection(ui: Ui, env: Env, hostId: string, live: HostLive, query: string): Promise<Raw> {
  const { t, i18n } = ui
  if (!live.operations.includes('sessions.search')) return raw('')
  const form = h`<form method="get" action="/hosts/${hostId}" class="row" role="search">
  <input name="q" value="${query}" maxlength="200" placeholder="${t('search.placeholder')}" aria-label="${t('search.label')}">
  <button type="submit">${t('search.submit')}</button>
</form>`
  if (query === '') return h`<section class="block">${form}</section>`
  const outcome = await runOperation(env, OWNER, 'sessions.search', { hostId, query, limit: 30 })
  if (!outcome.ok) return h`<section class="block">${form}${errorFlash(ui, outcome.error, t('search.failed'))}</section>`
  const result = outcome.result as { hits: SearchHit[]; scanned: number; partial: boolean }
  const hit = (item: SearchHit) => h`<a class="item top" href="/hosts/${hostId}/sessions/${encodeURIComponent(item.sessionId)}"><div class="item-body">
  <div class="item-title"><span class="untrusted">${item.title}</span> <span class="tag">${label(ui, 'search.role', item.role)}${item.turn ? ` · ${t('search.turn', { turn: item.turn })}` : ''}</span></div>
  <div class="item-meta untrusted">${item.snippet}</div><div class="item-meta faint">${i18n.relative(item.at)}</div></div></a>`
  return h`<section class="block" data-testid="hub-search">${form}
<div class="block-head mt"><h2>${t('search.results')} <span class="count">${result.hits.length}</span></h2></div>
${result.hits.length === 0 ? h`<p class="empty">${t('search.none')}</p>` : h`<div class="box">${result.hits.map(hit)}</div>`}
<p class="muted small">${t('search.scanned', { count: result.scanned })}${result.partial ? ` ${t('search.partial')}` : ''}</p></section>`
}

/** Run one shell command in a workspace folder; the hub then asks for a passkey. */
function terminalSection(ui: Ui, hostId: string, live: HostLive, workspaces: WorkspaceSummary[]): Raw {
  const { t } = ui
  if (!live.operations.includes('terminal.run')) return raw('')
  const body = live.ceiling?.level !== 'full'
    ? h`<p class="muted">${t('terminal.needsFull')}</p>`
    : workspaces.length === 0
      ? h`<p class="muted">${t('terminal.noWorkspaces')}</p>`
      : h`<form method="post" action="/hosts/${hostId}/terminal" class="stack">
  <label class="field"><span class="label">${t('terminal.workspace')}</span><select name="cwdWorkspaceId" required>${workspaces.map(workspace => h`<option value="${workspace.workspaceId}">${workspace.name}${workspace.untrusted ? ` (${t('host.untrusted')})` : ''}</option>`)}</select></label>
  <label class="field"><span class="label">${t('terminal.command')}</span><textarea name="command" rows="2" maxlength="8000" required placeholder="git status" class="mono"></textarea></label>
  <label class="field"><span class="label">${t('terminal.timeout')}</span><input name="timeoutSeconds" type="number" min="1" max="600" value="60"></label>
  <div><button type="submit" class="danger">${t('terminal.next')}</button></div>
  <p class="muted small">${t('terminal.help')}</p>
</form>`
  return h`<details class="disclosure" data-testid="hub-terminal"><summary>${t('terminal.title')}</summary><div class="disclosure-body">${body}</div></details>`
}

interface SessionDraft { action: string; form: URLSearchParams; error: Raw }

async function sessionPage(ui: Ui, env: Env, url: URL, hostId: string, sessionId: string, draft?: SessionDraft): Promise<Response> {
  const { t, i18n } = ui
  const input = (action: string, name: string) => draft?.action === action ? draft.form.get(name) ?? '' : ''
  const host = await hubStub(env).getHost(hostId)
  if (!host || host.revokedAt) return notFound(ui)
  const [got, live] = await Promise.all([runOperation(env, OWNER, 'session.get', { hostId, sessionId }), hostStub(env, hostId).summary()])
  const running = live.running.filter(task => task.sessionId === sessionId)
  // Steering needs a turn in progress: a task from the hub, or one started in DSH itself.
  const canSteer = running.length > 0 || (got.ok && (got.result as SessionGetResult).session.running) || draft?.action === 'steer'
  const base = `/hosts/${hostId}/sessions/${encodeURIComponent(sessionId)}`
  const crumbs = h`<a href="/">${t('nav.home')}</a> / <a href="/hosts/${hostId}">${host.name}</a> / ${t('session.crumb')}`
  let detail: Raw
  let jobs: Raw = raw('')
  if (!got.ok) {
    detail = h`${pageHead(t('session.crumb'), { crumbs })}${errorFlash(ui, got.error, t('session.readFailed'))}`
  } else {
    const result = got.result as SessionGetResult
    const session = result.session
    const context = result.context
    detail = h`${pageHead(h`<span class="untrusted">${session.title || t('session.untitled')}</span>`, { crumbs })}
<div class="box"><dl class="kv">
  <dt>${t('session.model')}</dt><dd>${session.model ? [session.model.provider, session.model.model, session.model.effort].filter(Boolean).join(' / ') : '—'}</dd>
  <dt>${t('session.mode')}</dt><dd>${session.agentPreset ?? '—'} <span class="faint small">${t('session.modeLocked')}</span></dd>
  <dt>${t('session.state')}</dt><dd>${session.running ? t('session.running') : t('session.idle')} · ${t('session.queue', { count: result.queueLength })}</dd>
  <dt>${t('session.context')}</dt><dd>${context?.ratio !== null && context?.ratio !== undefined ? h`<progress max="1" value="${context.ratio}">${pct(context.ratio)}</progress> ${pct(context.ratio)}` : '—'}${context?.usedTokens ? ` · ${t('session.tokens', { used: i18n.number(context.usedTokens), max: context.maxTokens ? i18n.number(context.maxTokens) : '?' })}` : ''}</dd>
</dl></div>
${result.hasLiveClient ? h`<p class="muted small">${t('session.liveClient')}</p>` : ''}
<section class="block"><div class="block-head"><h2>${t('session.turns')}</h2></div>
${result.recentTurns.length === 0 ? h`<p class="empty">${t('session.turnsEmpty')}</p>` : h`<ol class="box turns">${result.recentTurns.map(turn => h`<li><p class="who">${t('session.request')}</p><div class="untrusted pre">${turn.request}</div><p class="who">${t('session.reply')}</p><div class="untrusted pre">${turn.reply}</div></li>`)}</ol>`}
<p class="muted small">${t('session.turnsNote')}</p></section>`
    jobs = jobsSection(ui, base, live, result.jobs)
  }
  const actions = h`<section class="block"><div class="block-head"><h2>${t('session.send')}</h2></div>
<form method="post" action="${base}/prompt" class="stack box box-pad">
  <input type="hidden" name="idempotencyKey" value="${input('prompt', 'idempotencyKey') || randomToken(12)}">
  <label class="field"><span class="sr-only">${t('session.prompt')}</span><textarea name="prompt" rows="4" maxlength="100000" required placeholder="${t('session.promptPlaceholder')}">${input('prompt', 'prompt')}</textarea></label>
  <label class="field"><span class="label">${t('session.skills')}</span><input name="skills" value="${input('prompt', 'skills')}" placeholder="review test"><span class="hint">${t('session.skillsHint')}</span></label>
  <div><button class="primary" type="submit">${t('session.sendSubmit')}</button></div>
</form></section>
<section class="block"><div class="block-head"><h2>${t('session.runningTasks')}</h2></div>
${running.length === 0 ? h`<p class="empty">${t('session.runningEmpty')}</p>` : h`<div class="box">${running.map(task => h`<div class="item"><div class="item-body"><a href="/tasks/${task.taskId}">${stateLabel(ui, task.state)}</a> <span class="faint small">${i18n.relative(task.updatedAt)}</span></div>
  <div class="item-actions"><form method="post" action="${base}/cancel" class="inline"><input type="hidden" name="taskId" value="${task.taskId}"><button type="submit" class="small">${t('session.cancel')}</button></form></div></div>`)}</div>`}
${canSteer ? h`<form method="post" action="${base}/steer" class="stack mt">
  <input type="hidden" name="idempotencyKey" value="${input('steer', 'idempotencyKey') || randomToken(12)}">
  <label class="field"><span class="label">${t('session.steer')}</span><textarea name="prompt" rows="2" maxlength="100000" required>${input('steer', 'prompt')}</textarea></label>
  <div><button type="submit">${t('session.steerSubmit')}</button></div>
</form>` : ''}</section>
<section class="block"><div class="block-head"><h2>${t('session.manage')}</h2></div><div class="box">
<div class="item"><div class="item-body"><div class="item-title">${t('session.compact')}</div><div class="item-meta">${t('session.compactHelp')}</div></div>
<div class="item-actions"><form method="post" action="${base}/compact" class="inline"><button type="submit" class="small">${t('session.compactSubmit')}</button></form></div></div>
<details class="disclosure"><summary>${t('session.model.title')}</summary><div class="disclosure-body"><form method="post" action="${base}/model" class="stack">
  <div class="grid3"><label class="field"><span class="label">${t('session.model.provider')}</span><input name="provider"></label><label class="field"><span class="label">${t('session.model.name')}</span><input name="model" required></label><label class="field"><span class="label">${t('session.model.effort')}</span><input name="effort"></label></div>
  <p class="muted small">${t('session.model.note')}</p>
  <div><button type="submit">${t('session.model.submit')}</button></div>
</form></div></details>
${live.operations.includes('session.fork') ? h`<details class="disclosure"><summary>${t('session.fork.title')}</summary><div class="disclosure-body"><form method="post" action="${base}/fork" class="stack">
  <p class="muted">${t('session.fork.help')}</p>
  <div class="grid3"><label class="field"><span class="label">${t('session.fork.turn')}</span><input name="atTurn" type="number" min="1" placeholder="${t('session.fork.turnPlaceholder')}"></label><label class="field"><span class="label">${t('session.fork.name')}</span><input name="title" maxlength="200"></label></div>
  <div><button type="submit">${t('session.fork.submit')}</button></div>
</form></div></details>` : ''}
</div></section>`
  const schedules = (live.online && live.operations.includes('schedules.list')) || draft?.action === 'schedule-create' ? await schedulesSection(ui, env, hostId, sessionId, base, live, draft?.action === 'schedule-create' ? draft.form : undefined) : raw('')
  const body = h`${message(ui, url)}${draft?.error}${detail}${actions}${jobs}${schedules}`
  return view(ui, t('session.crumb'), 'home', body, ['/js/webauthn.js', '/js/live.js'])
}

/** Background jobs of the session (dev servers, watchers), each with a stop button. */
function jobsSection(ui: Ui, base: string, live: HostLive, jobs: SessionGetResult['jobs']): Raw {
  const { t } = ui
  if (!jobs || jobs.length === 0) return raw('')
  const canStop = live.online && live.operations.includes('job.stop')
  return h`<section class="block" data-testid="hub-jobs"><div class="block-head"><h2>${t('jobs.title')} <span class="count">${jobs.length}</span></h2></div><div class="box">
${jobs.map(job => h`<div class="item"><div class="item-body"><div class="item-title"><span class="tag${job.status === 'running' ? ' ok' : ''}">${label(ui, 'jobs.state', job.status)}</span> <code class="untrusted">${job.label || job.kind}</code></div><div class="item-meta mono small">${job.jobId}</div></div>
  ${canStop && job.status === 'running' ? h`<div class="item-actions"><form method="post" action="${base}/job-stop" class="inline"><input type="hidden" name="jobId" value="${job.jobId}"><button type="submit" class="small danger">${t('jobs.stop')}</button></form></div>` : ''}</div>`)}</div></section>`
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

/** Scheduled prompts of the session, a form to add one, and delete buttons. */
async function schedulesSection(ui: Ui, env: Env, hostId: string, sessionId: string, base: string, live: HostLive, draft?: URLSearchParams): Promise<Raw> {
  const { t, i18n } = ui
  const input = (name: string, fallback = '') => draft?.get(name) ?? fallback
  const listed = await runOperation(env, OWNER, 'schedules.list', { hostId, sessionId })
  const schedules = listed.ok ? (listed.result as { schedules: ScheduleInfo[] }).schedules : []
  const canDelete = live.operations.includes('schedule.delete')
  const item = (schedule: ScheduleInfo) => h`<div class="item top"><div class="item-body">
  <div class="item-title"><span class="tag${schedule.status === 'active' ? ' ok' : ''}">${schedule.status === 'active' ? t('schedules.active') : t('schedules.ended')}</span> <span class="untrusted">${schedule.title}</span> <code>${schedule.rule}</code></div>
  <div class="item-meta">${join([schedule.nextAt ? h`${t('schedules.next')} ${i18n.time(schedule.nextAt)}` : null, schedule.lastDeliveredAt ? h`${t('schedules.last')} ${i18n.time(schedule.lastDeliveredAt)}` : null, schedule.createdBy ? t('schedules.by', { client: schedule.createdBy }) : null])}</div>
  ${schedule.prompt ? h`<div class="item-meta untrusted pre">${schedule.prompt}</div>` : ''}</div>
  ${canDelete ? h`<div class="item-actions"><form method="post" action="${base}/schedule-delete" class="inline"><input type="hidden" name="scheduleId" value="${schedule.scheduleId}"><button type="submit" class="small">${t('common.delete')}</button></form></div>` : ''}</div>`
  const kinds: [string, MessageKey][] = [['daily', 'schedules.kind.daily'], ['weekly', 'schedules.kind.weekly'], ['every', 'schedules.kind.every'], ['after', 'schedules.kind.after'], ['at', 'schedules.kind.at'], ['cron', 'schedules.kind.cron']]
  const form = live.operations.includes('schedule.create') || draft ? h`<details class="disclosure"${raw(draft ? ' open' : '')}><summary>${t('schedules.add')}</summary><div class="disclosure-body"><form method="post" action="${base}/schedule-create" class="stack" data-schedule-form>
  <input type="hidden" name="idempotencyKey" value="${input('idempotencyKey') || randomToken(12)}">
  <label class="field"><span class="label">${t('schedules.name')}</span><input name="title" value="${input('title')}" maxlength="120" required placeholder="${t('schedules.namePlaceholder')}"></label>
  <label class="field"><span class="label">${t('schedules.prompt')}</span><textarea name="prompt" rows="3" maxlength="20000" required>${input('prompt')}</textarea></label>
  <label class="field"><span class="label">${t('schedules.when')}</span><select name="kind" data-when-select>
    ${kinds.map(([value, key]) => h`<option value="${value}"${raw(input('kind', 'daily') === value ? ' selected' : '')}>${t(key)}</option>`)}
  </select></label>
  <div class="grid3">
    <label class="field" data-when="daily weekly"><span class="label">${t('schedules.time')}</span><input name="time" value="${input('time')}" type="time"></label>
    <label class="field" data-when="every after"><span class="label">${t('schedules.minutes')}</span><input name="minutes" value="${input('minutes')}" type="number" min="1"></label>
    <label class="field" data-when="at"><span class="label">${t('schedules.at')}</span><input name="at" value="${input('at')}" type="datetime-local"></label>
    <label class="field" data-when="cron"><span class="label">${t('schedules.cron')}</span><input name="cron" value="${input('cron')}" placeholder="0 9 * * 1-5"></label>
    <label class="field" data-when="daily weekly at cron"><span class="label">${t('schedules.timeZone')}</span><input name="timeZone" value="${input('timeZone')}" placeholder="UTC" data-default-time-zone></label>
  </div>
  <fieldset data-when="weekly"><legend>${t('schedules.weekdays')}</legend><div class="weekdays">${WEEKDAYS.map(day => h`<label class="check"><input type="checkbox" name="weekday" value="${day}"${raw(draft?.getAll('weekday').includes(String(day)) ? ' checked' : '')}> ${t(`schedules.weekday.${day}`)}</label>`)}</div></fieldset>
  <p class="muted small">${t('schedules.help')}</p>
  <div><button type="submit">${t('schedules.submit')}</button></div>
</form></div></details>` : raw('')
  return h`<section class="block" data-testid="hub-schedules"><div class="block-head"><h2>${t('schedules.title')} <span class="count">${schedules.length}</span></h2></div>
${listed.ok ? '' : errorFlash(ui, listed.error, t('schedules.readFailed'))}
<div class="box">${schedules.length === 0 ? h`<div class="item"><span class="muted">${t('schedules.empty')}</span></div>` : schedules.map(item)}${form}</div></section>`
}

async function sessionAction(ui: Ui, env: Env, request: Request, hostId: string, sessionId: string, action: string): Promise<Response> {
  const form = await readForm(request)
  const base = `/hosts/${hostId}/sessions/${encodeURIComponent(sessionId)}`
  let outcome
  switch (action) {
    case 'prompt': {
      const skills = (form.get('skills') ?? '').split(/\s+/).map(skill => skill.replace(/^\//, '')).filter(Boolean)
      outcome = await runOperation(env, OWNER, 'task.start', { hostId, target: { sessionId }, prompt: form.get('prompt') ?? '', idempotencyKey: form.get('idempotencyKey') || randomToken(12), ...(skills.length > 0 ? { skills } : {}) })
      if (outcome.ok) return redirect(`/tasks/${(outcome.result as TaskInfo).taskId}?msg=sent`)
      break
    }
    case 'steer':
      outcome = await runOperation(env, OWNER, 'task.steer', { hostId, sessionId, prompt: form.get('prompt') ?? '', idempotencyKey: form.get('idempotencyKey') || randomToken(12) })
      break
    case 'cancel':
      outcome = await runOperation(env, OWNER, 'task.cancel', { hostId, taskId: form.get('taskId') ?? '' })
      break
    case 'compact':
      outcome = await runOperation(env, OWNER, 'command.run', { hostId, sessionId, command: '/compact' })
      break
    case 'model': {
      const params: Record<string, string> = { hostId, sessionId, model: form.get('model') ?? '' }
      for (const key of ['provider', 'effort']) if (form.get(key)) params[key] = form.get(key) as string
      outcome = await runOperation(env, OWNER, 'model.select', params)
      break
    }
    case 'fork': {
      const atTurn = Number(form.get('atTurn') || '0')
      const title = (form.get('title') ?? '').trim()
      outcome = await runOperation(env, OWNER, 'session.fork', { hostId, sessionId, ...(atTurn > 0 ? { atTurn: Math.floor(atTurn) } : {}), ...(title ? { title } : {}) })
      if (outcome.ok) return redirect(`/hosts/${hostId}/sessions/${encodeURIComponent((outcome.result as SessionForkResult).session.sessionId)}?msg=forked`)
      break
    }
    case 'job-stop':
      outcome = await runOperation(env, OWNER, 'job.stop', { hostId, jobId: form.get('jobId') ?? '' })
      if (outcome.ok) return redirect(`${base}?msg=${(outcome.result as { stopped: boolean }).stopped ? 'job-stopped' : 'job-not-running'}`)
      break
    case 'schedule-create': {
      const when = whenFromForm(form)
      if (!when.ok) return sessionPage(ui, env, new URL(base, request.url), hostId, sessionId, { action, form, error: flash(ui.t(when.message, when.vars), 'error') })
      outcome = await runOperation(env, OWNER, 'schedule.create', { hostId, sessionId, title: (form.get('title') ?? '').trim(), prompt: form.get('prompt') ?? '', when: when.when, idempotencyKey: form.get('idempotencyKey') || randomToken(12) })
      if (outcome.ok) return redirect(`${base}?msg=schedule-created`)
      break
    }
    case 'schedule-delete':
      outcome = await runOperation(env, OWNER, 'schedule.delete', { hostId, sessionId, scheduleId: form.get('scheduleId') ?? '' })
      if (outcome.ok) return redirect(`${base}?msg=${(outcome.result as { deleted: boolean }).deleted ? 'schedule-deleted' : 'schedule-gone'}`)
      break
    default:
      return notFound(ui)
  }
  if (outcome.ok) return redirect(`${base}?msg=sent`)
  if (['prompt', 'steer', 'schedule-create'].includes(action)) return sessionPage(ui, env, new URL(base, request.url), hostId, sessionId, { action, form, error: errorFlash(ui, outcome.error) })
  return failedPage(ui, 'home', outcome.error, base)
}

function failedPage(ui: Ui, nav: NavKey, error: RemoraError | undefined, back: string, title?: string): Response {
  return view(ui, ui.t('error.failed'), nav, h`${errorFlash(ui, error, title)}<div class="actions"><a class="btn" href="${back}">${ui.t('common.back')}</a></div>`)
}

// --- tasks and attention --------------------------------------------------------------------------

const CHANGE_STATUS: Readonly<Record<string, MessageKey>> = { added: 'task.change.added', modified: 'task.change.modified', deleted: 'task.change.deleted', renamed: 'task.change.renamed' }

async function taskPage(ui: Ui, env: Env, url: URL, taskId: string): Promise<Response> {
  const { t, i18n } = ui
  const got = await runOperation(env, OWNER, 'task.get', { taskId })
  if (!got.ok) return view(ui, t('task.title'), 'home', h`${pageHead(t('task.title'), { crumbs: h`<a href="/">${t('nav.home')}</a> / ${t('task.title')}` })}${errorFlash(ui, got.error, t('task.readFailed'))}`)
  const task = got.result as TaskInfo
  const host = await hubStub(env).getHost(task.hostId)
  const body = h`${message(ui, url)}${pageHead(h`${t('task.title')} <span class="state ${task.state}">${stateLabel(ui, task.state)}</span>`, { crumbs: h`<a href="/">${t('nav.home')}</a> / <a href="/hosts/${task.hostId}">${host?.name ?? task.hostId}</a> / ${t('task.title')}` })}
<div class="box"><dl class="kv"><dt>${t('task.created')}</dt><dd>${i18n.time(task.createdAt)}</dd><dt>${t('task.updated')}</dt><dd>${i18n.time(task.updatedAt)}</dd>
${task.sessionId ? h`<dt>${t('task.session')}</dt><dd><a href="/hosts/${task.hostId}/sessions/${encodeURIComponent(task.sessionId)}">${t('task.openSession')}</a></dd>` : ''}
<dt>ID</dt><dd class="mono small faint">${task.taskId}</dd></dl></div>
${task.hasLiveClient ? h`<p class="muted small">${t('session.liveClient')}</p>` : ''}
${errorFlash(ui, task.error, t('task.error'))}
${task.state === 'parked' && task.error ? flash(t('task.parkedSent'), 'warn') : ''}
${task.state === 'parked' && !task.error ? flash(t('task.parked'), 'warn') : ''}
${task.attention && task.attention.length > 0 ? h`<section class="block"><div class="block-head"><h2>${t('home.attention')}</h2></div><div class="box">${task.attention.map(item => attentionRow(ui, item, ''))}</div></section>` : ''}
${task.result ? h`<section class="block"><div class="block-head"><h2>${t('task.reply')}</h2></div><div class="untrusted pre quote">${task.result.reply ?? t('task.noReply')}</div></section>
${task.result.changes && task.result.changes.length > 0 ? h`<section class="block"><div class="block-head"><h2>${t('task.changes')} <span class="count">${task.result.changes.length}</span></h2></div><div class="box">${task.result.changes.map(change => h`<div class="item"><span class="tag">${CHANGE_STATUS[change.status] ? t(CHANGE_STATUS[change.status] as MessageKey) : change.status}</span><span class="mono small untrusted">${change.path}</span></div>`)}</div></section>` : ''}
${task.result.deliverables && task.result.deliverables.length > 0 ? h`<section class="block"><div class="block-head"><h2>${t('task.deliverables')}</h2></div><div class="box">${task.result.deliverables.map(item => h`<div class="item untrusted">${item.title}</div>`)}</div></section>` : ''}` : ''}`
  return view(ui, t('task.title'), 'home', body)
}

/** Why an attention item cannot be answered from the hub, and what to do instead. */
const NOT_ANSWERABLE: Readonly<Record<string, MessageKey>> = {
  question: 'attention.notAnswerable.question',
  'plan-review': 'attention.notAnswerable.plan-review',
  approval: 'attention.notAnswerable.approval',
  'goal-stopped': 'attention.notAnswerable.goal-stopped',
  'login-expired': 'attention.notAnswerable.login-expired',
}

interface CardHost {
  hostId: string
  name: string
  online: boolean
  /** The plugin serves approval.respond. */
  canApprove: boolean
}

/** The detail without a first line that only repeats the title (DSH puts the question text first). */
function detailBeyondTitle(item: AttentionItem): string {
  const detail = (item.detail ?? '').trim()
  const [first = '', ...rest] = detail.split('\n')
  return (first.trim() === item.title.trim() ? rest.join('\n') : detail).trim()
}

/** One item with everything needed to answer it from the hub. */
function attentionCard(ui: Ui, item: AttentionItem, host: CardHost, single = false): Raw {
  const { t } = ui
  const route = answerRoute(item)
  const expiring = typeof item.expiresAt === 'number'
  const head = h`<div class="head"><span class="tag ${item.kind === 'approval' ? 'danger' : 'warn'}">${kindLabel(ui, item.kind)}</span> ${countdown(ui, item.expiresAt)} <span>${ui.i18n.relative(item.createdAt)}</span>
  ${single ? '' : h`<a href="${answerPath(item.hostId, item.attentionId)}">${t('attention.openOne')}</a>`}</div>`
  const what = item.kind === 'approval'
    ? h`<dl class="kv">
  <dt>${t('attention.approval.operation')}</dt><dd class="untrusted"><strong>${item.title}</strong></dd>
  ${item.detail ? h`<dt>${t('attention.approval.reason')}</dt><dd class="untrusted pre">${item.detail}</dd>` : ''}
  <dt>${t('attention.host')}</dt><dd>${host.name}</dd>
  <dt>${t('attention.session')}</dt><dd><a href="/hosts/${host.hostId}/sessions/${encodeURIComponent(item.sessionId)}">${t('attention.openSession')}</a></dd>
</dl>`
    : h`<p class="ask untrusted">${item.title}</p>
  ${detailBeyondTitle(item) ? h`${item.kind === 'plan-review' ? h`<p class="who">${t('attention.plan')}</p>` : ''}<div class="untrusted pre quote">${detailBeyondTitle(item)}</div>` : ''}`
  let answer: Raw
  if (route === 'expired') {
    answer = flash(t('attention.expired'), 'error')
  } else if (route === 'dsh-web') {
    answer = h`<p class="muted not-answerable">${t(NOT_ANSWERABLE[item.kind] ?? 'attention.notAnswerable.other')}</p>`
  } else if (!host.online) {
    answer = h`<p class="muted">${t('attention.offline')}</p>`
  } else if (route === 'passkey') {
    const params = { hostId: host.hostId, sessionId: item.sessionId, attentionId: item.attentionId }
    const signed = approvalSignedPayloads(params)
    answer = host.canApprove
      ? h`<form data-confirm-op="approval.respond" data-host="${host.hostId}" data-params="${JSON.stringify(params)}" data-done="/attention?msg=sent" class="stack">
  <div class="actions"><button class="primary" type="submit" data-approve="true" data-testid="hub-approval-allow">${t('attention.approval.allow')}</button>
  <button class="danger" type="submit" data-approve="false" data-testid="hub-approval-reject">${t('attention.approval.reject')}</button></div>
  <div data-status role="status" hidden></div>
</form>
<details class="plain confirm-preview"><summary>${t('attention.signed')}</summary>
  <p class="muted small">${t('attention.signedHelp')}</p>
  <p class="muted small">${t('attention.approval.allow')}</p>
  <pre class="codes">${signed.allow}</pre>
  <p class="muted small">${t('attention.approval.reject')}</p>
  <pre class="codes">${signed.reject}</pre></details>`
      : h`<p class="muted not-answerable">${t('attention.approval.unsupported')}</p>`
  } else if (item.kind === 'plan-review') {
    answer = h`<form method="post" action="/attention/respond" class="stack">
  <input type="hidden" name="hostId" value="${host.hostId}"><input type="hidden" name="sessionId" value="${item.sessionId}"><input type="hidden" name="attentionId" value="${item.attentionId}">
  <label class="field"><span class="label">${t('attention.plan.note')}</span><textarea name="text" rows="2"></textarea></label>
  <div class="actions"><button class="primary" type="submit" name="approve" value="true" data-testid="hub-plan-approve">${t('attention.plan.approve')}</button><button type="submit" name="approve" value="false" data-testid="hub-plan-reject">${t('attention.plan.reject')}</button></div>
</form>`
  } else {
    const options = item.options ?? []
    answer = h`<form method="post" action="/attention/respond" class="stack">
  <input type="hidden" name="hostId" value="${host.hostId}"><input type="hidden" name="sessionId" value="${item.sessionId}"><input type="hidden" name="attentionId" value="${item.attentionId}">
  ${options.length > 0 ? h`<fieldset><legend class="sr-only">${t('attention.choose')}</legend><div class="options">${options.map(option => h`<label class="option"><input type="radio" name="optionId" value="${option.id}"> <span class="untrusted">${option.label}</span></label>`)}</div></fieldset>` : ''}
  <label class="field"><span class="label">${options.length > 0 ? t('attention.freeTextOptional') : t('attention.freeText')}</span><textarea name="text" rows="2"></textarea></label>
  <div><button class="primary" type="submit" data-testid="hub-question-answer">${t('attention.answer')}</button></div>
</form>`
  }
  return h`<article class="attention-card kind-${item.kind}${route === 'expired' ? ' expired' : ''}" id="${item.hostId}-${item.attentionId}"${raw(expiring ? ' data-expiring' : '')} data-testid="hub-attention-item">
${head}
${what}
<div class="answer">${answer}</div>
</article>`
}

/** The current items of one host: live from the host when online, else the last list it sent. */
async function hostAttention(ui: Ui, env: Env, summary: HostSummary, live: HostLive): Promise<{ items: AttentionItem[]; note: Raw }> {
  if (!summary.online) {
    return { items: live.attention, note: live.attention.length > 0 ? h`<p class="muted small">${ui.t('attention.offlineList')}</p>` : raw('') }
  }
  const listed = await runOperation(env, OWNER, 'attention.list', { hostId: summary.hostId })
  if (listed.ok) return { items: (listed.result as { items?: AttentionItem[] }).items ?? [], note: raw('') }
  return { items: live.attention, note: errorFlash(ui, listed.error, ui.t('attention.listFailed')) }
}

const cardHost = (summary: HostSummary): CardHost => ({ hostId: summary.hostId, name: summary.name, online: summary.online, canApprove: summary.operations.includes('approval.respond') })

async function attentionPage(ui: Ui, env: Env, url: URL): Promise<Response> {
  const { t } = ui
  const data = await overview(env)
  const sections: Raw[] = []
  for (const { summary, live } of data.hosts) {
    const { items, note } = await hostAttention(ui, env, summary, live)
    if (items.length === 0 && live.confirmations.length === 0 && note.value === '') continue
    sections.push(h`<section class="block"><div class="block-head"><h2>${summary.name}</h2></div>${note}
${live.confirmations.length > 0 ? h`<div class="box">${confirmationList(ui, live.confirmations.map(item => ({ item, hostId: summary.hostId, name: '' })))}</div>` : ''}
${items.length > 0 ? h`<div class="box">${[...items].sort(byUrgency).map(item => attentionCard(ui, item, cardHost(summary)))}</div>` : ''}</section>`)
  }
  if (data.approvals.length > 0) sections.unshift(h`<section class="block"><div class="block-head"><h2>${t('common.hub')}</h2></div><div class="box">${confirmationList(ui, data.approvals.map(item => ({ item, hostId: 'hub', name: '' })))}</div></section>`)
  const body = h`${message(ui, url)}${pageHead(t('attention.title'), { subtitle: t('attention.untrusted') })}<span data-refresh-on-show hidden></span>
${sections.length === 0 ? h`<p class="empty">${t('home.attentionEmpty')}</p>` : sections}`
  return view(ui, t('attention.title'), 'attention', body)
}

/** The page an answerUrl opens: one item, ready to answer. */
async function attentionItemPage(ui: Ui, env: Env, url: URL, hostId: string, attentionId: string): Promise<Response> {
  const { t } = ui
  const host = await hubStub(env).getHost(hostId)
  if (!host || host.revokedAt) return notFound(ui)
  const data = await overview(env)
  const entry = data.hosts.find(candidate => candidate.summary.hostId === hostId)
  if (!entry) return notFound(ui)
  const { items, note } = await hostAttention(ui, env, entry.summary, entry.live)
  const item = items.find(candidate => candidate.attentionId === attentionId)
  const body = h`${message(ui, url)}${pageHead(t('attention.title'), { crumbs: h`<a href="/">${t('nav.home')}</a> / <a href="/attention">${t('attention.title')}</a> / ${entry.summary.name}`, subtitle: t('attention.untrusted') })}
${note}
${item ? h`<div class="box">${attentionCard(ui, item, cardHost(entry.summary), true)}</div>` : h`<div class="notice" data-testid="hub-attention-gone">${t('attention.gone')}</div>`}
<div class="actions"><a class="btn" href="/attention">${t('attention.all')}</a></div>`
  return view(ui, t('attention.title'), 'attention', body)
}

async function attentionRespond(ui: Ui, env: Env, request: Request): Promise<Response> {
  const form = await readForm(request)
  const answer: Record<string, unknown> = {}
  if (form.get('optionId')) answer.optionId = form.get('optionId')
  if ((form.get('text') ?? '').trim()) answer.text = form.get('text')
  if (form.get('approve')) answer.approve = form.get('approve') === 'true'
  const hostId = form.get('hostId') ?? ''
  const attentionId = form.get('attentionId') ?? ''
  if (Object.keys(answer).length === 0) return redirect(`${answerPath(hostId, attentionId)}?msg=answer-empty`)
  const outcome = await runOperation(env, OWNER, 'attention.respond', { hostId, sessionId: form.get('sessionId') ?? '', attentionId, answer })
  if (outcome.ok) return redirect('/attention?msg=sent')
  return failedPage(ui, 'attention', outcome.error, '/attention')
}

// --- passkey confirmations of parked requests -------------------------------------------------

function terminalOutput(ui: Ui, output: TerminalRunOutput): Raw {
  const { t } = ui
  const status = output.timedOut ? t('terminal.timedOut') : output.exitCode === null ? t('terminal.signal', { signal: output.signal ?? '?' }) : t('terminal.exit', { code: output.exitCode })
  return h`<div class="box"><dl class="kv"><dt>${t('terminal.result')}</dt><dd><span class="tag${output.exitCode === 0 ? ' ok' : ' danger'}">${status}</span> <span class="faint">${t('terminal.seconds', { seconds: (output.durationMs / 1000).toFixed(1) })}</span></dd></dl></div>
<p class="who">${t('terminal.stdout')}</p><div class="untrusted pre quote" data-testid="hub-terminal-stdout">${output.stdout || t('terminal.none')}</div>
${output.stderr ? h`<p class="who">${t('terminal.stderr')}</p><div class="untrusted pre quote" data-testid="hub-terminal-stderr">${output.stderr}</div>` : ''}
${output.truncated ? h`<p class="muted small">${t('terminal.truncated')}</p>` : ''}
<p class="muted small">${t('terminal.redacted')}</p>`
}

/** JSON with every non-ASCII character escaped (`‮`), so no invisible character reaches the page. */
function asciiJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(/[\u007f-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** The page a confirmUrl opens: what a client asked to run, and the passkey button. */
async function confirmPage(ui: Ui, env: Env, url: URL, origin: string, hostId: string, confirmationId: string): Promise<Response> {
  const { t, i18n } = ui
  const host = await hubStub(env).getHost(hostId)
  if (!host || host.revokedAt) return notFound(ui)
  const [item, live] = await Promise.all([confirmations(env, hostId).view(confirmationId, origin), hostStub(env, hostId).summary()])
  if (!item) return notFound(ui)
  const params = item.params
  const crumbs = h`<a href="/">${t('nav.home')}</a> / <a href="/hosts/${hostId}">${host.name}</a> / ${t('confirm.title')}`
  const requester = item.clientId === OWNER_CLIENT_ID ? t('confirm.you') : visibleText(item.clientName).text
  const command = typeof params.command === 'string' ? visibleText(params.command) : null
  let workspace: Raw = h`<span class="mono">${String(params.cwdWorkspaceId ?? '')}</span>`
  if (item.state === 'pending' && live.online && typeof params.cwdWorkspaceId === 'string') {
    const listed = await runOperation(env, OWNER, 'workspaces.list', { hostId })
    const found = listed.ok ? ((listed.result as { workspaces?: WorkspaceSummary[] }).workspaces ?? []).find(entry => entry.workspaceId === params.cwdWorkspaceId) : undefined
    if (found) workspace = h`<span class="untrusted">${found.name}</span>${found.untrusted ? h` <span class="tag warn">${t('host.untrusted')}</span>` : ''} <span class="faint mono small">${found.path ?? ''}</span>`
  }
  const facts = h`<div class="box"><dl class="kv">
  <dt>${t('confirm.operation')}</dt><dd>${opLabel(ui, item.operation)}</dd>
  <dt>${t('confirm.requester')}</dt><dd>${requester}</dd>
  <dt>${t('confirm.host')}</dt><dd>${host.name}</dd>
  ${command ? h`<dt>${t('confirm.command')}</dt><dd><pre class="command untrusted" dir="ltr" data-testid="hub-confirm-command">${command.text}</pre>${command.hidden ? h`<div class="notice error" data-testid="hub-confirm-hidden">${t('confirm.hidden')}</div>` : ''}</dd>` : ''}
  ${params.cwdWorkspaceId !== undefined ? h`<dt>${t('confirm.where')}</dt><dd>${workspace}</dd>` : ''}
  ${typeof params.timeoutMs === 'number' ? h`<dt>${t('confirm.timeout')}</dt><dd>${t('terminal.seconds', { seconds: Math.round(params.timeoutMs / 1000) })}</dd>` : ''}
  <dt>${t('confirm.state')}</dt><dd><span class="state ${item.state}" data-testid="hub-confirm-state" data-state="${item.state}">${label(ui, 'confirm.stateName', item.state)}</span> <span class="faint small">${i18n.time(item.createdAt)}</span></dd>
</dl></div>`
  let outcome: Raw
  let refreshSeconds: number | undefined
  const deny = h`<form method="post" action="${confirmPath(hostId, item.confirmationId)}/deny" class="inline"><button type="submit" data-testid="hub-confirm-deny">${t('confirm.deny')}</button></form>`
  switch (item.state) {
    case 'pending':
      if (OWNER_APPROVED_OPERATIONS.has(item.operation)) {
        outcome = h`<section class="block" data-expiring><p>${t(`explain.${item.operation}` as MessageKey)} ${countdown(ui, item.expiresAt)}</p>
${live.online ? h`<div class="actions">${reauthForm(`${confirmPath(hostId, item.confirmationId)}/approve`, {}, t('confirm.approve'), 'danger-solid')}${deny}</div>` : h`<p class="muted">${t('confirm.offline')}</p><div class="actions">${deny}</div>`}
</section>`
        break
      }
      outcome = h`<section class="block" data-expiring>
<div class="notice warn">${t('confirm.check')} ${countdown(ui, item.expiresAt)}</div>
${!live.online ? h`<p class="muted">${t('confirm.offlineLater')}</p><div class="actions">${deny}</div>` : h`<div class="actions">
  <form data-confirm-op="${item.operation}" data-host="${hostId}" data-params="${asciiJson(params)}" data-pending="${item.confirmationId}" data-done="${confirmPath(hostId, item.confirmationId)}" class="contents">
    <button class="danger-solid" type="submit" data-testid="hub-confirm-run">${t('confirm.run')}</button>
    <div data-status role="status" hidden></div>
  </form>
  ${deny}
</div>
<details class="plain confirm-preview"><summary>${t('attention.signed')}</summary>
<p class="muted small">${t('attention.signedHelp')}</p>
<pre class="codes">${asciiJson({ operation: item.operation, clientId: item.clientId, ...finalParams(item.operation, params, hostId) }, 2)}</pre></details>`}
</section>`
      break
    case 'running':
      refreshSeconds = 3
      outcome = flash(t('confirm.running'), 'ok')
      break
    case 'done':
      if (item.operation === 'host.rotate-key' && item.result) {
        const rotated = item.result as HostRotateKeyResult
        outcome = flash(h`${t('confirm.rotated')} <code>${rotated.publicKeyFingerprint}</code> · ${i18n.time(rotated.rotatedAt)}`, 'ok')
        break
      }
      outcome = item.result === undefined
        ? h`<p class="muted">${t('confirm.outputGone')}</p>`
        : item.operation === 'terminal.run' && item.result && typeof item.result === 'object'
          ? h`<section class="block">${terminalOutput(ui, item.result as TerminalRunOutput)}</section>`
          : h`<pre class="untrusted pre quote">${JSON.stringify(item.result, null, 2)}</pre>`
      break
    case 'failed':
      outcome = errorFlash(ui, item.error, t('confirm.failed'))
      break
    case 'denied':
      outcome = h`<p class="muted">${t('confirm.denied')}</p>`
      break
    default:
      outcome = h`<p class="muted">${t('confirm.expired')}</p>`
  }
  const body = h`${message(ui, url)}${pageHead(t('confirm.title'), { crumbs })}${facts}${outcome}`
  return view(ui, t('confirm.title'), 'attention', body, ['/js/webauthn.js', '/js/live.js'], refreshSeconds ? { refreshSeconds } : {})
}

async function denyConfirmation(env: Env, hostId: string, confirmationId: string): Promise<Response> {
  const denied = hostId === 'hub' ? await hubStub(env).decideApproval(confirmationId, false) : await confirmations(env, hostId).deny(confirmationId)
  return redirect(`${confirmPath(hostId, confirmationId)}?msg=${denied ? 'confirmation-denied' : 'confirmation-gone'}`)
}

/** /confirm/hub/<id>: a client asks for hub maintenance (an export); the owner approves with a passkey re-authentication. */
async function hubApprovalPage(ui: Ui, env: Env, url: URL, id: string): Promise<Response> {
  const { t, i18n } = ui
  const row = await hubStub(env).approvalFor(id)
  if (!row) return notFound(ui)
  const facts = h`<div class="box"><dl class="kv">
  <dt>${t('confirm.operation')}</dt><dd>${opLabel(ui, row.operation)} <span class="faint mono small">${row.operation}</span></dd>
  <dt>${t('confirm.requester')}</dt><dd>${visibleText(row.clientName).text} <span class="faint mono small">${row.clientId}</span></dd>
  <dt>${t('confirm.state')}</dt><dd><span class="state ${row.state}" data-testid="hub-confirm-state" data-state="${row.state}">${label(ui, 'confirm.stateName', row.state)}</span> <span class="faint small">${i18n.time(row.createdAt)}</span></dd>
</dl></div>`
  const path = confirmPath('hub', id)
  const outcome = row.state === 'pending'
    ? h`<section class="block" data-expiring>
<p>${t(`explain.${row.operation}` as MessageKey)} ${countdown(ui, row.expiresAt)}</p>
<p class="muted">${t('confirm.hubResult')}</p>
<div class="actions">${reauthForm(`${path}/approve`, {}, t('confirm.approve'), 'danger-solid')}<form method="post" action="${path}/deny" class="inline"><button type="submit" data-testid="hub-confirm-deny">${t('confirm.deny')}</button></form></div>
</section>`
    : row.state === 'done' ? flash(h`${t('confirm.approvedAt')} ${row.decidedAt ? i18n.time(row.decidedAt) : ''}`, 'ok')
      : row.state === 'denied' ? h`<p class="muted">${t('confirm.denied')}</p>`
        : h`<p class="muted">${t('confirm.expiredHub')}</p>`
  const body = h`${message(ui, url)}${pageHead(t('confirm.title'), { crumbs: h`<a href="/">${t('nav.home')}</a> / <a href="/attention">${t('attention.title')}</a> / ${t('common.hub')}` })}${facts}${outcome}`
  return view(ui, t('confirm.title'), 'attention', body)
}

type Outcome = { ok: true } | { ok: false; error: RemoraError }

/** POST /confirm/<hub|host>/<id>/approve, after a fresh passkey re-authentication. */
async function approveMaintenance(ui: Ui, env: Env, origin: string, fresh: boolean, where: string, id: string): Promise<Response> {
  const path = confirmPath(where, id)
  if (!fresh) return redirect(`${path}?msg=reauth`)
  if (where === 'hub') {
    const decided = await hubStub(env).decideApproval(id, true)
    return redirect(`${path}?msg=${decided ? 'approved' : 'confirmation-gone'}`)
  }
  const ran = (await hostStub(env, where).approveRun(id, origin)) as Outcome
  return ran.ok ? redirect(path) : failedPage(ui, 'attention', ran.error, path)
}

/** The host page's "rotate the key" button (the owner is present: nothing to park). */
async function rotateHostKey(ui: Ui, env: Env, hostId: string, fresh: boolean): Promise<Response> {
  if (!fresh) return redirect(`/hosts/${hostId}?msg=reauth`)
  const outcome = (await hostStub(env, hostId).rotateKey()) as Outcome
  if (outcome.ok) return redirect(`/hosts/${hostId}?msg=key-rotated`)
  return failedPage(ui, 'home', outcome.error, `/hosts/${hostId}`, ui.t('host.rotateFailed'))
}

/** The host page's terminal form: park the command, then confirm it on its page. */
async function terminalRequest(ui: Ui, env: Env, request: Request, origin: string, hostId: string): Promise<Response> {
  const form = await readForm(request)
  const seconds = Math.min(600, Math.max(1, Math.round(Number(form.get('timeoutSeconds') || '60')) || 60))
  const outcome = await runOperation(env, OWNER, 'terminal.run', { hostId, command: form.get('command') ?? '', cwdWorkspaceId: form.get('cwdWorkspaceId') ?? '', timeoutMs: seconds * 1000 }, { origin })
  if (outcome.ok) return redirect(confirmPath(hostId, (outcome.result as ConfirmationInfo).confirmationId))
  return failedPage(ui, 'home', outcome.error, `/hosts/${hostId}`)
}

/** JSON endpoint for dangerous operations carrying a passkey confirmation collected in the browser. */
async function confirmedOperation(env: Env, request: Request): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await readJson(request)) as Record<string, unknown>
  } catch {
    return json({ error: { code: 'invalid_request', message: 'invalid JSON' } }, { status: 400 })
  }
  const { operation, params, requestId, issuedAt, assertion } = body
  if (typeof operation !== 'string' || typeof requestId !== 'string' || typeof issuedAt !== 'number' || typeof assertion !== 'object' || assertion === null) {
    return json({ error: { code: 'invalid_request', message: 'operation, params, requestId, issuedAt and assertion are required' } }, { status: 400 })
  }
  const hostId = body.hostId
  if (typeof hostId !== 'string') return json({ error: { code: 'invalid_request', message: 'hostId is required' } }, { status: 400 })
  const raw = typeof params === 'object' && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
  if (typeof raw.hostId === 'string' && raw.hostId !== hostId) return json({ error: { code: 'invalid_request', message: 'params.hostId does not match hostId' } }, { status: 400 })
  // Same params as /auth/confirm/options signed over, and the frame id is the requestId it returned.
  const confirmation = { issuedAt, assertion } as Confirmation
  if (typeof body.pendingId === 'string') {
    // A parked request: the host object sends its stored params, with the requester's current grant.
    const host = confirmations(env, hostId)
    const pending = await host.view(body.pendingId)
    if (!pending || pending.operation !== operation) return json({ error: { code: 'not_found', message: 'No such request.' } }, { status: 404 })
    const grant = pending.clientId === OWNER_CLIENT_ID ? ownerGrantFor(operation, pending.params) : (await hubStub(env).clientStanding(pending.clientId, hostId)).grant
    const ran = await host.run(body.pendingId, { requestId, confirmation, grant, origin: hubOrigin(request, env) })
    return ran.ok ? json({ ok: true, result: ran.result }) : json({ error: ran.error }, { status: 400 })
  }
  const outcome = await runOperation(env, OWNER, operation, finalParams(operation, raw, hostId), { confirmation, requestId })
  return outcome.ok ? json({ ok: true, result: outcome.result }) : json({ error: outcome.error }, { status: 400 })
}

/** JSON endpoints used by /js/push.js to store or drop this device's subscription. */
async function pushEndpoint(ui: Ui, env: Env, request: Request, path: string): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await readJson(request, 8192)) as Record<string, unknown>
  } catch {
    return json({ error: { code: 'invalid_request', message: 'invalid JSON' } }, { status: 400 })
  }
  const hub = hubStub(env)
  const subscription = (typeof body.subscription === 'object' && body.subscription !== null ? body.subscription : body) as Record<string, unknown>
  const endpoint = subscription.endpoint
  if (path === '/push/unsubscribe') {
    if (typeof endpoint !== 'string') return json({ error: { code: 'invalid_request', message: 'endpoint is required' } }, { status: 400 })
    return json({ ok: await hub.pushUnsubscribe({ endpoint }) })
  }
  const keys = (typeof subscription.keys === 'object' && subscription.keys !== null ? subscription.keys : {}) as Record<string, unknown>
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.replace(/=+$/, '') : null
  const auth = typeof keys.auth === 'string' ? keys.auth.replace(/=+$/, '') : null
  if (!isPushEndpoint(endpoint)) return json({ error: { code: 'invalid_request', message: 'endpoint must be an https URL of a known push service' } }, { status: 400 })
  if (!isSubscriptionKey(p256dh, 65) || !isSubscriptionKey(auth, 16)) return json({ error: { code: 'invalid_request', message: 'keys.p256dh and keys.auth are required' } }, { status: 400 })
  const label = typeof body.label === 'string' && body.label.trim() ? pushText(body.label, 60) : ui.t('push.thisDevice')
  const stored = await hub.pushSubscribe({ endpoint, p256dh, auth, label, lang: ui.i18n.locale })
  if ('error' in stored) return json({ error: { code: 'conflict', message: 'Too many devices; remove one first.' } }, { status: 409 })
  return json({ ok: true, id: stored.id })
}

// --- connections -------------------------------------------------------------------------------------

const CLIENT_KIND: Readonly<Record<string, MessageKey>> = { cimd: 'connections.kind.app', dcr: 'connections.kind.registered', cli: 'connections.kind.cli', pat: 'connections.kind.pat' }

async function connectionsPage(ui: Ui, env: Env, url: URL, origin: string): Promise<Response> {
  const { t, i18n } = ui
  const data = await overview(env)
  const resources = resourcesFor(origin)
  const active = data.clients.filter(client => !client.revokedAt)
  const revoked = data.clients.filter(client => client.revokedAt)
  const levelsFor = (summary: HostSummary): GrantLevel[] => {
    const ceiling = summary.ceiling ? LEVEL_RANK[summary.ceiling.level] : 0
    return (['none', 'view', 'request', 'full'] as GrantLevel[]).filter(level => level === 'none' || level === 'view' || LEVEL_RANK[level] <= ceiling)
  }
  const clientBox = (client: ClientWithGrants): Raw => h`<div class="box${client.revokedAt ? ' expired' : ''}" data-testid="hub-client">
  <div class="item top"><div class="item-body"><div class="item-title">${client.name} <span class="tag">${t(CLIENT_KIND[client.kind] ?? 'connections.kind.app')}</span>${client.revokedAt ? h` <span class="tag">${t('connections.revoked')}</span>` : ''}</div>
  <div class="item-meta">${join([client.domain, client.redirectHost ? t('connections.redirect', { host: client.redirectHost }) : null, t('connections.lastUsed', { when: i18n.relative(client.lastUsedAt) })])}</div></div>
  ${client.revokedAt ? '' : h`<div class="item-actions">${reauthForm('/connections/revoke', { clientId: client.clientId }, t('connections.revoke'), 'danger small')}</div>`}</div>
  ${client.revokedAt || data.hosts.length === 0 ? '' : h`<div class="box-pad"><table class="grants"><tbody>${data.hosts.map(({ summary }) => {
    const setting = client.grants.find(grant => grant.hostId === summary.hostId)
    const current: GrantLevel = setting?.level ?? 'view'
    const expired = current === 'full' && (setting?.fullAccessExpiresAt ?? 0) <= Date.now()
    const capped = !summary.ceiling || LEVEL_RANK[summary.ceiling.level] < LEVEL_RANK.request
    return h`<tr><th scope="row">${summary.name}</th><td>
      <form method="post" action="/connections/grant" data-reauth class="grant-form">
        <input type="hidden" name="clientId" value="${client.clientId}"><input type="hidden" name="hostId" value="${summary.hostId}">
        <select name="level" data-autosubmit aria-label="${t('connections.levelFor', { host: summary.name })}" data-testid="hub-grant-level">${levelsFor(summary).map(level => h`<option value="${level}"${raw(level === current ? ' selected' : '')}>${levelLabel(ui, level)}</option>`)}</select>
        <button type="submit" class="small" data-autosubmit-fallback>${t('common.save')}</button>
        ${current === 'full' ? h`<span class="tag danger">${expired ? t('connections.fullExpired') : t('connections.fullUntil', { when: i18n.relative(setting?.fullAccessExpiresAt) })}</span>` : ''}
        ${capped ? h`<span class="faint small">${t('connections.capped', { level: levelLabel(ui, summary.ceiling?.level ?? 'view') })}</span>` : ''}
        <div data-status role="status" hidden></div>
      </form>
    </td></tr>`
  })}</tbody></table></div>`}
</div>`
  const body = h`${message(ui, url)}${pageHead(t('connections.title'), { subtitle: t('connections.lead') })}
<div class="notice warn">${t('connections.readWarning')}</div>
<section class="block"><div class="block-head"><h2>${t('connections.clients')} <span class="count">${active.length}</span></h2></div>
${active.length === 0 ? h`<p class="empty">${t('connections.empty')}</p>` : h`<div class="stack">${active.map(clientBox)}</div>`}
<p class="muted small">${t('connections.effective')}</p>
${revoked.length > 0 ? h`<details class="plain"><summary>${t('connections.revokedList', { count: revoked.length })}</summary><div class="stack">${revoked.map(clientBox)}</div></details>` : ''}</section>
<section class="block" id="setup"><div class="block-head"><h2>${t('connections.setup')}</h2></div>
<div class="box box-pad">
<label class="field"><span class="label">${t('connections.mcpUrl')}</span>${copyField(i18n, 'mcp-url', resources.mcp)}</label>
<h3>ChatGPT</h3>
<ol class="muted"><li>${i18n.rich('connections.chatgpt.1', { where: h`<code>chatgpt.com/plugins</code>` })}</li><li>${t('connections.chatgpt.2')}</li><li>${t('connections.chatgpt.3')}</li></ol>
<h3>Claude</h3>
<ol class="muted"><li>${t('connections.claude.1')}</li><li>${t('connections.claude.2')}</li><li>${t('connections.claude.3')}</li></ol>
<h3>Claude Code</h3>
<pre class="code">claude mcp add --transport http remora ${resources.mcp}</pre>
<p class="muted">${i18n.rich('connections.claudeCode', { command: h`<code>/mcp</code>` })}</p>
<h3>${t('connections.cli')}</h3>
<p class="muted">${t('connections.cliInstall')}</p>
<pre class="code">curl -fsSL ${RELEASES_URL}/latest/download/${RELEASE_ASSETS.installSh} | sh</pre>
<p class="muted">${t('connections.cliWindows')}</p>
<pre class="code">irm ${RELEASES_URL}/latest/download/${RELEASE_ASSETS.installPs1} | iex</pre>
<p class="muted">${t('connections.cliLogin')}</p>
<pre class="code">remora login ${origin}
remora login ${origin} --device</pre>
<h3>${t('connections.api')}</h3>
<p class="muted">${i18n.rich('connections.apiHelp', { link: h`<a href="/settings#tokens">${t('connections.apiLink')}</a>` })}</p>
<h3>${t('connections.icons')}</h3>
<p class="icons"><a href="/remora-512.png" download><img src="/remora-192.png" alt="" width="40" height="40"></a><a href="/remora-512.png" download>PNG 512</a><a href="/remora-192.png" download>PNG 192</a><a href="/remora-app.svg" download>SVG</a><a href="/remora-badge.svg" download>${t('connections.badge')}</a></p>
<p class="muted small">${t('connections.newClients')}</p>
</div></section>`
  return view(ui, t('connections.title'), 'connections', body)
}

// --- audit -------------------------------------------------------------------------------------------

function actorLabel(ui: Ui, row: AuditRow): string {
  if (row.actor === 'owner') return ui.t('actor.owner')
  if (row.actor === 'host') return ui.t('actor.host')
  if (row.actor === 'hub') return ui.t('actor.hub')
  if (row.actor === OWNER_CLIENT_ID) return ui.t('actor.hubUi')
  return row.actorName
}

function auditOperation(ui: Ui, operation: string): string {
  const grant = /^grant\.set\.(\w+)$/.exec(operation)
  if (grant) return ui.t('op.grant.set', { level: levelLabel(ui, grant[1] as string) })
  const outcome = /^(.+)\.(approved|refused|confirmed|confirmation-denied|requested|deliver|cancelled|finished|proof)$/.exec(operation)
  if (outcome && hasMessage(`op.${outcome[1]}`)) return `${opLabel(ui, outcome[1] as string)} · ${label(ui, 'op.suffix', outcome[2] as string)}`
  return opLabel(ui, operation)
}

async function auditPage(ui: Ui, env: Env, url: URL): Promise<Response> {
  const { t, i18n } = ui
  const hub = hubStub(env)
  const hosts = await hub.listHosts(true)
  const [hubRows, ...hostRows] = await Promise.all([hub.listAudit(300), ...hosts.map(host => hostStub(env, host.hostId).listAudit(300))])
  const names = new Map(hosts.map(host => [host.hostId, host.name]))
  const chains: [string, AuditRow[]][] = [[t('common.hub'), hubRows ?? []], ...hosts.map((host, index): [string, AuditRow[]] => [host.name, hostRows[index] ?? []])]
  const broken = (await Promise.all(chains.map(async ([name, rows]) => [name, await verifyAuditChain(rows)] as const))).filter(([, seq]) => seq !== null)
  const filter = url.searchParams.get('filter')
  const rows = chains.flatMap(([, list]) => list).filter(row => filter !== 'denied' || row.outcome !== 'ok').sort((a, b) => b.at - a.at).slice(0, 300)
  const layerFix: Readonly<Record<string, [MessageKey, Raw]>> = {
    dsh: ['audit.layer.dsh', h`${t('error.fixDsh')}`],
    hub: ['audit.layer.hub', h`<a href="/connections">${t('nav.connections')}</a>`],
    token: ['audit.layer.token', h`<a href="/connections#setup">${t('connections.setup')}</a>`],
  }
  const body = h`${pageHead(t('audit.title'), { subtitle: t('audit.lead') })}
${broken.length === 0 ? flash(t('audit.chainOk'), 'ok') : flash(t('audit.chainBroken', { where: broken.map(([name, seq]) => `${name} #${seq}`).join(', ') }), 'error')}
<div class="block-head"><nav class="tabs-inline" aria-label="${t('audit.filter')}"><a href="/audit"${raw(filter !== 'denied' ? ' aria-current="page"' : '')}>${t('audit.all')}</a><a href="/audit?filter=denied"${raw(filter === 'denied' ? ' aria-current="page"' : '')}>${t('audit.denied')}</a></nav>
<a class="btn small" href="/audit/export.json" download data-testid="hub-audit-export">${t('audit.export')}</a></div>
${rows.length === 0 ? h`<p class="empty">${t('audit.empty')}</p>` : h`<div class="box">${rows.map(row => h`<div class="item top audit-row ${row.outcome}"><div class="item-body">
  <div class="item-title"><span class="tag ${row.outcome === 'ok' ? 'ok' : row.outcome === 'denied' ? 'danger' : 'warn'}">${label(ui, 'audit.outcome', row.outcome)}</span> <span>${auditOperation(ui, row.operation)}</span> <code class="faint">${row.operation}</code></div>
  <div class="item-meta">${join([actorLabel(ui, row), row.hostId ? names.get(row.hostId) ?? row.hostId : null, i18n.time(row.at)])}</div>
  ${row.outcome === 'denied' && row.layer ? h`<details class="plain"><summary>${t('audit.why')}</summary><p class="muted">${hasMessage(`reason.${row.reason}`) ? t(`reason.${row.reason}` as MessageKey) : row.reason ?? ''} ${layerFix[row.layer] ? t(layerFix[row.layer]?.[0] as MessageKey) : ''}</p>${layerFix[row.layer] ? h`<p class="muted small">${t('audit.fixAt')} ${layerFix[row.layer]?.[1]}</p>` : ''}</details>` : ''}
  ${row.outcome !== 'ok' && !row.layer && row.reason ? h`<div class="item-meta faint">${t('audit.reason', { reason: row.reason })}</div>` : ''}
</div></div>`)}</div>`}
<p class="muted small">${i18n.rich('audit.verify', { file: h`<code>remora audit verify --file &lt;file&gt;</code>`, live: h`<code>remora audit verify</code>` })}</p>`
  return view(ui, t('audit.title'), 'audit', body)
}

// --- settings ------------------------------------------------------------------------------------------

async function settingsPage(ui: Ui, env: Env, url: URL, origin: string): Promise<Response> {
  const { t, i18n } = ui
  const hub = hubStub(env)
  const [state, passkeys, tokens, devices, vapidKey] = await Promise.all([hub.state(), hub.listPasskeys(), hub.listPersonalTokens(), hub.listPushDevices(), hub.vapidPublicKey()])
  const resources = resourcesFor(origin)
  const typeLabel: Record<PushType, MessageKey> = { attention: 'push.type.attention', tasks: 'push.type.tasks', hosts: 'push.type.hosts' }
  const notifications = h`<section class="block" id="notifications" data-push data-vapid-key="${vapidKey}"><div class="block-head"><h2>${t('push.title')}</h2></div>
<p class="muted">${t('push.lead')}</p>
<div class="notice warn" data-push-unsupported hidden>${t('push.unsupported')}</div>
<div class="notice" data-push-ios hidden>${t('push.ios')}</div>
<div class="actions"><button class="primary" type="button" data-push-on hidden data-testid="hub-push-on">${t('push.on')}</button><button type="button" data-push-off hidden data-testid="hub-push-off">${t('push.off')}</button></div>
<div data-push-status role="status" hidden></div>
${devices.length === 0 ? h`<p class="empty">${t('push.none')}</p>` : h`<div class="box mt">${devices.map(device => h`<div class="item top" data-push-endpoint="${device.endpoint}" data-testid="hub-push-device"><div class="item-body">
  <div class="item-title">${device.label} <span class="tag" data-this-device hidden>${t('push.thisDevice')}</span>${device.lastError ? h` <span class="tag warn">${device.lastError}</span>` : ''}</div>
  <div class="item-meta">${join([h`${t('push.added')} ${i18n.time(device.createdAt)}`, t('push.lastSent', { when: i18n.relative(device.lastSentAt) })])}</div>
  <form method="post" action="/settings/push/types" class="stack mt">
    <input type="hidden" name="id" value="${device.id}">
    <div>${PUSH_TYPES.map(type => h`<label class="check"><input type="checkbox" name="type" value="${type}"${raw(device.types.includes(type) ? ' checked' : '')}> <span>${t(typeLabel[type])}</span></label>`)}</div>
    <div class="row"><button type="submit" class="small">${t('common.save')}</button></div>
  </form></div>
  <div class="item-actions"><form method="post" action="/settings/push/remove" class="inline"><input type="hidden" name="id" value="${device.id}"><button class="danger small" type="submit">${t('common.remove')}</button></form></div>
</div>`)}</div>
<form method="post" action="/settings/push/test" class="actions"><button type="submit" data-testid="hub-push-test">${t('push.test')}</button></form>`}
</section>`
  const body = h`${message(ui, url)}${pageHead(t('settings.title'))}
${url.searchParams.get('recovered') ? flash(t('settings.recovered'), 'warn') : ''}
<section class="block" id="passkeys"><div class="block-head"><h2>${t('passkeys.title')} <span class="count">${passkeys.length}</span></h2></div>
${passkeys.length < 2 ? flash(t('passkeys.addSecond'), 'warn') : ''}
<div class="box">${passkeys.map(passkey => h`<div class="item"><div class="item-body"><div class="item-title">${passkey.label}</div><div class="item-meta">${join([h`${t('passkeys.added')} ${i18n.time(passkey.createdAt)}`, t('passkeys.lastUsed', { when: i18n.relative(passkey.lastUsedAt) })])}</div></div>
  ${passkeys.length > 1 ? h`<div class="item-actions">${reauthForm('/settings/passkeys/remove', { credentialId: passkey.credentialId }, t('common.remove'), 'danger small')}</div>` : ''}</div>`)}
<form class="item stack" data-add-passkey><label class="field"><span class="label">${t('passkeys.newName')}</span><input name="label" maxlength="60" placeholder="${t('setup.passkeyNamePlaceholder')}" data-device-label></label><div><button class="primary" type="submit" data-busy-label="${t('setup.busy')}">${t('passkeys.add')}</button></div><div data-status role="status" hidden></div></form></div>
<p class="muted small">${t('passkeys.hostsNote')}</p></section>
${notifications}
<section class="block" id="recovery"><div class="block-head"><h2>${t('recovery.title')}</h2></div>
<div class="box"><div class="item"><div class="item-body"><div class="item-title">${t('recovery.left', { left: state.recoveryCodesLeft, total: 10 })}</div><div class="item-meta">${t('recovery.help')}</div></div>
<div class="item-actions">${reauthForm('/settings/recovery', {}, t('recovery.regenerate'), 'small')}</div></div></div>
${state.recoveryCodesLeft <= 3 ? flash(t('recovery.low'), 'warn') : ''}</section>
<section class="block" id="tokens"><div class="block-head"><h2>${t('tokens.title')}</h2></div>
<p class="muted">${t('tokens.lead')}</p>
${tokens.length > 0 ? h`<div class="box mt">${tokens.map(token => h`<div class="item"><div class="item-body"><div class="item-title">${token.name} ${token.scopes.map(scope => h`<span class="tag">${scope}</span>`)}</div>
  <div class="item-meta">${join([token.revokedAt ? t('tokens.revoked') : token.expiresAt < Date.now() ? t('tokens.expired') : t('tokens.until', { when: i18n.relative(token.expiresAt) }), t('passkeys.lastUsed', { when: i18n.relative(token.lastUsedAt) })])}</div></div>
  ${!token.revokedAt && token.expiresAt > Date.now() ? h`<div class="item-actions"><form method="post" action="/settings/tokens/revoke" class="inline"><input type="hidden" name="id" value="${token.id}"><button class="danger small" type="submit">${t('common.revoke')}</button></form></div>` : ''}</div>`)}</div>` : ''}
<div class="box box-pad mt"><h3 class="flush">${t('tokens.new')}</h3>
<form method="post" action="/settings/tokens" class="stack" data-reauth>
  <label class="field"><span class="label">${t('tokens.name')}</span><input name="name" maxlength="60" required placeholder="${t('tokens.namePlaceholder')}" data-testid="hub-token-name"></label>
  <fieldset class="scopes"><legend>${t('tokens.scopes')}</legend>${SCOPES.map(scope => h`<label class="check"><input type="checkbox" name="scope" value="${scope}"${raw(scope === 'dsh.read' ? ' checked' : '')}> <span><span class="mono small">${scope}</span> <span class="muted">${t(`scope.${scope}` as MessageKey)}</span></span></label>`)}</fieldset>
  <label class="field"><span class="label">${t('tokens.expiry')}</span><select name="days"><option value="7">${t('tokens.days', { days: 7 })}</option><option value="30" selected>${t('tokens.days', { days: 30 })}</option><option value="90">${t('tokens.days', { days: 90 })}</option><option value="365">${t('tokens.year')}</option></select></label>
  <div><button class="primary" type="submit" data-testid="hub-token-create">${t('tokens.create')}</button></div>
  <div data-status role="status" hidden></div>
</form>
<p class="muted small">${i18n.rich('tokens.usage', { example: h`<code>curl -X POST -H "Authorization: Bearer &lt;token&gt;" ${resources.api}/status</code>` })}</p></div></section>
<section class="block" id="clients"><div class="block-head"><h2>${t('clients.title')}</h2></div>
<div class="box"><div class="item"><div class="item-body"><div class="item-title">${t('clients.others')} <span class="tag${state.allowOtherClients ? ' warn' : ''}">${state.allowOtherClients ? t('clients.allowed') : t('clients.blocked')}</span></div><div class="item-meta">${t('clients.othersHelp')}</div></div>
<div class="item-actions">${reauthForm('/settings/allow-other-clients', { allow: state.allowOtherClients ? '0' : '1' }, state.allowOtherClients ? t('clients.block') : t('clients.allow'), state.allowOtherClients ? 'small' : 'danger small')}</div></div>
<div class="item"><div class="item-body"><div class="item-title">${t('clients.dcr')} <span class="tag">${dcrEnabled(env) ? t('common.on') : t('common.off')}</span></div><div class="item-meta">${i18n.rich('clients.dcrHelp', { name: h`<code>ENABLE_DCR</code>` })}</div></div></div></div></section>
<section class="block"><div class="block-head"><h2>${t('about.title')}</h2></div>
<div class="box"><dl class="kv"><dt>${t('about.version')}</dt><dd>${HUB_VERSION} · ${t('about.protocol', { version: PROTOCOL_VERSION })}</dd><dt>${t('about.origin')}</dt><dd class="mono">${origin}</dd><dt>${t('about.rpId')}</dt><dd class="mono">${rpIdOf(origin)}</dd>
<dt>MCP</dt><dd class="mono">${resources.mcp}</dd><dt>HTTP API</dt><dd class="mono">${resources.api}/&lt;operation&gt;</dd><dt>${t('about.issuer')}</dt><dd class="mono">${origin}</dd><dt>${t('about.cliId')}</dt><dd class="mono">${CLI_CLIENT_ID}</dd></dl></div>
<p class="muted small">${t('about.domain')}</p>
<div class="actions"><a class="btn small" href="/settings/export.json" download data-testid="hub-settings-export">${t('about.export')}</a><form method="post" action="/auth/logout" class="inline"><button type="submit" class="small">${t('about.logout')}</button></form></div>
<p class="muted small">${i18n.rich('about.exportHelp', { command: h`<code>remora hub export</code>` })}</p></section>`
  return view(ui, t('settings.title'), 'settings', body, ['/js/webauthn.js', '/js/live.js', '/js/push.js'])
}

function onceShown(ui: Ui, title: string, lead: string, value: string, back: string): Response {
  return view(ui, title, 'settings', h`${pageHead(title, { subtitle: lead })}<pre class="codes secret" id="secret" data-testid="hub-secret">${value}</pre>
<div class="actions"><button type="button" data-copy="#secret">${ui.t('common.copy')}</button><a class="btn primary" href="${back}">${ui.t('common.savedBack')}</a></div>`)
}

export function notFound(ui: Ui): Response {
  return html(page({ i18n: ui.i18n, title: ui.t('notFound.title'), narrow: true, path: ui.path, body: h`${pageHead(ui.t('notFound.title'), { subtitle: ui.t('notFound.lead') })}<div class="actions"><a class="btn" href="/">${ui.t('notFound.home')}</a></div>` }), { status: 404 })
}

// --- routing ------------------------------------------------------------------------------------------

async function requireOwner(request: Request, env: Env, url: URL): Promise<OwnerSession | Response> {
  const session = await getSession(request, env)
  if (!session) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`)
  return session
}

/** GET /lang?set=<en|ja|zh|auto>&next=<path>: remember the language and go back. */
function setLanguage(url: URL): Response {
  const chosen = url.searchParams.get('set')
  const next = safeNext(url.searchParams.get('next'), url.origin)
  return redirect(next, { 'set-cookie': langCookie(isLocale(chosen) ? chosen : null) })
}

/** Owner UI routes. Returns null for paths it does not handle. */
export async function handleUi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  const origin = hubOrigin(request, env)
  const hub = hubStub(env)
  const ui = uiFor(request)

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (path === '/lang') return setLanguage(url)
    if (path === '/login') {
      const state = await hub.state()
      return state.setupComplete ? loginPage(ui, url) : redirect('/setup')
    }
    if (path === '/setup') {
      const state = await hub.state()
      return state.setupComplete ? redirect('/') : setupPage(ui, env)
    }
    const known = path === '/' || path === '/attention' || path.startsWith('/attention/') || path === '/connections' || path === '/audit' || path === '/audit/export.json' || path === '/settings' || path === '/settings/export.json' || path.startsWith('/hosts/') || path.startsWith('/tasks/') || path.startsWith('/confirm/')
    if (!known) return null
    if (path === '/') {
      const state = await hub.state()
      if (!state.setupComplete) return redirect('/setup')
    }
    const session = await requireOwner(request, env, url)
    if (session instanceof Response) return session
    if (path === '/') return homePage(ui, env, url, origin)
    if (path === '/attention') return attentionPage(ui, env, url)
    const itemMatch = /^\/attention\/([a-z0-9]{8,64})\/([^/]+)$/.exec(path)
    if (itemMatch) {
      let attentionId: string
      try {
        attentionId = decodeURIComponent(itemMatch[2] as string)
      } catch {
        return notFound(ui)
      }
      return attentionItemPage(ui, env, url, itemMatch[1] as string, attentionId)
    }
    if (path === '/connections') return connectionsPage(ui, env, url, origin)
    if (path === '/audit') return auditPage(ui, env, url)
    if (path === '/settings') return settingsPage(ui, env, url, origin)
    const hostMatch = /^\/hosts\/([a-z0-9]{8,64})$/.exec(path)
    if (hostMatch) return hostPage(ui, env, url, hostMatch[1] as string)
    const sessionMatch = /^\/hosts\/([a-z0-9]{8,64})\/sessions\/([^/]+)$/.exec(path)
    if (sessionMatch) {
      let sessionId: string
      try {
        sessionId = decodeURIComponent(sessionMatch[2] as string)
      } catch {
        return notFound(ui)
      }
      return sessionPage(ui, env, url, sessionMatch[1] as string, sessionId)
    }
    const taskMatch = /^\/tasks\/([a-z0-9-]{8,80})$/.exec(path)
    if (taskMatch) return taskPage(ui, env, url, taskMatch[1] as string)
    const hubApproval = /^\/confirm\/hub\/(hub-[a-z2-7]{8,40})$/.exec(path)
    if (hubApproval) return hubApprovalPage(ui, env, url, hubApproval[1] as string)
    if (path === '/audit/export.json' || path === '/settings/export.json') {
      const audit = path === '/audit/export.json'
      const result = await maintenanceResult(env, audit ? 'audit.export' : 'hub.export', origin)
      return json(result, { headers: { 'content-disposition': `attachment; filename="${audit ? 'remora-audit' : 'remora-hub'}-${new Date().toISOString().slice(0, 10)}.json"`, 'cache-control': 'no-store' } })
    }
    const confirmMatch = /^\/confirm\/([a-z0-9]{8,64})\/([a-z0-9-]{8,80})$/.exec(path)
    if (confirmMatch) return confirmPage(ui, env, url, origin, confirmMatch[1] as string, confirmMatch[2] as string)
    return notFound(ui)
  }

  if (request.method !== 'POST') return null
  const handled = path === '/ops/confirmed' || path.startsWith('/push/') || path.startsWith('/hosts/') || path.startsWith('/attention/') || path.startsWith('/connections/') || path.startsWith('/settings/') || path.startsWith('/confirm/')
  if (!handled) return null
  if (!sameOrigin(request, origin)) return new Response('cross-origin request refused', { status: 403 })
  const session = await getSession(request, env)
  if (!session) return path === '/ops/confirmed' || path.startsWith('/push/') ? json({ error: { code: 'denied', message: 'sign in first' } }, { status: 403 }) : redirect('/login')

  if (path === '/ops/confirmed') return confirmedOperation(env, request)
  if (path === '/push/subscribe' || path === '/push/unsubscribe') return pushEndpoint(ui, env, request, path)
  if (path === '/attention/respond') return attentionRespond(ui, env, request)

  const sessionAct = /^\/hosts\/([a-z0-9]{8,64})\/sessions\/([^/]+)\/(prompt|steer|cancel|compact|model|fork|job-stop|schedule-create|schedule-delete)$/.exec(path)
  if (sessionAct) {
    let sessionId: string
    try {
      sessionId = decodeURIComponent(sessionAct[2] as string)
    } catch {
      return notFound(ui)
    }
    return sessionAction(ui, env, request, sessionAct[1] as string, sessionId, sessionAct[3] as string)
  }

  const deny = /^\/confirm\/(hub|[a-z0-9]{8,64})\/([a-z0-9-]{8,80})\/deny$/.exec(path)
  if (deny) return denyConfirmation(env, deny[1] as string, deny[2] as string)
  const approve = /^\/confirm\/(hub|[a-z0-9]{8,64})\/([a-z0-9-]{8,80})\/approve$/.exec(path)
  if (approve) return approveMaintenance(ui, env, origin, session.fresh, approve[1] as string, approve[2] as string)
  const rotate = /^\/hosts\/([a-z0-9]{8,64})\/rotate-key$/.exec(path)
  if (rotate) return rotateHostKey(ui, env, rotate[1] as string, session.fresh)
  const terminal = /^\/hosts\/([a-z0-9]{8,64})\/terminal$/.exec(path)
  if (terminal) return terminalRequest(ui, env, request, origin, terminal[1] as string)

  const revokeHost = /^\/hosts\/([a-z0-9]{8,64})\/revoke$/.exec(path)
  if (revokeHost) {
    if (!session.fresh) return redirect(`/hosts/${revokeHost[1]}?msg=reauth`)
    const hostId = revokeHost[1] as string
    await revokeHostEverywhere(env, hostId, 'owner')
    return redirect('/?msg=host-revoked')
  }

  const form = await readForm(request)
  switch (path) {
    case '/connections/grant': {
      const level = form.get('level') as GrantLevel
      if (!['none', 'view', 'request', 'full'].includes(level)) return redirect('/connections')
      const widening = level === 'request' || level === 'full'
      if (widening && !session.fresh) return redirect('/connections?msg=reauth')
      const hostId = form.get('hostId') ?? ''
      const live = await hostStub(env, hostId).summary()
      const clientId = form.get('clientId') ?? ''
      const result = await hub.setGrant(clientId, hostId, level, live.ceiling?.level ?? null)
      // Parked tasks of this client that the new grant no longer allows fail now.
      if (result.ok) await refreshParked(env, clientId, [hostId])
      return redirect(`/connections?msg=${result.ok ? 'grant-saved' : `grant-${result.reason}`}`)
    }
    case '/connections/revoke': {
      if (!session.fresh) return redirect('/connections?msg=reauth')
      await revokeClient(env, form.get('clientId') ?? '', origin)
      await refreshParked(env, form.get('clientId') ?? '')
      return redirect('/connections?msg=client-revoked')
    }
    case '/settings/passkeys/remove': {
      if (!session.fresh) return redirect('/settings?msg=reauth#passkeys')
      const removed = await hub.removePasskey(form.get('credentialId') ?? '')
      const msg = removed === 'removed' ? 'passkey-removed' : removed === 'last' ? 'passkey-last' : 'passkey-missing'
      return redirect(`/settings?msg=${msg}#passkeys`)
    }
    case '/settings/recovery': {
      if (!session.fresh) return redirect('/settings?msg=reauth#recovery')
      const codes = await hub.regenerateRecoveryCodes()
      return onceShown(ui, ui.t('recovery.newTitle'), ui.t('recovery.newLead'), codes.join('\n'), '/settings#recovery')
    }
    case '/settings/tokens': {
      if (!session.fresh) return redirect('/settings?msg=reauth#tokens')
      const scopes = form.getAll('scope').filter(scope => (SCOPES as readonly string[]).includes(scope))
      const days = Math.min(365, Math.max(1, Number(form.get('days') ?? '30') || 30))
      const name = (form.get('name') ?? '').trim().slice(0, 60) || ui.t('tokens.defaultName')
      const { token } = await hub.createPersonalToken(name, scopes.length > 0 ? scopes : ['dsh.read'], days * 86_400_000)
      return onceShown(ui, ui.t('tokens.issuedTitle'), ui.t('tokens.issuedLead'), token, '/settings#tokens')
    }
    case '/settings/tokens/revoke':
      await hub.revokePersonalToken(form.get('id') ?? '')
      await refreshParked(env, `pat:${form.get('id') ?? ''}`)
      return redirect('/settings?msg=token-revoked#tokens')
    case '/settings/push/remove':
      await hub.pushUnsubscribe({ id: form.get('id') ?? '' })
      return redirect('/settings?msg=push-removed#notifications')
    case '/settings/push/types':
      await hub.pushSetTypes(form.get('id') ?? '', form.getAll('type').filter((type): type is PushType => (PUSH_TYPES as readonly string[]).includes(type)))
      return redirect('/settings?msg=push-saved#notifications')
    case '/settings/push/test': {
      const outcome = await hub.notify([{ type: 'test', kind: 'test', hostId: null, host: 'Remora', title: '', url: '/settings#notifications' }], origin)
      return redirect(`/settings?msg=${outcome.sent > 0 ? 'push-test-sent' : 'push-test-none'}#notifications`)
    }
    case '/settings/allow-other-clients': {
      if (!session.fresh) return redirect('/settings?msg=reauth#clients')
      const allow = form.get('allow') === '1'
      await hub.setAllowOtherClients(allow)
      await hub.audit({ actor: 'owner', actorName: 'owner', operation: allow ? 'settings.allow-other-clients.on' : 'settings.allow-other-clients.off', hostId: null, outcome: 'ok', layer: null, reason: null })
      return redirect('/settings?msg=settings-saved#clients')
    }
  }
  return notFound(ui)
}

/** Revoke a client on the hub and its OAuth grants in the library. */
async function revokeClient(env: Env, clientId: string, origin: string): Promise<void> {
  const hub = hubStub(env)
  await hub.revokeClient(clientId)
  if (clientId.startsWith('pat:')) return
  const helpers = oauthFor(origin, env).server.getOAuthApi(oauthEnv(env))
  let cursor: string | undefined
  do {
    const page = await helpers.listUserGrants('owner', cursor ? { cursor } : {})
    for (const grant of page.items) if (grant.clientId === clientId) await helpers.revokeGrant(grant.id, 'owner')
    cursor = page.cursor
  } while (cursor)
}

