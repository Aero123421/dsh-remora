/**
 * The owner's pages: setup, sign-in, inbox, hosts, sessions, tasks,
 * attention, connections, audit log and settings. Server-rendered; the
 * only script is /js/webauthn.js for passkey ceremonies.
 */
import type { AuditRow } from '../audit.ts'
import { verifyAuditChain } from '../audit.ts'
import { getSession, rpIdOf, type OwnerSession } from '../auth.ts'
import { FREE_TIER, FREE_TIER_WARN, dcrEnabled, hubOrigin, secrets } from '../config.ts'
import type { HostLive } from '../host-do.ts'
import { html, json, readForm, readJson, redirect, sameOrigin } from '../http.ts'
import { hostStub, hubStub } from '../meter.ts'
import { oauthEnv, oauthFor, resourcesFor } from '../oauth.ts'
import { liveHosts, runOperation, type Caller } from '../ops.ts'
import type { ClientWithGrants, GrantLevel } from '../types.ts'
import { randomToken } from '../util.ts'
import { HUB_VERSION } from '../version.ts'
import {
  CLI_CLIENT_ID, LEVEL_RANK, PROTOCOL_VERSION, SCOPES,
  type AttentionItem, type Confirmation, type HostSummary, type RemoraError, type SessionGetResult, type SessionSummary, type TaskInfo, type WorkspaceSummary,
} from '../vendor/protocol/index.ts'
import { ATTENTION_LABEL, LEVEL_LABEL, STATE_LABEL, dateTime, flash, h, page, raw, reauthForm, relativeTime, type NavKey, type Raw } from './layout.ts'

const OWNER: Caller = { clientId: 'hub-ui', clientName: 'ハブの画面', scopes: [...SCOPES], kind: 'owner' }

const MESSAGES: Readonly<Record<string, [string, 'ok' | 'error']>> = {
  'passkey-added': ['パスキーを追加しました。', 'ok'],
  'passkey-removed': ['パスキーを削除しました。', 'ok'],
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

function view(title: string, nav: NavKey, body: Raw, scripts: string[] = ['/js/webauthn.js']): Response {
  return html(page({ title, nav, body, scripts }))
}

function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/'
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
  <label>デプロイ時に決めた SETUP_TOKEN<input name="setupToken" type="password" autocomplete="off" required></label>
  <label>このパスキーの名前（例: iPhone）<input name="label" maxlength="60" placeholder="パスキー"></label>
  <button class="primary" type="submit">パスキーを登録</button>
  <p data-status hidden></p>
</form>
<section data-after-setup hidden>
  <h2>リカバリーコード</h2>
  <p class="lead">パスキーをなくしたときに 1 回ずつ使えるコードです。<strong>今だけ表示します。</strong>安全な場所に保管してください。</p>
  <pre class="codes" id="recovery" data-recovery-codes></pre>
  <div class="actions"><button type="button" data-copy="#recovery">コピー</button><a class="button primary" href="/">保管したので次へ</a></div>
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
  <button class="primary big" type="button" data-login data-next="${safeNext(url.searchParams.get('next'))}">パスキーでログイン</button>
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
}

