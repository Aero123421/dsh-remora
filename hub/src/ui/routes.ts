/**
 * The owner's pages: setup, sign-in, inbox, hosts, sessions, tasks,
 * attention, connections, audit log and settings. Server-rendered; the
 * only script is /js/webauthn.js for passkey ceremonies.
 */
import { answerPath, answerRoute, countdownText, pushText } from '../attention.ts'
import type { AuditRow } from '../audit.ts'
import { verifyAuditChain } from '../audit.ts'
import { getSession, rpIdOf, type OwnerSession } from '../auth.ts'
import { FREE_TIER, FREE_TIER_WARN, OWNER_CLIENT_ID, dcrEnabled, hubOrigin, secrets } from '../config.ts'
import type { HostLive, PendingConfirmation } from '../host-do.ts'
import { html, json, readForm, readJson, redirect, sameOrigin } from '../http.ts'
import { hostStub, hubStub } from '../meter.ts'
import { oauthEnv, oauthFor, resourcesFor } from '../oauth.ts'
import { confirmations, finalParams, liveHosts, maintenanceResult, ownerGrant, refreshParked, revokeHostEverywhere, runOperation, type Caller } from '../ops.ts'
import { PUSH_TYPES, type ClientWithGrants, type GrantLevel, type PushType } from '../types.ts'
import { isPushEndpoint, isSubscriptionKey } from '../webpush.ts'
import { safeNext } from '../next.ts'
import { randomToken } from '../util.ts'
import { HUB_VERSION } from '../version.ts'
import {
  CLI_CLIENT_ID, LEVEL_RANK, OWNER_APPROVED_OPERATIONS, PROTOCOL_VERSION, SCOPES,
  type AttentionItem, type Confirmation, type ConfirmationInfo, type HostSummary, type RemoraError, type ScheduleInfo, type SearchHit, type SessionForkResult,
  type HostRotateKeyResult, type SessionGetResult, type SessionSummary, type TaskInfo, type TerminalRunOutput, type WorkspaceSummary,
} from '../vendor/protocol/index.ts'
import { whenFromForm } from './schedule-form.ts'
import { ATTENTION_LABEL, LEVEL_LABEL, STATE_LABEL, dateTime, flash, h, page, raw, reauthForm, relativeTime, visibleText, type NavKey, type Raw } from './layout.ts'

const OWNER: Caller = { clientId: OWNER_CLIENT_ID, clientName: 'ハブの画面', scopes: [...SCOPES], kind: 'owner' }

const MESSAGES: Readonly<Record<string, [string, 'ok' | 'error']>> = {
  'passkey-added': ['パスキーを追加しました。', 'ok'],
  'passkey-removed': ['パスキーを削除しました。ただし、ペアリング済みの DSH ホストは、各ホストの DSH 画面で新しい一覧を承認するまで、削除したパスキーを危険な操作の確認に使える鍵として信頼し続けます。各ホストで確認してください。', 'error'],
  'passkey-last': ['最後の 1 本は削除できません。先に別のパスキーを追加してください。', 'error'],
  'token-revoked': ['個人トークンを取り消しました。', 'ok'],
  'client-revoked': ['接続を取り消しました。', 'ok'],
  'grant-saved': ['付与範囲を保存しました。', 'ok'],
  'grant-above-ceiling': ['DSH 側の上限より広くはできません。上限は DSH の Remora タブで変えてください。', 'error'],
  'grant-ceiling-unknown': ['ホストがまだ一度も接続していないため、上限が分かりません。', 'error'],
  'host-revoked': ['ホストの登録を解除しました。', 'ok'],
  'reauth': ['パスキーでの確認が必要です。もう一度ボタンを押してください。', 'error'],
  'settings-saved': ['設定を保存しました。', 'ok'],
  'sent': ['送信しました。', 'ok'],
  'paired': ['ホストを追加しました。DSH 側で接続が始まるまで少し待ってください。', 'ok'],
  'push-removed': ['通知の登録を削除しました。', 'ok'],
  'push-saved': ['通知の種類を保存しました。', 'ok'],
  'push-test-sent': ['テスト通知を送りました。数秒で届かないときは、端末の通知設定を確かめてください。', 'ok'],
  'push-test-none': ['テスト通知を送れませんでした。通知を受け取るデバイスが登録されていないか、送信に失敗しました。', 'error'],
  'confirmation-denied': ['拒否しました。依頼したクライアントには「拒否された」と伝わります。', 'ok'],
  'confirmation-gone': ['この依頼はもう確認待ちではありません。', 'error'],
  'forked': ['フォークしました。これが新しいセッションです。', 'ok'],
  'job-stopped': ['ジョブを止めました。', 'ok'],
  'job-not-running': ['そのジョブはもう動いていませんでした。', 'ok'],
  'schedule-created': ['スケジュールを追加しました。', 'ok'],
  'schedule-deleted': ['スケジュールを削除しました。', 'ok'],
  'schedule-gone': ['そのスケジュールはもうありませんでした。', 'ok'],
  'approved': ['承認しました。依頼したクライアントが結果を受け取れます（1 時間）。', 'ok'],
  'key-rotated': ['ホスト鍵を更新しました。ホストは新しい鍵でつなぎ直しました。', 'ok'],
}

function message(url: URL): Raw {
  const key = url.searchParams.get('msg') ?? (url.searchParams.get('paired') ? 'paired' : null)
  const entry = key ? MESSAGES[key] : undefined
  return entry ? flash(entry[0], entry[1]) : raw('')
}

function errorFlash(error: RemoraError | undefined, prefix = '失敗しました'): Raw {
  if (!error) return raw('')
  const fix = error.fix ? h` 直す場所: <code>${error.fix}</code>` : ''
  return h`<p class="flash error" role="alert">${prefix}（${error.code}）: ${error.message}${fix}</p>`
}

function view(title: string, nav: NavKey, body: Raw, scripts: string[] = ['/js/webauthn.js', '/js/live.js']): Response {
  return html(page({ title, nav, body, scripts }))
}


const pct = (ratio: number) => `${Math.min(100, Math.round(ratio * 100))}%`

// --- setup and sign-in -------------------------------------------------------------------------

function setupPage(env: Env): Response {
  const configured = (secrets(env).SETUP_TOKEN ?? '').length >= 16
  return html(page({
    title: '初期設定',
    narrow: true,
    scripts: ['/js/webauthn.js'],
    body: h`<img class="mark" src="/remora-mark-light.svg" alt="" width="72" height="72">
<h1>Remora の初期設定</h1>
<p class="lead">このハブのオーナーとして、最初のパスキーを登録します。</p>
${configured ? '' : flash('SETUP_TOKEN が設定されていません（16 文字以上）。Cloudflare のダッシュボードでシークレットを追加してから、このページを開き直してください。', 'error')}
<p class="flash error" data-needs-webauthn hidden>このブラウザはパスキーに対応していません。</p>
<form class="stack" data-setup>
  <label>デプロイ時に決めた SETUP_TOKEN<input name="setupToken" type="password" autocomplete="off" required data-testid="hub-setup-token"></label>
  <label>このパスキーの名前（例: iPhone）<input name="label" maxlength="60" placeholder="パスキー" data-testid="hub-setup-label"></label>
  <button class="primary" type="submit" data-testid="hub-register-passkey">パスキーを登録</button>
  <p data-status hidden></p>
</form>
<section data-after-setup hidden>
  <h2>リカバリーコード</h2>
  <p class="lead">パスキーをなくしたときに 1 回ずつ使えるコードです。<strong>今だけ表示します。</strong>安全な場所に保管してください。</p>
  <pre class="codes" id="recovery" data-recovery-codes data-testid="hub-recovery-codes"></pre>
  <div class="actions"><button type="button" data-copy="#recovery">コピー</button><a class="button primary" href="/" data-testid="hub-recovery-ack">保管したので次へ</a></div>
  <p class="muted">初期設定は完了し、SETUP_TOKEN はもう使えません。続けて 2 本目のパスキーを登録しておくと安心です。</p>
</section>`,
  }))
}

