/**
 * Server-rendered HTML. Every value from outside (DSH titles, client
 * names, codes) goes through `escapeHtml`; the CSP forbids inline script
 * and inline style, so behaviour lives in /js/*.js and looks in /hub.css.
 */
import { HUB_VERSION } from '../version.ts'

const ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ENTITIES[char] ?? char)
}

/** Tagged template that escapes every interpolated value unless it is `raw(...)`. */
export class Raw {
  readonly value: string
  constructor(value: string) {
    this.value = value
  }
  toString(): string {
    return this.value
  }
}

export const raw = (value: string) => new Raw(value)

type Value = string | number | boolean | null | undefined | Raw | readonly Value[]

function render(value: Value): string {
  if (value === null || value === undefined || value === false) return ''
  if (value instanceof Raw) return value.value
  if (Array.isArray(value)) return value.map(item => render(item)).join('')
  return escapeHtml(String(value))
}

export function h(strings: TemplateStringsArray, ...values: Value[]): Raw {
  let out = strings[0] ?? ''
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '')
  return new Raw(out)
}

export type NavKey = 'home' | 'attention' | 'connections' | 'audit' | 'settings' | null

export interface PageOptions {
  title: string
  body: Raw
  nav?: NavKey | false
  scripts?: string[]
  /** Narrow, centered card for sign-in and approval pages. */
  narrow?: boolean
}

const NAV: [Exclude<NavKey, null>, string, string][] = [
  ['home', '/', 'ホーム'],
  ['attention', '/attention', '要対応'],
  ['connections', '/connections', '接続'],
  ['audit', '/audit', '監査ログ'],
  ['settings', '/settings', '設定'],
]

export function page(options: PageOptions): string {
  const nav = options.nav === false || options.nav === undefined && options.narrow
    ? ''
    : h`<nav class="nav" aria-label="メニュー" data-testid="hub-signed-in">
  <a class="brand" href="/"><img src="/remora-mark-light.svg" alt="" width="24" height="24"><span>Remora</span></a>
  <div class="links">${NAV.map(([key, href, label]) => h`<a href="${href}"${raw(options.nav === key ? ' aria-current="page"' : '')}>${label}</a>`)}</div>
</nav>`.value
  const scripts = (options.scripts ?? []).map(src => `<script src="${escapeHtml(src)}" defer></script>`).join('\n')
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#0b0f17">
<title>${escapeHtml(options.title)} · Remora</title>
<link rel="icon" href="/remora-app.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/remora-180.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/hub.css">
${scripts}
</head>
<body>
${nav}
<main class="${options.narrow ? 'narrow' : 'wide'}">
${options.body.value}
</main>
<footer class="footer">Remora ${escapeHtml(HUB_VERSION)} · DSH（DeepSeek Harness）向けの非公式ツールです</footer>
</body>
</html>
`
}

export function relativeTime(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '—'
  const seconds = Math.round((now - at) / 1000)
  if (seconds < 0) {
    const ahead = -seconds
    if (ahead < 3600) return `${Math.max(1, Math.round(ahead / 60))} 分後`
    if (ahead < 86_400) return `${Math.round(ahead / 3600)} 時間後`
    return `${Math.round(ahead / 86_400)} 日後`
  }
  if (seconds < 60) return 'たった今'
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分前`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} 時間前`
  return `${Math.round(seconds / 86_400)} 日前`
}

export function dateTime(at: number | null | undefined): string {
  if (!at) return '—'
  return new Date(at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false })
}

export const LEVEL_LABEL: Readonly<Record<string, string>> = {
  none: '使わせない',
  view: '見るだけ',
  request: '依頼できる',
  full: 'リモート全権',
}

export const STATE_LABEL: Readonly<Record<string, string>> = {
  accepted: '受付済み',
  running: '実行中',
  needs_attention: '要対応',
  completed: '完了',
  failed: '失敗',
  cancelled: '取り消し',
  parked: '保留（ホストがオフライン）',
}

export const ATTENTION_LABEL: Readonly<Record<string, string>> = {
  approval: '承認待ち',
  question: 'AI からの質問',
  'plan-review': 'プランの確認',
  'goal-stopped': 'ゴールの停止',
  'login-expired': 'ログイン切れ',
}

export function flash(message: string | null | undefined, kind: 'ok' | 'error' = 'ok'): Raw {
  return message ? h`<p class="flash ${kind}" role="status">${message}</p>` : raw('')
}

/** A form that the browser script turns into "confirm with a passkey, then submit". */
export function reauthForm(action: string, fields: Record<string, string>, label: string, className = 'primary'): Raw {
  return h`<form method="post" action="${action}" data-reauth>
${Object.entries(fields).map(([name, value]) => h`<input type="hidden" name="${name}" value="${value}">`)}
<button class="${className}" type="submit">${label}</button>
</form>`
}