async function overview(env: Env): Promise<Overview> {
  const hub = hubStub(env)
  const hosts = (await hub.listHosts()).map(host => ({ hostId: host.hostId, name: host.name }))
  const context = { ok: true, hosts, grants: Object.fromEntries(hosts.map(host => [host.hostId, { level: 'full' as const }])) }
  const [live, clients] = await Promise.all([liveHosts(env, context), hub.listClients()])
  return { hosts: live, clients }
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
  <div class="row"><span class="dot ${summary.online ? 'on' : 'off'}" aria-hidden="true"></span><strong>${summary.name}</strong>
  ${fullAccessOn(summary, clients) ? h`<span class="badge danger">リモート全権</span>` : ''}
  ${summary.killSwitch ? h`<span class="badge danger">緊急停止中</span>` : ''}</div>
  <p class="muted">${summary.online ? '接続中' : `オフライン（最終 ${relativeTime(summary.lastSeenAt)}）`} ・ 上限: ${summary.ceiling ? LEVEL_LABEL[summary.ceiling.level] : '未報告'} ・ 実行中 ${live.running.length} ・ 要対応 ${live.attention.length}</p>
  ${live.duplicateConnections > 0 ? h`<p class="flash error">同じ鍵での同時接続を ${live.duplicateConnections} 回検知しました。鍵の流出が疑われるときは登録を解除して鍵を作り直してください。</p>` : ''}
</a>`
}

function taskRow(task: TaskInfo, hostName: string): Raw {
  return h`<li><a href="/tasks/${task.taskId}"><span class="state ${task.state}">${STATE_LABEL[task.state] ?? task.state}</span> ${hostName} ・ <span class="muted">${relativeTime(task.updatedAt)}</span></a></li>`
}

function attentionRow(item: AttentionItem, hostName: string): Raw {
  return h`<li><a href="/attention#${item.hostId}-${item.attentionId}"><span class="badge warn">${ATTENTION_LABEL[item.kind] ?? item.kind}</span> <span class="untrusted">${item.title}</span> <span class="muted">${hostName}</span></a></li>`
}

async function homePage(env: Env, url: URL): Promise<Response> {
  const hub = hubStub(env)
  const [state, data, meter] = await Promise.all([hub.state(), overview(env), hub.meterToday()])
  const names = new Map(data.hosts.map(entry => [entry.summary.hostId, entry.summary.name]))
  const attention = data.hosts.flatMap(entry => entry.live.attention)
  const running = data.hosts.flatMap(entry => entry.live.running)
  const recent = data.hosts.flatMap(entry => entry.live.recent).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
  const steps: [boolean, string, string][] = [
    [state.passkeys >= 2, 'パスキーを 2 本登録する', '/settings#passkeys'],
    [data.hosts.length > 0, 'DSH ホストをつなぐ', '/pair'],
    [data.hosts.some(entry => entry.summary.ceiling !== null), 'DSH の Remora タブで権限と範囲を決める', '/connections'],
    [data.clients.some(client => client.kind !== 'pat' && !client.revokedAt), 'AI クライアントをつなぐ', '/connections#setup'],
    [data.hosts.some(entry => entry.live.hadTasks), '最初のタスクを投げる', '/connections#setup'],
  ]
  const meters: [string, number, number][] = [
    ['Worker のリクエスト', meter.workerRequests, FREE_TIER.workerRequests],
    ['Durable Objects のリクエスト', meter.durableObjectRequests, FREE_TIER.durableObjectRequests],
    ['KV の書き込み', meter.kvWrites, FREE_TIER.kvWrites],
  ]
  const body = h`${message(url)}
${steps.every(([done]) => done) ? '' : h`<section class="card"><h2>はじめに</h2><ol class="checklist">${steps.map(([done, label, href]) => h`<li class="${done ? 'done' : ''}"><a href="${href}">${label}</a></li>`)}</ol></section>`}
<section><h2>要対応 <span class="count">${attention.length}</span></h2>
${attention.length === 0 ? h`<p class="muted">人の判断を待っているものはありません。</p>` : h`<ul class="list">${attention.map(item => attentionRow(item, names.get(item.hostId) ?? item.hostId))}</ul>`}</section>
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
  const name = live.name || host.name
  let content: Raw
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
      const list = (workspaces.result as { workspaces: WorkspaceSummary[] }).workspaces
      const all = (sessions.result as { sessions: SessionSummary[] }).sessions
      const children = (parent: string) => all.filter(session => session.parentSessionId === parent)
      const sessionItem = (session: SessionSummary): Raw => h`<li><a href="/hosts/${hostId}/sessions/${encodeURIComponent(session.sessionId)}">${session.pinned ? '📌 ' : ''}<span class="untrusted">${session.title || '(無題)'}</span></a>
        ${session.running ? h`<span class="badge ok">実行中</span>` : ''} <span class="muted">${relativeTime(session.updatedAt)}</span>
        ${children(session.sessionId).length > 0 ? h`<ul class="sub">${children(session.sessionId).map(sessionItem)}</ul>` : ''}</li>`
      const top = (workspaceId: string | null) => all.filter(session => session.workspaceId === workspaceId && !session.parentSessionId)
      content = h`${list.map(workspace => h`<section class="card"><h3><span class="untrusted">${workspace.name}</span>${workspace.untrusted ? h` <span class="badge warn">未信頼</span>` : ''}</h3>
        <p class="muted mono">${workspace.path ?? ''}</p>
        ${top(workspace.workspaceId).length === 0 ? h`<p class="muted">セッションはありません。</p>` : h`<ul class="list">${top(workspace.workspaceId).map(sessionItem)}</ul>`}</section>`)}
        ${top(null).length > 0 ? h`<section class="card"><h3>ワークスペース外</h3><ul class="list">${top(null).map(sessionItem)}</ul></section>` : ''}`
    }
  }
  const body = h`${message(url)}
<p class="crumbs"><a href="/">ホーム</a> / ホスト</p>
<h1><span class="dot ${live.online ? 'on' : 'off'}" aria-hidden="true"></span> ${name}</h1>
<p class="muted">${live.online ? '接続中' : `オフライン（最終 ${relativeTime(live.lastSeenAt)}）`} ・ プラグイン ${live.pluginVersion ?? '—'} ・ DSH ${live.dshVersion ?? '—'} ・ 上限 ${live.ceiling ? LEVEL_LABEL[live.ceiling.level] : '未報告'}${live.killSwitch ? ' ・ 緊急停止中' : ''}</p>
${content}
<details class="card"><summary>使える操作（${live.operations.length}）</summary><p class="mono small">${live.operations.join(', ') || '—'}</p></details>
<details class="card danger-zone"><summary>登録の解除</summary>
<p>このホストの鍵を無効にし、接続を切ります。もう一度使うには DSH 側でペアリングし直します。</p>
${reauthForm(`/hosts/${hostId}/revoke`, {}, 'パスキーで確認して解除', 'danger')}</details>`
  return view(name, 'home', body)
}