function loginPage(url: URL): Response {
  const error = url.searchParams.get('error')
  return html(page({
    title: 'ログイン',
    narrow: true,
    scripts: ['/js/webauthn.js'],
    body: h`<img class="mark" src="/remora-mark-light.svg" alt="" width="72" height="72">
<h1>Remora</h1>
<p class="lead">DSH を外から操作するためのハブです（非公式）。</p>
<section class="stack">
  <p class="flash error" data-needs-webauthn hidden>このブラウザはパスキーに対応していません。</p>
  ${error === 'recovery' ? flash('リカバリーコードが正しくないか、使用済みです。', 'error') : ''}
  ${error === 'rate' ? flash('試行回数が多すぎます。しばらく待ってください。', 'error') : ''}
  <button class="primary big" type="button" data-login data-next="${safeNext(url.searchParams.get('next'), url.origin)}">パスキーでログイン</button>
  <p data-status hidden></p>
</section>
<details class="recovery">
  <summary>パスキーが使えないとき</summary>
  <form method="post" action="/auth/recovery" class="stack">
    <label>リカバリーコード<input name="code" autocomplete="off" placeholder="xxxx-xxxx-xxxx" required></label>
    <button type="submit">リカバリーコードでログイン</button>
    <p class="muted">使ったコードは無効になります。ログイン後、新しいパスキーを登録してください。</p>
  </form>
</details>`,
  }))
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

function hostCard(entry: { summary: HostSummary; live: HostLive }, clients: ClientWithGrants[]): Raw {
  const { summary, live } = entry
  return h`<a class="card host" href="/hosts/${summary.hostId}">
  <div class="row"><span class="dot ${summary.online ? 'on' : 'off'}" aria-hidden="true"></span><strong>${summary.name}</strong>${live.reportedName && live.reportedName !== summary.name ? h` <span class="muted">（ホストの申告名: ${live.reportedName}）</span>` : ''}
  ${fullAccessOn(summary, clients) ? h`<span class="badge danger">リモート全権</span>` : ''}
  ${summary.killSwitch ? h`<span class="badge danger">緊急停止中</span>` : ''}</div>
  <p class="muted">${summary.online ? '接続中' : `オフライン（最終 ${relativeTime(summary.lastSeenAt)}）`} ・ 上限: ${summary.ceiling ? LEVEL_LABEL[summary.ceiling.level] : '未報告'} ・ 実行中 ${live.running.length} ・ 要対応 ${live.attention.length}</p>
  ${live.duplicateConnections > 0 ? h`<p class="flash error">同じ鍵での同時接続を ${live.duplicateConnections} 回検知しました。鍵の流出が疑われるときは登録を解除して鍵を作り直してください。</p>` : ''}
</a>`
}

function taskRow(task: TaskInfo, hostName: string): Raw {
  return h`<li><a href="/tasks/${task.taskId}"><span class="state ${task.state}">${STATE_LABEL[task.state] ?? task.state}</span> ${hostName} ・ <span class="muted">${relativeTime(task.updatedAt)}</span></a></li>`
}

function countdown(expiresAt: number | null | undefined): Raw {
  if (typeof expiresAt !== 'number') return raw('')
  return h`<span class="countdown${expiresAt <= Date.now() ? ' expired' : ''}" data-expires-at="${expiresAt}" data-testid="hub-countdown">${countdownText(expiresAt)}</span>`
}

/** Approvals first, then whatever expires soonest, then the oldest. */
function byUrgency(a: AttentionItem, b: AttentionItem): number {
  const rank = (item: AttentionItem) => (item.kind === 'approval' ? 0 : item.kind === 'question' || item.kind === 'plan-review' ? 1 : 2)
  return rank(a) - rank(b) || (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER) || (a.createdAt ?? 0) - (b.createdAt ?? 0)
}

/** One line in an inbox (home, host, task pages): what it is, where, how long is left, and a way in. */
function attentionRow(item: AttentionItem, hostName: string): Raw {
  const route = answerRoute(item)
  const action = route === 'passkey' ? '確認して答える' : route === 'remote' ? '答える' : '開く'
  return h`<li class="inbox-item kind-${item.kind}${route === 'expired' ? ' expired' : ''}"${raw(typeof item.expiresAt === 'number' ? ' data-expiring' : '')} data-testid="hub-inbox-item">
  <div class="row"><span class="badge ${item.kind === 'approval' ? 'danger' : 'warn'}">${ATTENTION_LABEL[item.kind] ?? item.kind}</span> <a class="untrusted" href="${answerPath(item.hostId, item.attentionId)}">${item.title}</a></div>
  <div class="row muted">${hostName ? h`<span>${hostName}</span>` : ''} ${countdown(item.expiresAt)} <span>${relativeTime(item.createdAt)}</span>
  ${route === 'expired' ? '' : h`<a class="button small${route === 'dsh-web' ? '' : ' primary'}" href="${answerPath(item.hostId, item.attentionId)}">${action}</a>`}</div>
</li>`
}

/** Operations that wait for the owner's passkey, in words. */
const CONFIRM_LABEL: Readonly<Record<string, string>> = {
  'terminal.run': 'ターミナルでコマンドを実行',
  'host.rotate-key': 'ホスト鍵の更新',
  'audit.export': '監査ログの書き出し',
  'hub.export': 'ハブ設定の書き出し',
}

/** What the owner approves for hub maintenance, in words. */
const MAINTENANCE_EXPLAIN: Readonly<Record<string, string>> = {
  'audit.export': 'ハブとすべてのホストの監査ログ（誰が・いつ・どの操作を・どこへ。本文は含みません）を渡します。受け取った側でハッシュ連鎖を検査できます。',
  'hub.export': 'ハブの設定（ホスト、クライアントと付与範囲、個人トークン・パスキー・通知デバイスの一覧）を渡します。トークンの値、鍵、通知の送り先などの秘密は含みません。',
  'host.rotate-key': 'ホストに新しい鍵を作らせ、古い鍵と新しい鍵の両方の署名を確かめてから、新しい鍵に切り替えます。ホストは新しい鍵でつなぎ直します。',
}

const confirmPath = (hostId: string, confirmationId: string) => `/confirm/${hostId}/${confirmationId}`

/** One request a client parked for the owner's passkey. */
function confirmationRow(item: PendingConfirmation, hostId: string, hostName: string): Raw {
  return h`<li class="inbox-item kind-confirmation" data-expiring data-testid="hub-confirmation-item">
  <div class="row"><span class="badge danger">${ATTENTION_LABEL.confirmation}</span> <a href="${confirmPath(hostId, item.confirmationId)}">${CONFIRM_LABEL[item.operation] ?? item.operation}</a> <span class="muted">${item.clientName} から</span></div>
  <div class="row"><code class="untrusted">${visibleText(item.what).text}</code></div>
  <div class="row muted">${hostName ? h`<span>${hostName}</span>` : ''} ${countdown(item.expiresAt)} <span>${relativeTime(item.createdAt)}</span>
  <a class="button small primary" href="${confirmPath(hostId, item.confirmationId)}">確認する</a></div>
</li>`
}

function confirmationList(entries: { item: PendingConfirmation; hostId: string; name: string }[]): Raw {
  return entries.length === 0 ? raw('') : h`<ul class="list inbox">${entries.map(entry => confirmationRow(entry.item, entry.hostId, entry.name))}</ul>`
}

function inbox(items: AttentionItem[], names: Map<string, string>): Raw {
  return h`<ul class="list inbox">${[...items].sort(byUrgency).map(item => attentionRow(item, names.get(item.hostId) ?? item.hostId))}</ul>`
}

async function homePage(env: Env, url: URL): Promise<Response> {
  const hub = hubStub(env)
  const [state, data, meter] = await Promise.all([hub.state(), overview(env), hub.meterToday()])
  const names = new Map(data.hosts.map(entry => [entry.summary.hostId, entry.summary.name]))
  const attention = data.hosts.flatMap(entry => entry.live.attention)
  const pending = [
    ...data.approvals.map(item => ({ item, hostId: 'hub', name: 'ハブ' })),
    ...data.hosts.flatMap(entry => entry.live.confirmations.map(item => ({ item, hostId: entry.summary.hostId, name: entry.summary.name }))),
  ]
  const waiting = attention.length + pending.length
  const running = data.hosts.flatMap(entry => entry.live.running)
  const recent = data.hosts.flatMap(entry => entry.live.recent).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
  const steps: [boolean, string, string][] = [
    [state.passkeys >= 2, 'パスキーを 2 本登録する', '/settings#passkeys'],
    [data.hosts.length > 0, 'DSH ホストをつなぐ', '/pair'],
    [data.hosts.some(entry => entry.summary.ceiling !== null), 'DSH の Remora タブで権限と範囲を決める', '/connections'],
    [data.clients.some(client => client.kind !== 'pat' && !client.revokedAt), 'AI クライアントをつなぐ', '/connections#setup'],
    [data.hosts.some(entry => entry.live.hadTasks), '最初のタスクを投げる', '/connections#setup'],
  ]
  // Optional: does not keep the checklist open on its own.
  const pushStep: [boolean, string, string] = [state.pushDevices > 0, 'スマホで通知を受け取る（任意。iPhone はホーム画面に追加してから）', '/settings#notifications']
  const meters: [string, number, number][] = [
    ['Worker のリクエスト', meter.workerRequests, FREE_TIER.workerRequests],
    ['Durable Objects のリクエスト', meter.durableObjectRequests, FREE_TIER.durableObjectRequests],
    ['KV の書き込み', meter.kvWrites, FREE_TIER.kvWrites],
  ]
  const body = h`${message(url)}
${steps.every(([done]) => done) ? '' : h`<section class="card"><h2>はじめに</h2><ol class="checklist">${[...steps, pushStep].map(([done, label, href]) => h`<li class="${done ? 'done' : ''}"><a href="${href}">${label}</a></li>`)}</ol>
<p class="muted">iPhone・iPad で通知を受け取るには、Safari の共有ボタンから「ホーム画面に追加」し、ホーム画面の Remora から開いてください（iOS 16.4 以降）。</p></section>`}
<section class="${waiting > 0 ? 'card inbox-section urgent' : ''}" data-testid="hub-home-attention"><h2>要対応 <span class="count">${waiting}</span></h2>
${waiting === 0 ? h`<p class="muted">人の判断を待っているものはありません。</p>` : h`${confirmationList(pending)}${attention.length > 0 ? inbox(attention, names) : ''}`}</section>
<section><h2>実行中 <span class="count">${running.length}</span></h2>
${running.length === 0 ? h`<p class="muted">実行中のタスクはありません。</p>` : h`<ul class="list">${running.map(task => taskRow(task, names.get(task.hostId) ?? task.hostId))}</ul>`}</section>
<section><h2>最近の完了</h2>
${recent.length === 0 ? h`<p class="muted">まだありません。</p>` : h`<ul class="list">${recent.map(task => taskRow(task, names.get(task.hostId) ?? task.hostId))}</ul>`}</section>
<section><h2>ホスト</h2>
<div class="grid">${data.hosts.map(entry => hostCard(entry, data.clients))}
<a class="card add" href="/pair"><strong>＋ ホストを追加</strong><span class="muted">DSH の設定 → Remora タブで確認コードを出してから</span></a></div></section>
<section class="card"><h2>無料枠（今日・UTC）</h2>
${meters.map(([label, used, limit]) => h`<div class="meter ${used / limit >= FREE_TIER_WARN ? 'warn' : ''}"><div class="row"><span>${label}</span><span>${used.toLocaleString('ja-JP')} / ${limit.toLocaleString('ja-JP')}</span></div><progress max="${limit}" value="${Math.min(used, limit)}">${pct(used / limit)}</progress></div>`)}
${meters.some(([, used, limit]) => used / limit >= FREE_TIER_WARN) ? flash('無料枠の 80% を超えました。ホスト側の進行状況の送信間隔を延ばすか、使い方を見直してください。', 'error') : ''}
<p class="muted">ハブ自身が数えた概算です。正確な値は Cloudflare のダッシュボードで確認してください。</p></section>`
  return view('ホーム', 'home', body)
}

// --- hosts and sessions -------------------------------------------------------------------------

async function hostPage(env: Env, url: URL, hostId: string): Promise<Response> {
  const host = await hubStub(env).getHost(hostId)
  if (!host || host.revokedAt) return notFound()
  const live = await hostStub(env, hostId).summary()
  const name = host.name
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
  let content: Raw
  let tools: Raw = raw('')
  if (!live.online) {
    content = h`<p class="muted">ホストがオフラインです。その PC で DSH Web を起動すると、ワークスペースとセッションが表示されます。</p>`
  } else {
    const [workspaces, sessions] = await Promise.all([
      runOperation(env, OWNER, 'workspaces.list', { hostId }),
      runOperation(env, OWNER, 'sessions.list', { hostId, limit: 200 }),
    ])
    if (!workspaces.ok || !sessions.ok) {
      content = h`${errorFlash(!workspaces.ok ? workspaces.error : undefined, 'ワークスペースを読めませんでした')}${errorFlash(!sessions.ok ? sessions.error : undefined, 'セッションを読めませんでした')}`
    } else {
      const list = (workspaces.result as { workspaces?: WorkspaceSummary[] }).workspaces ?? []
      const all = (sessions.result as { sessions?: SessionSummary[] }).sessions ?? []
      const children = (parent: string) => all.filter(session => session.parentSessionId === parent)
      const sessionItem = (session: SessionSummary): Raw => h`<li><a href="/hosts/${hostId}/sessions/${encodeURIComponent(session.sessionId)}">${session.pinned ? '📌 ' : ''}<span class="untrusted">${session.title || '(無題)'}</span></a>
        ${session.running ? h`<span class="badge ok">実行中</span>` : ''} <span class="muted">${relativeTime(session.updatedAt)}</span>
        ${children(session.sessionId).length > 0 ? h`<ul class="sub">${children(session.sessionId).map(sessionItem)}</ul>` : ''}</li>`
      const top = (workspaceId: string | null) => all.filter(session => session.workspaceId === workspaceId && !session.parentSessionId)
      content = h`${list.map(workspace => h`<section class="card"><h3><span class="untrusted">${workspace.name}</span>${workspace.untrusted ? h` <span class="badge warn">未信頼</span>` : ''}</h3>
        <p class="muted mono">${workspace.path ?? ''}</p>
        ${top(workspace.workspaceId).length === 0 ? h`<p class="muted">セッションはありません。</p>` : h`<ul class="list">${top(workspace.workspaceId).map(sessionItem)}</ul>`}</section>`)}
        ${top(null).length > 0 ? h`<section class="card"><h3>ワークスペース外</h3><ul class="list">${top(null).map(sessionItem)}</ul></section>` : ''}`
      tools = h`${await searchSection(env, hostId, live, query)}${terminalSection(hostId, live, list)}`
    }
  }
  const body = h`${message(url)}
<p class="crumbs"><a href="/">ホーム</a> / ホスト</p>
<h1><span class="dot ${live.online ? 'on' : 'off'}" aria-hidden="true"></span> ${name}${live.reportedName && live.reportedName !== name ? h` <span class="muted">（ホストの申告名: ${live.reportedName}）</span>` : ''}</h1>
<p class="muted">${live.online ? '接続中' : `オフライン（最終 ${relativeTime(live.lastSeenAt)}）`} ・ プラグイン ${live.pluginVersion ?? '—'} ・ DSH ${live.dshVersion ?? '—'} ・ 上限 ${live.ceiling ? LEVEL_LABEL[live.ceiling.level] : '未報告'}${live.killSwitch ? ' ・ 緊急停止中' : ''}</p>
${live.attention.length + live.confirmations.length > 0 ? h`<section class="card inbox-section urgent" data-testid="hub-host-attention"><h2>要対応 <span class="count">${live.attention.length + live.confirmations.length}</span></h2>
${confirmationList(live.confirmations.map(item => ({ item, hostId, name: '' })))}${live.attention.length > 0 ? inbox(live.attention, new Map([[hostId, '']])) : ''}</section>` : ''}
${tools}
${content}
<details class="card"><summary>使える操作（${live.operations.length}）</summary><p class="mono small">${live.operations.join(', ') || '—'}</p></details>
${live.online && live.operations.includes('host.rotate-key') ? h`<details class="card"><summary>ホスト鍵の更新</summary>
<p>${MAINTENANCE_EXPLAIN['host.rotate-key']}鍵が漏れた疑いがあるときは、更新ではなく登録を解除して、DSH 側でペアリングし直してください。</p>
${reauthForm(`/hosts/${hostId}/rotate-key`, {}, 'パスキーで確認して鍵を更新')}</details>` : ''}
<details class="card danger-zone"><summary>登録の解除</summary>
<p>このホストの鍵を無効にし、接続を切ります。もう一度使うには DSH 側でペアリングし直します。</p>
${reauthForm(`/hosts/${hostId}/revoke`, {}, 'パスキーで確認して解除', 'danger')}</details>`
  return view(name, 'home', body)
}

const ROLE_LABEL: Readonly<Record<SearchHit['role'], string>> = { title: 'タイトル', user: '依頼', assistant: '返答' }

/** Find words in the sessions of one host (GET ?q=). */
async function searchSection(env: Env, hostId: string, live: HostLive, query: string): Promise<Raw> {
  if (!live.operations.includes('sessions.search')) return raw('')
  const form = h`<form method="get" action="/hosts/${hostId}" class="row" role="search">
  <input name="q" value="${query}" maxlength="200" placeholder="会話を検索（空白区切りの語をすべて含むもの）" aria-label="会話を検索">
  <button type="submit">検索</button>
</form>`
  if (query === '') return h`<section class="card">${form}</section>`
  const outcome = await runOperation(env, OWNER, 'sessions.search', { hostId, query, limit: 30 })
  if (!outcome.ok) return h`<section class="card">${form}${errorFlash(outcome.error, '検索できませんでした')}</section>`
  const result = outcome.result as { hits: SearchHit[]; scanned: number; partial: boolean }
  const hit = (item: SearchHit) => h`<li><a href="/hosts/${hostId}/sessions/${encodeURIComponent(item.sessionId)}"><span class="untrusted">${item.title}</span></a>
  <span class="badge">${ROLE_LABEL[item.role]}${item.turn ? ` ・ ターン ${item.turn}` : ''}</span> <span class="muted">${relativeTime(item.at)}</span>
  <p class="untrusted snippet muted">${item.snippet}</p></li>`
  return h`<section class="card" data-testid="hub-search"><h2>検索結果 <span class="count">${result.hits.length}</span></h2>${form}
${result.hits.length === 0 ? h`<p class="muted">見つかりませんでした。</p>` : h`<ul class="list hits">${result.hits.map(hit)}</ul>`}
<p class="muted">${result.scanned} 件のセッションを新しい順に調べました。${result.partial ? '時間か件数の上限で途中までです。語を足すか、ワークスペースを絞ってください。' : ''}</p></section>`
}

/** Run one shell command in a workspace folder; the hub then asks for a passkey. */
function terminalSection(hostId: string, live: HostLive, workspaces: WorkspaceSummary[]): Raw {
  if (!live.operations.includes('terminal.run')) return raw('')
  const body = live.ceiling?.level !== 'full'
    ? h`<p class="muted">DSH の Remora タブで上限を「リモート全権」にしたときだけ使えます。</p>`
    : workspaces.length === 0
      ? h`<p class="muted">Remora から見えるワークスペースがありません。</p>`
      : h`<form method="post" action="/hosts/${hostId}/terminal" class="stack">
  <label>ワークスペース<select name="cwdWorkspaceId" required>${workspaces.map(workspace => h`<option value="${workspace.workspaceId}">${workspace.name}${workspace.untrusted ? '（未信頼）' : ''}</option>`)}</select></label>
  <textarea name="command" rows="2" maxlength="8000" required placeholder="例: git status" class="mono"></textarea>
  <label>タイムアウト（秒）<input name="timeoutSeconds" type="number" min="1" max="600" value="60"></label>
  <button type="submit" class="danger">次へ（パスキーで確認）</button>
  <p class="muted">次の画面で内容を確かめ、パスキーで確認すると、その PC のワークスペースのフォルダでコマンドを 1 回だけ実行します。DSH のサンドボックスの外で、DSH と同じユーザーとして動きます。</p>
</form>`
  return h`<details class="card"><summary>ターミナル</summary>${body}</details>`
}

async function sessionPage(env: Env, url: URL, hostId: string, sessionId: string): Promise<Response> {
  const host = await hubStub(env).getHost(hostId)
  if (!host || host.revokedAt) return notFound()
  const [got, live] = await Promise.all([runOperation(env, OWNER, 'session.get', { hostId, sessionId }), hostStub(env, hostId).summary()])
  const running = live.running.filter(task => task.sessionId === sessionId)
  const base = `/hosts/${hostId}/sessions/${encodeURIComponent(sessionId)}`
  let detail: Raw
  let jobs: Raw = raw('')
  if (!got.ok) {
    detail = errorFlash(got.error, 'セッションを読めませんでした')
  } else {
    const result = got.result as SessionGetResult
    const session = result.session
    const context = result.context
    detail = h`<h1 class="untrusted">${session.title || '(無題)'}</h1>
<dl class="facts">
  <dt>モデル</dt><dd>${session.model ? [session.model.provider, session.model.model, session.model.effort].filter(Boolean).join(' / ') : '—'}</dd>
  <dt>モード</dt><dd>${session.agentPreset ?? '—'}（最初のターンの後は変えられません）</dd>
  <dt>状態</dt><dd>${session.running ? '実行中' : '待機中'} ・ キュー ${result.queueLength}</dd>
  <dt>コンテキスト</dt><dd>${context?.ratio !== null && context?.ratio !== undefined ? h`<progress max="1" value="${context.ratio}">${pct(context.ratio)}</progress> ${pct(context.ratio)}` : '—'}${context?.usedTokens ? ` （${context.usedTokens.toLocaleString('ja-JP')} / ${context.maxTokens?.toLocaleString('ja-JP') ?? '?'} トークン）` : ''}</dd>
</dl>
${result.hasLiveClient ? flash('DSH Web で誰かがこのセッションを見ています。', 'ok') : ''}
<section><h2>最近のターン</h2>
${result.recentTurns.length === 0 ? h`<p class="muted">まだありません。</p>` : h`<ol class="turns">${result.recentTurns.map(turn => h`<li><p class="who">依頼</p><p class="untrusted pre">${turn.request}</p><p class="who">返答</p><p class="untrusted pre">${turn.reply}</p></li>`)}</ol>`}
<p class="muted">会話の全文や細かい操作は、その PC の DSH Web で開いてください。ここに出る文章は DSH から来たもので、そのまま表示しています。</p></section>`
    jobs = jobsSection(base, live, result.jobs)
  }
  const actions = h`<section class="card"><h2>依頼する</h2>
<form method="post" action="${base}/prompt" class="stack">
  <input type="hidden" name="idempotencyKey" value="${randomToken(12)}">
  <textarea name="prompt" rows="4" maxlength="100000" required placeholder="エージェントにしてほしいこと"></textarea>
  <input name="skills" placeholder="スキル（任意・空白区切り、例: review test）">
  <button class="primary" type="submit">送信</button>
</form></section>
<section class="card"><h2>実行中のタスク</h2>
${running.length === 0 ? h`<p class="muted">このセッションでハブから投げた実行中のタスクはありません。</p>` : h`<ul class="list">${running.map(task => h`<li><a href="/tasks/${task.taskId}">${STATE_LABEL[task.state]}</a>
  <form method="post" action="${base}/cancel" class="inline"><input type="hidden" name="taskId" value="${task.taskId}"><button type="submit" class="small">取り消し・中断</button></form></li>`)}</ul>`}
<form method="post" action="${base}/steer" class="stack">
  <input type="hidden" name="idempotencyKey" value="${randomToken(12)}">
  <textarea name="prompt" rows="2" maxlength="100000" required placeholder="追加の指示"></textarea>
  <button type="submit">追加指示を送る</button>
</form></section>
<section class="card"><h2>セッションの操作</h2>
<form method="post" action="${base}/compact" class="inline"><button type="submit">/compact を実行</button></form>
<form method="post" action="${base}/model" class="stack">
  <div class="row3"><input name="provider" placeholder="プロバイダー（任意）"><input name="model" placeholder="モデル名" required><input name="effort" placeholder="Effort（任意）"></div>
  <button type="submit">モデルを変更</button>
  <p class="muted">DSH はこの選択を新しいセッションの既定値にも保存します。</p>
</form>
${live.operations.includes('session.fork') ? h`<form method="post" action="${base}/fork" class="stack">
  <h3>フォーク</h3>
  <div class="row3"><input name="atTurn" type="number" min="1" placeholder="何ターン目まで（空なら最後まで）"><input name="title" maxlength="200" placeholder="新しいセッションのタイトル（任意）"></div>
  <button type="submit">フォークする</button>
  <p class="muted">指定したターンの終わりまでの会話を写した新しいセッションを、同じワークスペースに作ります。元のセッションは変わりません。</p>
</form>` : ''}</section>`
  const schedules = live.online && live.operations.includes('schedules.list') ? await schedulesSection(env, hostId, sessionId, base, live) : raw('')
  const body = h`${message(url)}<p class="crumbs"><a href="/">ホーム</a> / <a href="/hosts/${hostId}">${host.name}</a> / セッション</p>${detail}${actions}${jobs}${schedules}`
  return view('セッション', 'home', body)
}

const JOB_STATE: Readonly<Record<string, string>> = { running: '実行中', stopping: '停止中', completed: '完了', failed: '失敗', killed: '停止済み' }

/** Background jobs of the session (dev servers, watchers), each with a stop button. */
function jobsSection(base: string, live: HostLive, jobs: SessionGetResult['jobs']): Raw {
  if (!jobs || jobs.length === 0) return raw('')
  const canStop = live.online && live.operations.includes('job.stop')
  return h`<section class="card" data-testid="hub-jobs"><h2>バックグラウンドのジョブ <span class="count">${jobs.length}</span></h2>
<ul class="list">${jobs.map(job => h`<li><span class="badge${job.status === 'running' ? ' ok' : ''}">${JOB_STATE[job.status] ?? job.status}</span> <code class="untrusted">${job.label || job.kind}</code> <span class="muted mono">${job.jobId}</span>
  ${canStop && job.status === 'running' ? h`<form method="post" action="${base}/job-stop" class="inline"><input type="hidden" name="jobId" value="${job.jobId}"><button type="submit" class="small danger">止める</button></form>` : ''}</li>`)}</ul></section>`
}

const WEEKDAY_LABEL = ['', '月', '火', '水', '木', '金', '土', '日']

/** Scheduled prompts of the session, a form to add one, and delete buttons. */
async function schedulesSection(env: Env, hostId: string, sessionId: string, base: string, live: HostLive): Promise<Raw> {
  const listed = await runOperation(env, OWNER, 'schedules.list', { hostId, sessionId })
  const schedules = listed.ok ? (listed.result as { schedules: ScheduleInfo[] }).schedules : []
  const canDelete = live.operations.includes('schedule.delete')
  const item = (schedule: ScheduleInfo) => h`<li><span class="badge${schedule.status === 'active' ? ' ok' : ''}">${schedule.status === 'active' ? '有効' : '終了'}</span> <strong class="untrusted">${schedule.title}</strong> <span class="mono">${schedule.rule}</span>
  <span class="muted">${schedule.nextAt ? `次回 ${dateTime(schedule.nextAt)}` : ''}${schedule.lastDeliveredAt ? ` ・ 前回 ${dateTime(schedule.lastDeliveredAt)}` : ''}${schedule.createdBy ? ` ・ ${schedule.createdBy} が Remora 経由で作成` : ''}</span>
  ${schedule.prompt ? h`<p class="untrusted pre muted">${schedule.prompt}</p>` : ''}
  ${canDelete ? h`<form method="post" action="${base}/schedule-delete" class="inline"><input type="hidden" name="scheduleId" value="${schedule.scheduleId}"><button type="submit" class="small">削除</button></form>` : ''}</li>`
  const form = live.operations.includes('schedule.create') ? h`<form method="post" action="${base}/schedule-create" class="stack">
  <h3>スケジュールを追加</h3>
  <input type="hidden" name="idempotencyKey" value="${randomToken(12)}">
  <input name="title" maxlength="120" required placeholder="名前（例: 朝の CI 確認）">
  <textarea name="prompt" rows="3" maxlength="20000" required placeholder="時間になったらエージェントに送る依頼"></textarea>
  <label>いつ<select name="kind">
    <option value="daily">毎日</option><option value="weekly">毎週</option><option value="every">一定の間隔で</option>
    <option value="after">○分後に 1 回</option><option value="at">日時を決めて 1 回</option><option value="cron">cron 式</option>
  </select></label>
  <div class="row3"><input name="time" placeholder="時刻 HH:mm（毎日・毎週）" pattern="[0-2][0-9]:[0-5][0-9]"><input name="minutes" type="number" min="1" placeholder="分（間隔・○分後）"><input name="timeZone" value="Asia/Tokyo" placeholder="タイムゾーン"></div>
  <div class="weekdays">${[1, 2, 3, 4, 5, 6, 7].map(day => h`<label class="check"><input type="checkbox" name="weekday" value="${day}"> ${WEEKDAY_LABEL[day]}</label>`)}</div>
  <div class="row3"><input name="at" type="datetime-local" aria-label="日時（1 回だけのとき）"><input name="cron" placeholder="cron 式（例: 0 9 * * 1-5）"></div>
  <button type="submit">追加</button>
  <p class="muted">選んだ「いつ」に関係する欄だけが使われます。時間になると DSH がこのセッションに依頼として送ります（その PC で DSH Web が動いているときだけ）。</p>
</form>` : raw('')
  return h`<section class="card" data-testid="hub-schedules"><h2>スケジュール <span class="count">${schedules.length}</span></h2>
${listed.ok ? '' : errorFlash(listed.error, 'スケジュールを読めませんでした')}
${schedules.length === 0 ? h`<p class="muted">このセッションのスケジュールはありません。</p>` : h`<ul class="list">${schedules.map(item)}</ul>`}
${form}</section>`
}

async function sessionAction(env: Env, request: Request, hostId: string, sessionId: string, action: string): Promise<Response> {
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
      if (!when.ok) return view('入力を確かめてください', 'home', h`${flash(when.message, 'error')}<p><a class="button" href="${base}">戻る</a></p>`)
      outcome = await runOperation(env, OWNER, 'schedule.create', { hostId, sessionId, title: (form.get('title') ?? '').trim(), prompt: form.get('prompt') ?? '', when: when.when, idempotencyKey: form.get('idempotencyKey') || randomToken(12) })
      if (outcome.ok) return redirect(`${base}?msg=schedule-created`)
      break
    }
    case 'schedule-delete':
      outcome = await runOperation(env, OWNER, 'schedule.delete', { hostId, sessionId, scheduleId: form.get('scheduleId') ?? '' })
      if (outcome.ok) return redirect(`${base}?msg=${(outcome.result as { deleted: boolean }).deleted ? 'schedule-deleted' : 'schedule-gone'}`)
      break
    default:
      return notFound()
  }
  if (outcome.ok) return redirect(`${base}?msg=sent`)
  return view('失敗しました', 'home', h`${errorFlash(outcome.error)}<p><a class="button" href="${base}">戻る</a></p>`)
}

