/**
 * Server-rendered pages. Every value from outside (DSH titles, client names)
 * goes through `escapeHtml`; the CSP forbids inline script and inline style.
 */

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

const ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ENTITIES[char] ?? char)
}

export interface HomeModel {
  setupComplete: boolean
  hosts: number
  version: string
}

export function renderHome(model: HomeModel): string {
  const status = model.setupComplete
    ? `<p>つながっている DSH ホスト: ${model.hosts}</p>`
    : '<p>まだ初期設定が済んでいません。パスキーの登録は次の版で追加します。</p>'
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Remora</title>
<link rel="icon" href="/remora-app.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/remora-180.png">
<link rel="stylesheet" href="/hub.css">
</head>
<body>
<main>
<img class="mark" src="/remora-mark-light.svg" alt="" width="96" height="96">
<h1>Remora</h1>
<p class="lead">DSH を外から操作するためのハブです（非公式）。</p>
${status}
<p class="muted">版 ${escapeHtml(model.version)}</p>
</main>
</body>
</html>
`
}