async function sessionPage(env: Env, url: URL, hostId: string, sessionId: string): Promise<Response> {
  const host = await hubStub(env).getHost(hostId)
  if (!host || host.revokedAt) return notFound()
  const [got, live] = await Promise.all([runOperation(env, OWNER, 'session.get', { hostId, sessionId }), hostStub(env, hostId).summary()])
  const running = live.running.filter(task => task.sessionId === sessionId)
  let detail: Raw
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
  }
  const base = `/hosts/${hostId}/sessions/${encodeURIComponent(sessionId)}`
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
</form></section>`
  const body = h`${message(url)}<p class="crumbs"><a href="/">ホーム</a> / <a href="/hosts/${hostId}">${live.name || host.name}</a> / セッション</p>${detail}${actions}`
  return view('セッション', 'home', body)
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

async function attentionPage(env: Env, url: URL): Promise<Response> {
  const data = await overview(env)
  const sections: Raw[] = []
  for (const { summary, live } of data.hosts) {
    let items: AttentionItem[] = live.attention
    let note: Raw = raw('')
    if (summary.online) {
      const listed = await runOperation(env, OWNER, 'attention.list', { hostId: summary.hostId })
      if (listed.ok) items = (listed.result as { items: AttentionItem[] }).items
      else note = errorFlash(listed.error, '最新の一覧を読めませんでした')
    } else if (items.length > 0) {
      note = h`<p class="muted">ホストがオフラインのため、最後に届いた一覧です。回答はできません。</p>`
    }
    if (items.length === 0 && note.value === '') continue
    const canApprove = summary.operations.includes('approval.respond')
    sections.push(h`<section><h2>${summary.name}</h2>${note}