// --- tasks and attention --------------------------------------------------------------------------

async function taskPage(env: Env, url: URL, taskId: string): Promise<Response> {
  const got = await runOperation(env, OWNER, 'task.get', { taskId })
  if (!got.ok) return view('タスク', 'home', h`<p class="crumbs"><a href="/">ホーム</a> / タスク</p>${errorFlash(got.error, 'タスクを読めませんでした')}`)
  const task = got.result as TaskInfo
  const body = h`${message(url)}<p class="crumbs"><a href="/">ホーム</a> / <a href="/hosts/${task.hostId}">ホスト</a> / タスク</p>
<h1>タスク <span class="state ${task.state}">${STATE_LABEL[task.state] ?? task.state}</span></h1>
<dl class="facts"><dt>ID</dt><dd class="mono">${task.taskId}</dd><dt>作成</dt><dd>${dateTime(task.createdAt)}</dd><dt>更新</dt><dd>${dateTime(task.updatedAt)}</dd>
${task.sessionId ? h`<dt>セッション</dt><dd><a href="/hosts/${task.hostId}/sessions/${encodeURIComponent(task.sessionId)}">開く</a></dd>` : ''}</dl>
${task.hasLiveClient ? flash('DSH Web で誰かがこのセッションを見ています。', 'ok') : ''}
${errorFlash(task.error, 'エラー')}
${task.attention && task.attention.length > 0 ? h`<section><h2>要対応</h2><ul class="list">${task.attention.map(item => attentionRow(item, ''))}</ul></section>` : ''}
${task.result ? h`<section><h2>最後の返答</h2><div class="untrusted pre card">${task.result.reply ?? '（なし）'}</div>
${task.result.changes && task.result.changes.length > 0 ? h`<h2>変更ファイル</h2><ul class="list mono">${task.result.changes.map(change => h`<li>${change.status} ${change.path}</li>`)}</ul>` : ''}
${task.result.deliverables && task.result.deliverables.length > 0 ? h`<h2>成果物</h2><ul class="list">${task.result.deliverables.map(item => h`<li class="untrusted">${item.title}</li>`)}</ul>` : ''}</section>` : ''}
${task.state === 'parked' ? h`<p class="muted">ホストがオフラインのため保留しています。ホストが 1 時間以内に接続すると届けます。</p>` : ''}`
  return view('タスク', 'home', body)
}

/** Why an attention item cannot be answered from the hub, and what to do instead. */
const NOT_ANSWERABLE: Readonly<Record<string, string>> = {
  question: 'DSH の質問ツール（tool-ask-user）が既定の legacy モードのため、外から答えられません。DSH Web で答えるか、DSH の設定で tool-ask-user を timed に切り替えると、次の質問からここで答えられます。',
  'plan-review': 'このプランの確認には外から答えられません。DSH Web で承認するか差し戻してください。',
  approval: 'この承認にはハブから答えられません（DSH の Remora タブで遠隔からの回答がオフになっているか、プラグインが古い版です）。DSH Web で承認・拒否してください。',
  'goal-stopped': 'ゴールが止まっています。DSH Web で再開するか解除してください。',
  'login-expired': 'プロバイダーへのログインが切れています。その PC の DSH で再ログインしてください。',
}

interface CardHost {
  hostId: string
  name: string
  online: boolean
  /** The plugin serves approval.respond. */
  canApprove: boolean
}

/** One item with everything needed to answer it from the hub. */
function attentionCard(item: AttentionItem, host: CardHost, single = false): Raw {
  const route = answerRoute(item)
  const expiring = typeof item.expiresAt === 'number'
  const head = h`<div class="row"><span class="badge ${item.kind === 'approval' ? 'danger' : 'warn'}">${ATTENTION_LABEL[item.kind] ?? item.kind}</span> ${countdown(item.expiresAt)} <span class="muted">${relativeTime(item.createdAt)}</span>
  ${single ? '' : h`<a class="small" href="${answerPath(item.hostId, item.attentionId)}">この項目だけを開く</a>`}</div>`
  const what = item.kind === 'approval'
    ? h`<dl class="facts">
  <dt>求められている操作</dt><dd class="untrusted"><strong>${item.title}</strong></dd>
  ${item.detail ? h`<dt>理由</dt><dd class="untrusted pre">${item.detail}</dd>` : ''}
  <dt>セッション</dt><dd><a class="mono" href="/hosts/${host.hostId}/sessions/${encodeURIComponent(item.sessionId)}">${item.sessionId}</a></dd>
  <dt>ホスト</dt><dd>${host.name} <span class="muted mono">${host.hostId}</span></dd>
</dl>`
    : h`<p class="untrusted"><strong>${item.title}</strong></p>
  ${item.detail ? h`${item.kind === 'plan-review' ? h`<p class="who">プラン</p>` : ''}<div class="untrusted pre">${item.detail}</div>` : ''}`
  let answer: Raw
  if (route === 'expired') {
    answer = h`<p class="flash error">期限が切れました。DSH は回答なしで続行しました（承認は拒否として扱われます）。</p>`
  } else if (route === 'dsh-web') {
    answer = h`<p class="muted not-answerable">${NOT_ANSWERABLE[item.kind] ?? 'この項目には外から答えられません。DSH Web で対応してください。'}</p>`
  } else if (!host.online) {
    answer = h`<p class="muted">ホストがオフラインのため、今は答えられません。</p>`
  } else if (route === 'passkey') {
    const params = { hostId: host.hostId, sessionId: item.sessionId, attentionId: item.attentionId }
    answer = host.canApprove
      ? h`<div class="confirm-preview"><p>パスキーで署名する内容（DSH ホストが検証します）:</p>
  <dl class="facts"><dt>操作</dt><dd class="mono">approval.respond</dd><dt>ホスト</dt><dd class="mono">${host.hostId}</dd>
  <dt>パラメータ</dt><dd><pre class="codes">${JSON.stringify({ ...params, answer: { approve: '許可なら true、拒否なら false' } }, null, 2)}</pre></dd></dl></div>
<form data-confirm-op="approval.respond" data-host="${host.hostId}" data-params="${JSON.stringify(params)}" data-done="/attention?msg=sent" class="actions">
  <button class="primary" type="submit" data-approve="true" data-testid="hub-approval-allow">パスキーで確認して今回だけ許可</button>
  <button class="danger" type="submit" data-approve="false" data-testid="hub-approval-reject">パスキーで確認して拒否</button>
  <p data-status hidden></p>
</form>`
      : h`<p class="muted not-answerable">このホストのプラグインは遠隔からの承認に対応していません。DSH Web で承認・拒否してください。</p>`
  } else if (item.kind === 'plan-review') {
    answer = h`<form method="post" action="/attention/respond" class="stack">
  <input type="hidden" name="hostId" value="${host.hostId}"><input type="hidden" name="sessionId" value="${item.sessionId}"><input type="hidden" name="attentionId" value="${item.attentionId}">
  <textarea name="text" rows="2" placeholder="差し戻す理由や追加の指示（任意）"></textarea>
  <div class="actions"><button class="primary" type="submit" name="approve" value="true" data-testid="hub-plan-approve">プランを承認</button><button type="submit" name="approve" value="false" data-testid="hub-plan-reject">差し戻す</button></div>
</form>`
  } else {
    answer = h`<form method="post" action="/attention/respond" class="stack">
  <input type="hidden" name="hostId" value="${host.hostId}"><input type="hidden" name="sessionId" value="${item.sessionId}"><input type="hidden" name="attentionId" value="${item.attentionId}">
  ${(item.options ?? []).map(option => h`<label class="check"><input type="radio" name="optionId" value="${option.id}"> <span class="untrusted">${option.label}</span></label>`)}
  <textarea name="text" rows="2" placeholder="自由記述の回答（任意）"></textarea>
  <button class="primary" type="submit" data-testid="hub-question-answer">回答する</button>
</form>`
  }
  return h`<article class="card attention-item kind-${item.kind}${route === 'expired' ? ' expired' : ''}" id="${item.hostId}-${item.attentionId}"${raw(expiring ? ' data-expiring' : '')} data-testid="hub-attention-item">
${head}
${what}
${answer}
</article>`
}