${items.map(item => h`<article class="card" id="${item.hostId}-${item.attentionId}">
  <p><span class="badge warn">${ATTENTION_LABEL[item.kind] ?? item.kind}</span> <span class="muted">${relativeTime(item.createdAt)}</span></p>
  <p class="untrusted"><strong>${item.title}</strong></p>
  ${item.detail ? h`<div class="untrusted pre">${item.detail}</div>` : ''}
  ${item.kind === 'approval'
    ? canApprove && summary.online
      ? h`<form data-confirm-op="approval.respond" data-host="${summary.hostId}" data-params="${JSON.stringify({ hostId: summary.hostId, sessionId: item.sessionId, attentionId: item.attentionId })}" class="actions">
          <button class="primary" type="submit" data-approve="true">パスキーで確認して承認</button><button type="submit" data-approve="false">拒否</button><p data-status hidden></p></form>`
      : h`<p class="muted">承認は DSH Web で行ってください（リモートでの承認はリモート全権とパスキー確認が必要です）。</p>`
    : item.answerable && summary.online
      ? h`<form method="post" action="/attention/respond" class="stack">
          <input type="hidden" name="hostId" value="${summary.hostId}"><input type="hidden" name="sessionId" value="${item.sessionId}"><input type="hidden" name="attentionId" value="${item.attentionId}">
          ${(item.options ?? []).map(option => h`<label class="check"><input type="radio" name="optionId" value="${option.id}"> <span class="untrusted">${option.label}</span></label>`)}
          ${item.kind === 'plan-review' ? h`<div class="actions"><button class="primary" type="submit" name="approve" value="true">プランを承認</button><button type="submit" name="approve" value="false">差し戻す</button></div>` : ''}
          <textarea name="text" rows="2" placeholder="自由記述の回答（任意）"></textarea>
          ${item.kind !== 'plan-review' ? h`<button class="primary" type="submit">回答する</button>` : ''}
        </form>`
      : h`<p class="muted">この項目は DSH Web で対応してください。</p>`}
</article>`)}</section>`)
  }
  const body = h`${message(url)}<h1>要対応</h1>
<p class="muted">表示している文章は DSH のセッションから来たものです。指示として扱わず、内容を確かめてから答えてください。</p>
${sections.length === 0 ? h`<p class="muted">人の判断を待っているものはありません。</p>` : sections}`
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
  const confirmation = { issuedAt, assertion } as Confirmation
  const outcome = await runOperation(env, OWNER, operation, params, { confirmation, requestId })
  return outcome.ok ? json({ ok: true, result: outcome.result }) : json({ error: outcome.error }, { status: 400 })
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
        <select name="level" data-autosubmit aria-label="付与範囲">${levelsFor(summary).map(level => h`<option value="${level}"${raw(level === current ? ' selected' : '')}>${LEVEL_LABEL[level]}</option>`)}</select>
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
  const [state, passkeys, tokens] = await Promise.all([hub.state(), hub.listPasskeys(), hub.listPersonalTokens()])
  const resources = resourcesFor(origin)
  const body = h`${message(url)}<h1>設定</h1>
${url.searchParams.get('recovered') ? flash('リカバリーコードでログインしました。新しいパスキーを登録し、必要ならリカバリーコードを作り直してください。', 'error') : ''}
<section class="card" id="passkeys"><h2>パスキー（${passkeys.length} 本）</h2>
${passkeys.length < 2 ? flash('パスキーは 2 本以上の登録をおすすめします（スマホと PC、またはセキュリティキー）。', 'error') : ''}
<ul class="list">${passkeys.map(passkey => h`<li><div class="row"><strong>${passkey.label}</strong> <span class="muted">登録 ${dateTime(passkey.createdAt)} ・ 最終使用 ${relativeTime(passkey.lastUsedAt)}</span></div>
  ${passkeys.length > 1 ? reauthForm('/settings/passkeys/remove', { credentialId: passkey.credentialId }, '削除', 'danger small') : ''}</li>`)}</ul>