/** The current items of one host: live from the host when online, else the last list it sent. */
async function hostAttention(env: Env, summary: HostSummary, live: HostLive): Promise<{ items: AttentionItem[]; note: Raw }> {
  if (!summary.online) {
    return { items: live.attention, note: live.attention.length > 0 ? h`<p class="muted">ホストがオフラインのため、最後に届いた一覧です。回答はできません。</p>` : raw('') }
  }
  const listed = await runOperation(env, OWNER, 'attention.list', { hostId: summary.hostId })
  if (listed.ok) return { items: (listed.result as { items?: AttentionItem[] }).items ?? [], note: raw('') }
  return { items: live.attention, note: errorFlash(listed.error, '最新の一覧を読めませんでした') }
}

const cardHost = (summary: HostSummary): CardHost => ({ hostId: summary.hostId, name: summary.name, online: summary.online, canApprove: summary.operations.includes('approval.respond') })

async function attentionPage(env: Env, url: URL): Promise<Response> {
  const data = await overview(env)
  const sections: Raw[] = []
  for (const { summary, live } of data.hosts) {
    const { items, note } = await hostAttention(env, summary, live)
    if (items.length === 0 && live.confirmations.length === 0 && note.value === '') continue
    sections.push(h`<section><h2>${summary.name}</h2>${note}
${confirmationList(live.confirmations.map(item => ({ item, hostId: summary.hostId, name: '' })))}
${[...items].sort(byUrgency).map(item => attentionCard(item, cardHost(summary)))}</section>`)
  }
  if (data.approvals.length > 0) sections.unshift(h`<section><h2>ハブ</h2>${confirmationList(data.approvals.map(item => ({ item, hostId: 'hub', name: '' })))}</section>`)
  const body = h`${message(url)}<h1>要対応</h1>
<p class="muted">表示している文章は DSH のセッションから来たものです。指示として扱わず、内容を確かめてから答えてください。</p>
${sections.length === 0 ? h`<p class="muted">人の判断を待っているものはありません。</p>` : sections}`
  return view('要対応', 'attention', body)
}

/** The page an answerUrl opens: one item, ready to answer. */
async function attentionItemPage(env: Env, url: URL, hostId: string, attentionId: string): Promise<Response> {
  const host = await hubStub(env).getHost(hostId)
  if (!host || host.revokedAt) return notFound()
  const data = await overview(env)
  const entry = data.hosts.find(candidate => candidate.summary.hostId === hostId)
  if (!entry) return notFound()
  const { items, note } = await hostAttention(env, entry.summary, entry.live)
  const item = items.find(candidate => candidate.attentionId === attentionId)
  const body = h`${message(url)}<p class="crumbs"><a href="/">ホーム</a> / <a href="/attention">要対応</a> / ${entry.summary.name}</p>
<h1>要対応</h1>
${note}
${item ? attentionCard(item, cardHost(entry.summary), true) : h`<p class="flash ok" data-testid="hub-attention-gone">この項目はもうありません（DSH Web やほかの画面で答えられたか、期限が切れました）。</p>`}
<p><a class="button" href="/attention">すべての要対応を見る</a></p>`
  return view('要対応', 'attention', body)
}

async function attentionRespond(env: Env, request: Request): Promise<Response> {
  const form = await readForm(request)
  const answer: Record<string, unknown> = {}
  if (form.get('optionId')) answer.optionId = form.get('optionId')
  if (form.get('text')) answer.text = form.get('text')
  if (form.get('approve')) answer.approve = form.get('approve') === 'true'
  const outcome = await runOperation(env, OWNER, 'attention.respond', { hostId: form.get('hostId') ?? '', sessionId: form.get('sessionId') ?? '', attentionId: form.get('attentionId') ?? '', answer })
  if (outcome.ok) return redirect('/attention?msg=sent')
  return view('失敗しました', 'attention', h`${errorFlash(outcome.error)}<p><a class="button" href="/attention">戻る</a></p>`)
}

// --- passkey confirmations of parked requests -------------------------------------------------

const CONFIRMATION_STATE: Readonly<Record<string, string>> = {
  pending: '確認待ち', running: '実行中', done: '完了', failed: '失敗', denied: '拒否しました', expired: '期限切れ',
}

function terminalOutput(output: TerminalRunOutput): Raw {
  const status = output.timedOut ? 'タイムアウトで止めました' : output.exitCode === null ? `シグナル ${output.signal ?? '?'} で終了` : `終了コード ${output.exitCode}`
  return h`<dl class="facts"><dt>結果</dt><dd><span class="badge${output.exitCode === 0 ? ' ok' : ' danger'}">${status}</span> <span class="muted">${(output.durationMs / 1000).toFixed(1)} 秒</span></dd></dl>
<p class="who">標準出力</p><div class="untrusted pre card" data-testid="hub-terminal-stdout">${output.stdout || '（なし）'}</div>
${output.stderr ? h`<p class="who">標準エラー出力</p><div class="untrusted pre card" data-testid="hub-terminal-stderr">${output.stderr}</div>` : ''}
${output.truncated ? h`<p class="muted">出力が長いため一部を省きました。</p>` : ''}
<p class="muted">出力は DSH ホストでシークレットらしい文字列を伏せてから送られています。</p>`
}

/** JSON with every non-ASCII character escaped (`\u202e`), so no invisible character reaches the page. */
function asciiJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** The page a confirmUrl opens: what a client asked to run, and the passkey button. */
async function confirmPage(env: Env, url: URL, origin: string, hostId: string, confirmationId: string): Promise<Response> {
  const host = await hubStub(env).getHost(hostId)
  if (!host || host.revokedAt) return notFound()
  const [item, live] = await Promise.all([confirmations(env, hostId).view(confirmationId, origin), hostStub(env, hostId).summary()])
  if (!item) return notFound()
  const params = item.params
  const crumbs = h`<p class="crumbs"><a href="/">ホーム</a> / <a href="/hosts/${hostId}">${host.name}</a> / パスキーでの確認</p>`
  const requester = item.clientId === OWNER_CLIENT_ID ? 'ハブの画面（あなた）' : `${visibleText(item.clientName).text}（${item.clientId}）`
  const command = typeof params.command === 'string' ? visibleText(params.command) : null
  let workspace: Raw = h`<span class="mono">${String(params.cwdWorkspaceId ?? '')}</span>`
  if (item.state === 'pending' && live.online && typeof params.cwdWorkspaceId === 'string') {
    const listed = await runOperation(env, OWNER, 'workspaces.list', { hostId })
    const found = listed.ok ? ((listed.result as { workspaces?: WorkspaceSummary[] }).workspaces ?? []).find(entry => entry.workspaceId === params.cwdWorkspaceId) : undefined
    if (found) workspace = h`<span class="untrusted">${found.name}</span>${found.untrusted ? h` <span class="badge warn">未信頼</span>` : ''} <span class="muted mono">${found.path ?? ''}</span>`
  }
  const facts = h`<dl class="facts">
  <dt>操作</dt><dd>${CONFIRM_LABEL[item.operation] ?? item.operation} <span class="muted mono">${item.operation}</span></dd>
  <dt>依頼したもの</dt><dd>${requester}</dd>
  <dt>ホスト</dt><dd>${host.name} <span class="muted mono">${hostId}</span></dd>
  ${command ? h`<dt>コマンド</dt><dd><pre class="command untrusted" dir="ltr" data-testid="hub-confirm-command">${command.text}</pre>${command.hidden ? h`<p class="flash error" data-testid="hub-confirm-hidden">見えない文字（制御文字・文字の向きを変える文字・幅のない文字）が含まれています。⟦U+…⟧ の位置にあります。意図したものでなければ実行しないでください。</p>` : ''}</dd>` : ''}
  ${params.cwdWorkspaceId !== undefined ? h`<dt>場所</dt><dd>${workspace}</dd>` : ''}
  ${typeof params.timeoutMs === 'number' ? h`<dt>タイムアウト</dt><dd>${Math.round(params.timeoutMs / 1000)} 秒</dd>` : ''}
  <dt>状態</dt><dd><span class="state ${item.state}" data-testid="hub-confirm-state">${CONFIRMATION_STATE[item.state] ?? item.state}</span> <span class="muted">${dateTime(item.createdAt)}</span></dd>
</dl>`
  let outcome: Raw
  let refreshSeconds: number | undefined
  switch (item.state) {
    case 'pending':
      if (OWNER_APPROVED_OPERATIONS.has(item.operation)) {
        outcome = h`<article class="card attention-item kind-confirmation" data-expiring>
<div class="row"><span class="badge danger">${ATTENTION_LABEL.confirmation}</span> ${countdown(item.expiresAt)}</div>
<p>${MAINTENANCE_EXPLAIN[item.operation] ?? ''}</p>
${live.online ? reauthForm(`${confirmPath(hostId, item.confirmationId)}/approve`, {}, 'パスキーで確認して承認', 'danger') : h`<p class="muted">ホストがオフラインのため、今は実行できません。</p>`}
<form method="post" action="${confirmPath(hostId, item.confirmationId)}/deny" class="actions"><button type="submit" data-testid="hub-confirm-deny">拒否する</button></form>
</article>`
        break
      }
      outcome = !live.online
        ? h`<p class="muted">ホストがオフラインのため、今は実行できません。期限までにホストがつながれば実行できます。</p>`
        : h`<div class="confirm-preview"><p>パスキーで署名する内容（DSH ホストが検証します）:</p>
<pre class="codes">${asciiJson(finalParams(item.operation, params, hostId), 2)}</pre></div>
<form data-confirm-op="${item.operation}" data-host="${hostId}" data-params="${asciiJson(params)}" data-pending="${item.confirmationId}" data-done="${confirmPath(hostId, item.confirmationId)}" class="actions">
  <button class="danger" type="submit" data-testid="hub-confirm-run">パスキーで確認して実行</button>
  <p data-status hidden></p>
</form>`
      outcome = h`<article class="card attention-item kind-confirmation" data-expiring>
<div class="row"><span class="badge danger">${ATTENTION_LABEL.confirmation}</span> ${countdown(item.expiresAt)}</div>
<p>内容を確かめてください。AI が組み立てたコマンドは、見た目と違う動きをすることがあります。分からないときは実行しないでください。</p>
${outcome}
<form method="post" action="${confirmPath(hostId, item.confirmationId)}/deny" class="actions"><button type="submit" data-testid="hub-confirm-deny">拒否する</button></form>
</article>`
      break
    case 'running':
      refreshSeconds = 3
      outcome = h`<p class="flash ok" role="status">ホストで実行しています。終わるとこのページに結果が出ます（自動で更新します）。</p>`
      break
    case 'done':
      if (item.operation === 'host.rotate-key' && item.result) {
        const rotated = item.result as HostRotateKeyResult
        outcome = h`<p class="flash ok" role="status">ホスト鍵を更新しました。新しい鍵の指紋: <code>${rotated.publicKeyFingerprint}</code>（${dateTime(rotated.rotatedAt)}）</p>`
        break
      }
      outcome = item.result === undefined
        ? h`<p class="muted">完了しました。出力は 1 時間を過ぎたので消しました（ハブには残しません）。</p>`
        : item.operation === 'terminal.run' && item.result && typeof item.result === 'object'
          ? terminalOutput(item.result as TerminalRunOutput)
          : h`<pre class="untrusted pre card">${JSON.stringify(item.result, null, 2)}</pre>`
      break
    case 'failed':
      outcome = errorFlash(item.error, '実行できませんでした')
      break
    case 'denied':
      outcome = h`<p class="muted">この依頼は拒否しました。</p>`
      break
    default:
      outcome = h`<p class="muted">確認されないまま期限が切れました。必要なら、もう一度依頼してください。</p>`
  }
  const body = h`${message(url)}${crumbs}<h1>パスキーでの確認</h1>${facts}${outcome}`
  return html(page({ title: 'パスキーでの確認', nav: 'attention', body, scripts: ['/js/webauthn.js', '/js/live.js'], ...(refreshSeconds ? { refreshSeconds } : {}) }))
}

async function denyConfirmation(env: Env, hostId: string, confirmationId: string): Promise<Response> {
  const denied = hostId === 'hub' ? await hubStub(env).decideApproval(confirmationId, false) : await confirmations(env, hostId).deny(confirmationId)
  return redirect(`${confirmPath(hostId, confirmationId)}?msg=${denied ? 'confirmation-denied' : 'confirmation-gone'}`)
}

/** /confirm/hub/<id>: a client asks for hub maintenance (an export); the owner approves with a passkey re-authentication. */
async function hubApprovalPage(env: Env, url: URL, id: string): Promise<Response> {
  const row = await hubStub(env).approvalFor(id)
  if (!row) return notFound()
  const facts = h`<dl class="facts">
  <dt>操作</dt><dd>${CONFIRM_LABEL[row.operation] ?? row.operation} <span class="muted mono">${row.operation}</span></dd>
  <dt>依頼したもの</dt><dd>${visibleText(row.clientName).text}（${row.clientId}）</dd>
  <dt>状態</dt><dd><span class="state ${row.state}" data-testid="hub-confirm-state">${CONFIRMATION_STATE[row.state] ?? row.state}</span> <span class="muted">${dateTime(row.createdAt)}</span></dd>
</dl>`
  const path = confirmPath('hub', id)
  const outcome = row.state === 'pending'
    ? h`<article class="card attention-item kind-confirmation" data-expiring>
<div class="row"><span class="badge danger">${ATTENTION_LABEL.confirmation}</span> ${countdown(row.expiresAt)}</div>
<p>${MAINTENANCE_EXPLAIN[row.operation] ?? ''}</p>
<p class="muted">承認すると、依頼したクライアントが 1 時間だけ結果を受け取れます。ハブは結果を保存せず、受け取りのたびに作ります。</p>
${reauthForm(`${path}/approve`, {}, 'パスキーで確認して承認', 'danger')}
<form method="post" action="${path}/deny" class="actions"><button type="submit" data-testid="hub-confirm-deny">拒否する</button></form>
</article>`
    : row.state === 'done' ? h`<p class="flash ok">承認済みです（${row.decidedAt ? dateTime(row.decidedAt) : ''}）。</p>`
      : row.state === 'denied' ? h`<p class="muted">この依頼は拒否しました。</p>`
        : h`<p class="muted">承認されないまま期限が切れました。</p>`
  const body = h`${message(url)}<p class="crumbs"><a href="/">ホーム</a> / <a href="/attention">要対応</a> / ハブ</p><h1>パスキーでの確認</h1>${facts}${outcome}`
  return view('パスキーでの確認', 'attention', body)
}

type Outcome = { ok: true } | { ok: false; error: RemoraError }

/** POST /confirm/<hub|host>/<id>/approve, after a fresh passkey re-authentication. */
async function approveMaintenance(env: Env, origin: string, fresh: boolean, where: string, id: string): Promise<Response> {
  const path = confirmPath(where, id)
  if (!fresh) return redirect(`${path}?msg=reauth`)
  if (where === 'hub') {
    const decided = await hubStub(env).decideApproval(id, true)
    return redirect(`${path}?msg=${decided ? 'approved' : 'confirmation-gone'}`)
  }
  const ran = (await hostStub(env, where).approveRun(id, origin)) as Outcome
  return ran.ok ? redirect(path) : view('失敗しました', 'attention', h`${errorFlash(ran.error)}<p><a class="button" href="${path}">戻る</a></p>`)
}

/** The host page's "rotate the key" button (the owner is present: nothing to park). */
async function rotateHostKey(env: Env, hostId: string, fresh: boolean): Promise<Response> {
  if (!fresh) return redirect(`/hosts/${hostId}?msg=reauth`)
  const outcome = (await hostStub(env, hostId).rotateKey()) as Outcome
  if (outcome.ok) return redirect(`/hosts/${hostId}?msg=key-rotated`)
  return view('失敗しました', 'home', h`${errorFlash(outcome.error, '鍵を更新できませんでした')}<p><a class="button" href="/hosts/${hostId}">戻る</a></p>`)
}

/** The host page's terminal form: park the command, then confirm it on its page. */
async function terminalRequest(env: Env, request: Request, origin: string, hostId: string): Promise<Response> {
  const form = await readForm(request)
  const seconds = Math.min(600, Math.max(1, Math.round(Number(form.get('timeoutSeconds') || '60')) || 60))
  const outcome = await runOperation(env, OWNER, 'terminal.run', { hostId, command: form.get('command') ?? '', cwdWorkspaceId: form.get('cwdWorkspaceId') ?? '', timeoutMs: seconds * 1000 }, { origin })
  if (outcome.ok) return redirect(confirmPath(hostId, (outcome.result as ConfirmationInfo).confirmationId))
  return view('失敗しました', 'home', h`${errorFlash(outcome.error)}<p><a class="button" href="/hosts/${hostId}">戻る</a></p>`)
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
    const grant = pending.clientId === OWNER_CLIENT_ID ? ownerGrant() : (await hubStub(env).clientStanding(pending.clientId, hostId)).grant
    const ran = await host.run(body.pendingId, { requestId, confirmation, grant, origin: hubOrigin(request, env) })
    return ran.ok ? json({ ok: true, result: ran.result }) : json({ error: ran.error }, { status: 400 })
  }
  const outcome = await runOperation(env, OWNER, operation, finalParams(operation, raw, hostId), { confirmation, requestId })
  return outcome.ok ? json({ ok: true, result: outcome.result }) : json({ error: outcome.error }, { status: 400 })
}

/** JSON endpoints used by /js/push.js to store or drop this device's subscription. */
async function pushEndpoint(env: Env, request: Request, path: string): Promise<Response> {
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
  const label = typeof body.label === 'string' && body.label.trim() ? pushText(body.label, 60) : 'このデバイス'
  const stored = await hub.pushSubscribe({ endpoint, p256dh, auth, label })
  if ('error' in stored) return json({ error: { code: 'conflict', message: 'Too many devices; remove one first.' } }, { status: 409 })
  return json({ ok: true, id: stored.id })
}

// --- connections -------------------------------------------------------------------------------------

async function connectionsPage(env: Env, url: URL, origin: string): Promise<Response> {
  const data = await overview(env)
  const resources = resourcesFor(origin)
  const clients = data.clients
  const levelsFor = (summary: HostSummary): GrantLevel[] => {
    const ceiling = summary.ceiling ? LEVEL_RANK[summary.ceiling.level] : 0
    return (['none', 'view', 'request', 'full'] as GrantLevel[]).filter(level => level === 'none' || level === 'view' || LEVEL_RANK[level] <= ceiling)
  }
  const clientCard = (client: ClientWithGrants): Raw => h`<article class="card${client.revokedAt ? ' revoked' : ''}">
  <div class="row"><strong>${client.name}</strong>${client.domain ? h` <span class="muted">${client.domain}</span>` : ''}${client.revokedAt ? h` <span class="badge">取り消し済み</span>` : ''}</div>
  <p class="muted">${{ cimd: 'CIMD', dcr: '動的登録', cli: 'CLI', pat: '個人トークン' }[client.kind]} ・ 送り先 ${client.redirectHost ?? '—'} ・ 最終利用 ${relativeTime(client.lastUsedAt)}</p>
  ${client.revokedAt ? '' : h`<table class="grants"><tbody>${data.hosts.map(({ summary }) => {
    const setting = client.grants.find(grant => grant.hostId === summary.hostId)
    const current: GrantLevel = setting?.level ?? 'view'
    const expired = current === 'full' && (setting?.fullAccessExpiresAt ?? 0) <= Date.now()
    return h`<tr><th>${summary.name}</th><td>
      <form method="post" action="/connections/grant"${raw(' data-reauth')}>
        <input type="hidden" name="clientId" value="${client.clientId}"><input type="hidden" name="hostId" value="${summary.hostId}">
        <select name="level" data-autosubmit aria-label="付与範囲" data-testid="hub-grant-level">${levelsFor(summary).map(level => h`<option value="${level}"${raw(level === current ? ' selected' : '')}>${LEVEL_LABEL[level]}</option>`)}</select>
        <noscript><button type="submit" class="small">保存</button></noscript>
      </form>
      ${current === 'full' ? h`<span class="badge danger">${expired ? '全権は失効（依頼できる扱い）' : `全権 ${relativeTime(setting?.fullAccessExpiresAt)}に失効`}</span>` : ''}
    </td></tr>`
  })}</tbody></table>
  ${reauthForm('/connections/revoke', { clientId: client.clientId }, 'この接続を取り消す', 'danger small')}`}
</article>`
  const body = h`${message(url)}<h1>接続</h1>
<p class="muted">実効権限 ＝ DSH 側の上限 ∩ ここでの付与 ∩ トークンのスコープ。ここでは DSH 側の上限より広くはできません。「依頼できる」以上を付与すると、エージェントにその PC のファイルを読ませ、外へ通信させられることに注意してください（DSH のサンドボックスが制限するのは書き込みだけです）。</p>
<section><h2>接続中のクライアント</h2>
${clients.length === 0 ? h`<p class="muted">まだありません。下の手順で ChatGPT や Claude をつないでください。</p>` : clients.map(clientCard)}</section>
<section class="card" id="setup"><h2>AI クライアントのつなぎ方</h2>
<p>MCP サーバーの URL:</p>
<div class="copyline"><code id="mcp-url">${resources.mcp}</code><button type="button" class="small" data-copy="#mcp-url">コピー</button></div>
<h3>ChatGPT</h3>
<ol><li><code>chatgpt.com/plugins</code> を開き、＋ から「カスタム MCP サーバーを追加」を選びます。</li><li>上の URL を貼り、認証は OAuth を選びます。</li><li>このハブのログイン画面が開くので、パスキーで許可します。</li></ol>
<h3>Claude（claude.ai・Desktop・モバイル）</h3>
<ol><li>設定 → コネクター → 「カスタムコネクターを追加」を開きます。</li><li>上の URL を貼ります（クライアント ID とシークレットは空のままで構いません）。</li><li>「接続」を押し、このハブでパスキーで許可します。</li></ol>
<h3>Claude Code</h3>
<pre class="codes">claude mcp add --transport http remora ${resources.mcp}</pre>
<h3>Remora CLI</h3>
<pre class="codes">remora login ${origin}
remora login ${origin} --device   # SSH 先など</pre>
<h3>コネクター用のアイコン</h3>
<p class="icons"><a href="/remora-512.png" download><img src="/remora-192.png" alt="" width="48" height="48"> PNG 512px</a> <a href="/remora-192.png" download>PNG 192px</a> <a href="/remora-app.svg" download>SVG</a> <a href="/remora-badge.svg" download>バッジ SVG</a></p>
<p class="muted">新しいクライアントは、どのホストでも「見るだけ」から始まります。既知のクライアント（ChatGPT・Claude・Claude Code・Remora CLI）以外は、設定で許可しない限り接続できません。</p>
</section>`
  return view('接続', 'connections', body)
}