<form class="stack" data-add-passkey><label>新しいパスキーの名前<input name="label" maxlength="60" placeholder="例: MacBook"></label><button class="primary" type="submit">パスキーを追加</button><p data-status hidden></p></form>
<p class="muted">パスキーを追加・削除すると、次に DSH ホストが接続したとき新しい一覧が届きます。ホスト側は変更を DSH の画面で確認してから使います。</p></section>
<section class="card" id="recovery"><h2>リカバリーコード</h2>
<p>未使用: ${state.recoveryCodesLeft} / 10</p>
${reauthForm('/settings/recovery', {}, 'パスキーで確認して作り直す')}
<p class="muted">作り直すと古いコードはすべて無効になります。</p></section>
<section class="card" id="tokens"><h2>個人トークン（HTTP API 用）</h2>
<form method="post" action="/settings/tokens" class="stack" data-reauth>
  <label>名前<input name="name" maxlength="60" required placeholder="例: 自宅のスクリプト"></label>
  <fieldset class="scopes"><legend>スコープ</legend>${SCOPES.map(scope => h`<label class="check"><input type="checkbox" name="scope" value="${scope}"${raw(scope === 'dsh.read' ? ' checked' : '')}> <code>${scope}</code></label>`)}</fieldset>
  <label>有効期限<select name="days"><option value="7">7 日</option><option value="30" selected>30 日</option><option value="90">90 日</option><option value="365">1 年</option></select></label>
  <button class="primary" type="submit">パスキーで確認して発行</button>
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
<form method="post" action="/auth/logout"><button type="submit">ログアウト</button></form></section>`
  return view('設定', 'settings', body)
}

function onceShown(title: string, lead: string, value: string, back: string): Response {
  return view(title, 'settings', h`<h1>${title}</h1><p class="lead">${lead}</p><pre class="codes" id="secret">${value}</pre>
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
    const known = path === '/' || path === '/attention' || path === '/connections' || path === '/audit' || path === '/settings' || path.startsWith('/hosts/') || path.startsWith('/tasks/')
    if (!known) return null
    if (path === '/') {
      const state = await hub.state()
      if (!state.setupComplete) return redirect('/setup')
    }
    const session = await requireOwner(request, env, url)
    if (session instanceof Response) return session
    if (path === '/') return homePage(env, url)
    if (path === '/attention') return attentionPage(env, url)
    if (path === '/connections') return connectionsPage(env, url, origin)
    if (path === '/audit') return auditPage(env, url)
    if (path === '/settings') return settingsPage(env, url, origin)
    const hostMatch = /^\/hosts\/([a-z0-9]{8,64})$/.exec(path)
    if (hostMatch) return hostPage(env, url, hostMatch[1] as string)
    const sessionMatch = /^\/hosts\/([a-z0-9]{8,64})\/sessions\/([^/]+)$/.exec(path)
    if (sessionMatch) return sessionPage(env, url, sessionMatch[1] as string, decodeURIComponent(sessionMatch[2] as string))
    const taskMatch = /^\/tasks\/([a-z0-9-]{8,80})$/.exec(path)
    if (taskMatch) return taskPage(env, url, taskMatch[1] as string)
    return notFound()
  }

  if (request.method !== 'POST') return null
  const handled = path === '/ops/confirmed' || path.startsWith('/hosts/') || path.startsWith('/attention/') || path.startsWith('/connections/') || path.startsWith('/settings/')
  if (!handled) return null
  if (!sameOrigin(request, origin)) return new Response('cross-origin request refused', { status: 403 })
  const session = await getSession(request, env)
  if (!session) return path === '/ops/confirmed' ? json({ error: { code: 'denied', message: 'sign in first' } }, { status: 403 }) : redirect('/login')

  if (path === '/ops/confirmed') return confirmedOperation(env, request)
  if (path === '/attention/respond') return attentionRespond(env, request)

  const sessionAct = /^\/hosts\/([a-z0-9]{8,64})\/sessions\/([^/]+)\/(prompt|steer|cancel|compact|model)$/.exec(path)
  if (sessionAct) return sessionAction(env, request, sessionAct[1] as string, decodeURIComponent(sessionAct[2] as string), sessionAct[3] as string)

  const revokeHost = /^\/hosts\/([a-z0-9]{8,64})\/revoke$/.exec(path)
  if (revokeHost) {
    if (!session.fresh) return redirect(`/hosts/${revokeHost[1]}?msg=reauth`)
    const hostId = revokeHost[1] as string
    if (await hub.revokeHost(hostId)) await hostStub(env, hostId).revoke()
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
      const result = await hub.setGrant(form.get('clientId') ?? '', hostId, level, live.ceiling?.level ?? null)
      return redirect(`/connections?msg=${result.ok ? 'grant-saved' : `grant-${result.reason}`}`)
    }
    case '/connections/revoke': {
      if (!session.fresh) return redirect('/connections?msg=reauth')
      await revokeClient(env, form.get('clientId') ?? '', origin)
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
      return redirect('/settings?msg=token-revoked#tokens')
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