// --- audit -------------------------------------------------------------------------------------------

const LAYER_EXPLAIN: Readonly<Record<string, [string, string]>> = {
  dsh: ['DSH 側の上限で止まりました。上限は DSH の設定画面 → Remora タブでだけ変えられます。', 'DSH の設定 → Remora → 権限'],
  hub: ['ハブでの付与で止まりました。「接続」画面でこのクライアントの付与範囲を広げられます（DSH 側の上限まで）。', '/connections'],
  token: ['トークンのスコープ外でした。クライアントを接続し直し、許可画面で必要な範囲にチェックを入れてください。', '/connections#setup'],
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  'forbidden-remotely': '遠隔からは常に不可の操作です',
  'level-too-low': '権限レベルが足りません',
  'switched-off': 'スイッチがオフです',
  'kill-switch': 'DSH 側の緊急停止がオンです',
  'confirmation-failed': 'パスキーでの確認が通りませんでした',
  'out-of-scope': 'DSH 側で許可されたワークスペースの外です',
  'full-access-expired': 'リモート全権が失効しています',
  'missing-scope': 'スコープが足りません',
  'unknown-operation': '知らない操作です',
}

async function auditPage(env: Env, url: URL): Promise<Response> {
  const hub = hubStub(env)
  const hosts = await hub.listHosts(true)
  const [hubRows, ...hostRows] = await Promise.all([hub.listAudit(300), ...hosts.map(host => hostStub(env, host.hostId).listAudit(300))])
  const names = new Map(hosts.map(host => [host.hostId, host.name]))
  const chains: [string, AuditRow[]][] = [['ハブ', hubRows ?? []], ...hosts.map((host, index): [string, AuditRow[]] => [host.name, hostRows[index] ?? []])]
  const broken = (await Promise.all(chains.map(async ([name, rows]) => [name, await verifyAuditChain(rows)] as const))).filter(([, seq]) => seq !== null)
  const filter = url.searchParams.get('filter')
  const rows = chains.flatMap(([, list]) => list).filter(row => filter !== 'denied' || row.outcome !== 'ok').sort((a, b) => b.at - a.at).slice(0, 300)
  const body = h`<h1>監査ログ</h1>
<p class="muted">誰が・いつ・どの操作を・どこへ行ったかだけを記録します（本文は残しません）。ハブとホストごとにハッシュ連鎖でつないでいます。</p>
<p><a class="button small" href="/audit/export.json" download data-testid="hub-audit-export">JSON で書き出す</a> <span class="muted">ハブの外で検査するには <code>remora audit verify --file &lt;書き出したファイル&gt;</code>、またはハブから直接 <code>remora audit verify</code>（毎回ここでの承認が要ります）。</span></p>
${broken.length === 0 ? flash('表示中の範囲でハッシュ連鎖は正常です。', 'ok') : flash(`ハッシュ連鎖が途切れています: ${broken.map(([name, seq]) => `${name} #${seq}`).join(', ')}`, 'error')}
<p><a href="/audit"${raw(filter !== 'denied' ? ' aria-current="page"' : '')}>すべて</a> ・ <a href="/audit?filter=denied"${raw(filter === 'denied' ? ' aria-current="page"' : '')}>拒否とエラーだけ</a></p>
<ul class="audit">${rows.map(row => h`<li class="${row.outcome}">
  <div class="row"><span class="badge ${row.outcome === 'ok' ? 'ok' : row.outcome === 'denied' ? 'danger' : 'warn'}">${{ ok: '成功', denied: '拒否', error: 'エラー' }[row.outcome]}</span>
  <code>${row.operation}</code> <span>${row.actorName}</span> <span class="muted">${row.hostId ? names.get(row.hostId) ?? row.hostId : ''} ・ ${dateTime(row.at)}</span></div>
  ${row.outcome === 'denied' && row.layer ? h`<details><summary>なぜ拒否されたか</summary><p>${REASON_TEXT[row.reason ?? ''] ?? row.reason ?? ''}。${LAYER_EXPLAIN[row.layer]?.[0] ?? ''}</p><p class="muted">直す場所: ${LAYER_EXPLAIN[row.layer]?.[1] ?? '—'}</p></details>` : ''}
  ${row.outcome !== 'ok' && !row.layer && row.reason ? h`<p class="muted small">理由: ${row.reason}</p>` : ''}
</li>`)}</ul>`
  return view('監査ログ', 'audit', body)
}

// --- settings ------------------------------------------------------------------------------------------

async function settingsPage(env: Env, url: URL, origin: string): Promise<Response> {
  const hub = hubStub(env)
  const [state, passkeys, tokens, devices, vapidKey] = await Promise.all([hub.state(), hub.listPasskeys(), hub.listPersonalTokens(), hub.listPushDevices(), hub.vapidPublicKey()])
  const resources = resourcesFor(origin)
  const typeLabel: Record<PushType, string> = { attention: '要対応（質問・プランの確認・承認）', tasks: 'タスクの完了・失敗', hosts: 'ホストの切断・再接続' }
  const notifications = h`<section class="card" id="notifications" data-push data-vapid-key="${vapidKey}"><h2>通知（Web Push）</h2>
<p>このデバイスに、要対応が出たとき、タスクが終わったとき、ホストが切れた・戻ったときに通知します。通知には会話の本文を入れません（種類、ホスト名、短く伏せ字にしたタイトル、開くページだけ）。</p>
<p class="flash error" data-push-unsupported hidden>このブラウザでは Web Push を使えません。</p>
<p class="muted">iPhone・iPad（iOS 16.4 以降）では、Safari の共有ボタンから「ホーム画面に追加」し、ホーム画面の Remora から開いたときだけ通知をオンにできます。Safari のタブのままでは使えません。</p>
<div class="actions"><button class="primary" type="button" data-push-on hidden data-testid="hub-push-on">このデバイスで通知を受け取る</button><button type="button" data-push-off hidden data-testid="hub-push-off">このデバイスの通知を止める</button></div>
<p data-push-status hidden></p>
${devices.length === 0 ? h`<p class="muted">通知を受け取るデバイスはまだありません。</p>` : h`<ul class="list">${devices.map(device => h`<li data-push-endpoint="${device.endpoint}" data-testid="hub-push-device">
  <div class="row"><strong>${device.label}</strong> <span class="muted" data-this-device hidden>（このデバイス）</span> <span class="muted">登録 ${dateTime(device.createdAt)} ・ 最終送信 ${relativeTime(device.lastSentAt)}</span>${device.lastError ? h` <span class="badge warn">${device.lastError}</span>` : ''}</div>
  <form method="post" action="/settings/push/types" class="row">
    <input type="hidden" name="id" value="${device.id}">
    ${PUSH_TYPES.map(type => h`<label class="check"><input type="checkbox" name="type" value="${type}"${raw(device.types.includes(type) ? ' checked' : '')}> <span>${typeLabel[type]}</span></label>`)}
    <button type="submit" class="small">保存</button>
  </form>
  <form method="post" action="/settings/push/remove" class="inline"><input type="hidden" name="id" value="${device.id}"><button class="danger small" type="submit">このデバイスを削除</button></form>
</li>`)}</ul>
<form method="post" action="/settings/push/test"><button type="submit" data-testid="hub-push-test">テスト通知を送る</button></form>`}
</section>`
  const body = h`${message(url)}<h1>設定</h1>
${url.searchParams.get('recovered') ? flash('リカバリーコードでログインしました。新しいパスキーを登録し、必要ならリカバリーコードを作り直してください。', 'error') : ''}
<section class="card" id="passkeys"><h2>パスキー（${passkeys.length} 本）</h2>
${passkeys.length < 2 ? flash('パスキーは 2 本以上の登録をおすすめします（スマホと PC、またはセキュリティキー）。', 'error') : ''}
<ul class="list">${passkeys.map(passkey => h`<li><div class="row"><strong>${passkey.label}</strong> <span class="muted">登録 ${dateTime(passkey.createdAt)} ・ 最終使用 ${relativeTime(passkey.lastUsedAt)}</span></div>
  ${passkeys.length > 1 ? reauthForm('/settings/passkeys/remove', { credentialId: passkey.credentialId }, '削除', 'danger small') : ''}</li>`)}</ul>
<p class="muted">パスキーを削除しても、ペアリング済みの DSH ホストは、各ホストの DSH 画面で変更を承認するまで、そのパスキーを危険な操作の確認用に信頼し続けます。なくした・盗まれたパスキーを削除したときは、すべてのホストで承認してください。</p>
<form class="stack" data-add-passkey><label>新しいパスキーの名前<input name="label" maxlength="60" placeholder="例: MacBook"></label><button class="primary" type="submit">パスキーを追加</button><p data-status hidden></p></form>
<p class="muted">パスキーを追加・削除すると、次に DSH ホストが接続したとき新しい一覧が届きます。ホスト側は変更を DSH の画面で確認してから使います。</p></section>
${notifications}
<section class="card" id="recovery"><h2>リカバリーコード</h2>
<p>未使用: ${state.recoveryCodesLeft} / 10</p>
${reauthForm('/settings/recovery', {}, 'パスキーで確認して作り直す')}
<p class="muted">作り直すと古いコードはすべて無効になります。</p></section>
<section class="card" id="tokens"><h2>個人トークン（HTTP API 用）</h2>
<form method="post" action="/settings/tokens" class="stack" data-reauth>
  <label>名前<input name="name" maxlength="60" required placeholder="例: 自宅のスクリプト" data-testid="hub-token-name"></label>
  <fieldset class="scopes"><legend>スコープ</legend>${SCOPES.map(scope => h`<label class="check"><input type="checkbox" name="scope" value="${scope}"${raw(scope === 'dsh.read' ? ' checked' : '')}> <code>${scope}</code></label>`)}</fieldset>
  <label>有効期限<select name="days"><option value="7">7 日</option><option value="30" selected>30 日</option><option value="90">90 日</option><option value="365">1 年</option></select></label>
  <button class="primary" type="submit" data-testid="hub-token-create">パスキーで確認して発行</button>
</form>
<ul class="list">${tokens.map(token => h`<li><div class="row"><strong>${token.name}</strong> <code>${token.scopes.join(' ')}</code>
  <span class="muted">${token.revokedAt ? '取り消し済み' : token.expiresAt < Date.now() ? '期限切れ' : `${relativeTime(token.expiresAt)}まで`} ・ 最終使用 ${relativeTime(token.lastUsedAt)}</span></div>
  ${!token.revokedAt && token.expiresAt > Date.now() ? h`<form method="post" action="/settings/tokens/revoke" class="inline"><input type="hidden" name="id" value="${token.id}"><button class="danger small" type="submit">取り消す</button></form>` : ''}</li>`)}</ul>
<p class="muted">使い方: <code>curl -X POST -H "Authorization: Bearer &lt;トークン&gt;" ${resources.api}/status</code>。発行したトークンは「接続」画面にも出るので、ホストごとの付与範囲をそこで決めます（既定は見るだけ）。</p></section>
<section class="card" id="clients"><h2>クライアントの許可</h2>
<p>既知のクライアント（ChatGPT、Claude、Claude Code、Remora CLI）以外の CIMD クライアント: <strong>${state.allowOtherClients ? '許可する' : '許可しない（既定）'}</strong></p>
${reauthForm('/settings/allow-other-clients', { allow: state.allowOtherClients ? '0' : '1' }, state.allowOtherClients ? '許可しないに戻す' : 'パスキーで確認して許可する', state.allowOtherClients ? 'primary' : 'danger')}
<p class="muted">動的クライアント登録（DCR）: ${dcrEnabled(env) ? 'オン（回数制限つき）' : 'オフ'}。変えるには環境変数 <code>ENABLE_DCR</code> を設定します。</p></section>
<section class="card"><h2>ハブの情報</h2>
<dl class="facts"><dt>版</dt><dd>${HUB_VERSION}（プロトコル ${PROTOCOL_VERSION}）</dd><dt>オリジン</dt><dd class="mono">${origin}</dd><dt>パスキーの RP ID</dt><dd class="mono">${rpIdOf(origin)}</dd>
<dt>MCP</dt><dd class="mono">${resources.mcp}</dd><dt>HTTP API</dt><dd class="mono">${resources.api}/&lt;操作&gt;</dd><dt>OAuth 発行者</dt><dd class="mono">${origin}</dd><dt>CLI のクライアント ID</dt><dd class="mono">${CLI_CLIENT_ID}</dd></dl>
<p class="muted">ドメインを変えるとパスキーと OAuth の発行者が変わります。リカバリーコードでログインしてパスキーを登録し直し、各クライアントも接続し直してください。</p>
<p><a class="button small" href="/settings/export.json" download data-testid="hub-settings-export">設定を JSON で書き出す</a> <span class="muted">ホスト・クライアントと付与範囲・トークンやパスキーの一覧。秘密（トークンの値、鍵、通知の送り先）は含みません。CLI では <code>remora hub export</code>。</span></p>
<form method="post" action="/auth/logout"><button type="submit">ログアウト</button></form></section>`
  return view('設定', 'settings', body, ['/js/webauthn.js', '/js/live.js', '/js/push.js'])
}

function onceShown(title: string, lead: string, value: string, back: string): Response {
  return view(title, 'settings', h`<h1>${title}</h1><p class="lead">${lead}</p><pre class="codes" id="secret" data-testid="hub-secret">${value}</pre>
<div class="actions"><button type="button" data-copy="#secret">コピー</button><a class="button primary" href="${back}">保管したので戻る</a></div>`)
}

function notFound(): Response {
  return html(page({ title: '見つかりません', narrow: true, body: h`<h1>見つかりません</h1><p><a class="button" href="/">ホームへ</a></p>` }), { status: 404 })
}

// --- routing ------------------------------------------------------------------------------------------

async function requireOwner(request: Request, env: Env, url: URL): Promise<OwnerSession | Response> {
  const session = await getSession(request, env)
  if (!session) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`)
  return session
}

/** Owner UI routes. Returns null for paths it does not handle. */
export async function handleUi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname
  const origin = hubOrigin(request, env)
  const hub = hubStub(env)

  if (request.method === 'GET' || request.method === 'HEAD') {
    if (path === '/login') {
      const state = await hub.state()
      return state.setupComplete ? loginPage(url) : redirect('/setup')
    }
    if (path === '/setup') {
      const state = await hub.state()
      return state.setupComplete ? redirect('/') : setupPage(env)
    }
    const known = path === '/' || path === '/attention' || path.startsWith('/attention/') || path === '/connections' || path === '/audit' || path === '/audit/export.json' || path === '/settings' || path === '/settings/export.json' || path.startsWith('/hosts/') || path.startsWith('/tasks/') || path.startsWith('/confirm/')
    if (!known) return null
    if (path === '/') {
      const state = await hub.state()
      if (!state.setupComplete) return redirect('/setup')
    }
    const session = await requireOwner(request, env, url)
    if (session instanceof Response) return session
    if (path === '/') return homePage(env, url)
    if (path === '/attention') return attentionPage(env, url)
    const itemMatch = /^\/attention\/([a-z0-9]{8,64})\/([^/]+)$/.exec(path)
    if (itemMatch) {
      let attentionId: string
      try {
        attentionId = decodeURIComponent(itemMatch[2] as string)
      } catch {
        return notFound()
      }
      return attentionItemPage(env, url, itemMatch[1] as string, attentionId)
    }
    if (path === '/connections') return connectionsPage(env, url, origin)
    if (path === '/audit') return auditPage(env, url)
    if (path === '/settings') return settingsPage(env, url, origin)
    const hostMatch = /^\/hosts\/([a-z0-9]{8,64})$/.exec(path)
    if (hostMatch) return hostPage(env, url, hostMatch[1] as string)
    const sessionMatch = /^\/hosts\/([a-z0-9]{8,64})\/sessions\/([^/]+)$/.exec(path)
    if (sessionMatch) return sessionPage(env, url, sessionMatch[1] as string, decodeURIComponent(sessionMatch[2] as string))
    const taskMatch = /^\/tasks\/([a-z0-9-]{8,80})$/.exec(path)
    if (taskMatch) return taskPage(env, url, taskMatch[1] as string)
    const hubApproval = /^\/confirm\/hub\/(hub-[a-z2-7]{8,40})$/.exec(path)
    if (hubApproval) return hubApprovalPage(env, url, hubApproval[1] as string)
    if (path === '/audit/export.json' || path === '/settings/export.json') {
      const audit = path === '/audit/export.json'
      const result = await maintenanceResult(env, audit ? 'audit.export' : 'hub.export', origin)
      return json(result, { headers: { 'content-disposition': `attachment; filename="${audit ? 'remora-audit' : 'remora-hub'}-${new Date().toISOString().slice(0, 10)}.json"`, 'cache-control': 'no-store' } })
    }
    const confirmMatch = /^\/confirm\/([a-z0-9]{8,64})\/([a-z0-9-]{8,80})$/.exec(path)
    if (confirmMatch) return confirmPage(env, url, origin, confirmMatch[1] as string, confirmMatch[2] as string)
    return notFound()
  }

  if (request.method !== 'POST') return null
  const handled = path === '/ops/confirmed' || path.startsWith('/push/') || path.startsWith('/hosts/') || path.startsWith('/attention/') || path.startsWith('/connections/') || path.startsWith('/settings/') || path.startsWith('/confirm/')
  if (!handled) return null
  if (!sameOrigin(request, origin)) return new Response('cross-origin request refused', { status: 403 })
  const session = await getSession(request, env)
  if (!session) return path === '/ops/confirmed' || path.startsWith('/push/') ? json({ error: { code: 'denied', message: 'sign in first' } }, { status: 403 }) : redirect('/login')

  if (path === '/ops/confirmed') return confirmedOperation(env, request)
  if (path === '/push/subscribe' || path === '/push/unsubscribe') return pushEndpoint(env, request, path)
  if (path === '/attention/respond') return attentionRespond(env, request)

  const sessionAct = /^\/hosts\/([a-z0-9]{8,64})\/sessions\/([^/]+)\/(prompt|steer|cancel|compact|model|fork|job-stop|schedule-create|schedule-delete)$/.exec(path)
  if (sessionAct) return sessionAction(env, request, sessionAct[1] as string, decodeURIComponent(sessionAct[2] as string), sessionAct[3] as string)

  const deny = /^\/confirm\/(hub|[a-z0-9]{8,64})\/([a-z0-9-]{8,80})\/deny$/.exec(path)
  if (deny) return denyConfirmation(env, deny[1] as string, deny[2] as string)
  const approve = /^\/confirm\/(hub|[a-z0-9]{8,64})\/([a-z0-9-]{8,80})\/approve$/.exec(path)
  if (approve) return approveMaintenance(env, origin, session.fresh, approve[1] as string, approve[2] as string)
  const rotate = /^\/hosts\/([a-z0-9]{8,64})\/rotate-key$/.exec(path)
  if (rotate) return rotateHostKey(env, rotate[1] as string, session.fresh)
  const terminal = /^\/hosts\/([a-z0-9]{8,64})\/terminal$/.exec(path)
  if (terminal) return terminalRequest(env, request, origin, terminal[1] as string)

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
      const ok = await hub.removePasskey(form.get('credentialId') ?? '')
      return redirect(`/settings?msg=${ok ? 'passkey-removed' : 'passkey-last'}#passkeys`)
    }
    case '/settings/recovery': {
      if (!session.fresh) return redirect('/settings?msg=reauth#recovery')
      const codes = await hub.regenerateRecoveryCodes()
      return onceShown('新しいリカバリーコード', '今だけ表示します。安全な場所に保管してください。古いコードは無効になりました。', codes.join('\n'), '/settings#recovery')
    }
    case '/settings/tokens': {
      if (!session.fresh) return redirect('/settings?msg=reauth#tokens')
      const scopes = form.getAll('scope').filter(scope => (SCOPES as readonly string[]).includes(scope))
      const days = Math.min(365, Math.max(1, Number(form.get('days') ?? '30') || 30))
      const name = (form.get('name') ?? '').trim().slice(0, 60) || '個人トークン'
      const { token } = await hub.createPersonalToken(name, scopes.length > 0 ? scopes : ['dsh.read'], days * 86_400_000)
      return onceShown('個人トークンを発行しました', '今だけ表示します。安全な場所に保管してください。「接続」画面でホストごとの付与範囲を決められます（既定は見るだけ）。', token, '/settings#tokens')
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
      const outcome = await hub.notify([{ type: 'test', kind: 'test', hostId: null, host: 'Remora', title: pushText('テスト通知です。届いていれば設定は完了です。'), url: '/settings#notifications' }], origin)
      return redirect(`/settings?msg=${outcome.sent > 0 ? 'push-test-sent' : 'push-test-none'}#notifications`)
    }
    case '/settings/allow-other-clients': {
      if (!session.fresh) return redirect('/settings?msg=reauth#clients')
      const allow = form.get('allow') === '1'
      await hub.setAllowOtherClients(allow)
      await hub.audit({ actor: 'owner', actorName: 'オーナー', operation: allow ? 'settings.allow-other-clients.on' : 'settings.allow-other-clients.off', hostId: null, outcome: 'ok', layer: null, reason: null })
      return redirect('/settings?msg=settings-saved#clients')
    }
  }
  return notFound()
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
