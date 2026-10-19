/**
 * Server-rendered HTML. Every value from outside (DSH titles, client
 * names, codes) goes through `escapeHtml`; the CSP forbids inline script
 * and inline style, so behaviour lives in /js/*.js and looks in /hub.css.
 */
import { LOCALES, LOCALE_NAMES, LOCALE_TAGS, i18nFor, type I18n } from '../i18n/index.ts'
import { HUB_VERSION } from '../version.ts'
import { escapeHtml, h, raw, Raw } from './html.ts'

export { escapeHtml, h, raw, Raw }

/** One request's language and the path of the page, for the language switcher. */
export interface Ui {
  i18n: I18n
  t: I18n['t']
  path: string
}

export function uiFor(request: Request): Ui {
  const i18n = i18nFor(request)
  const url = new URL(request.url)
  return { i18n, t: i18n.t, path: url.pathname + url.search }
}

/** A narrow page (sign-in, approvals) in the reader's language. */
export function narrowHtml(ui: Ui, title: string, body: Raw, scripts: string[] = ['/js/webauthn.js']): string {
  return page({ i18n: ui.i18n, title, narrow: true, body, scripts, path: ui.path })
}

export type NavKey = 'home' | 'attention' | 'connections' | 'audit' | 'settings' | null

export interface PageOptions {
  i18n: I18n
  title: string
  body: Raw
  nav?: NavKey | false
  scripts?: string[]
  /** Narrow column for sign-in, setup and approval pages. */
  narrow?: boolean
  /** Reload the page after this many seconds (a result still on its way). */
  refreshSeconds?: number
  /** Path and query of this page, so the language switcher can come back to it. */
  path?: string
}

const NAV: [Exclude<NavKey, null>, string, 'nav.home' | 'nav.attention' | 'nav.connections' | 'nav.audit' | 'nav.settings'][] = [
  ['home', '/', 'nav.home'],
  ['attention', '/attention', 'nav.attention'],
  ['connections', '/connections', 'nav.connections'],
  ['audit', '/audit', 'nav.audit'],
  ['settings', '/settings', 'nav.settings'],
]

export function mark(size: number): Raw {
  return h`<picture><source srcset="/remora-mark-light.svg" media="(prefers-color-scheme: dark)"><img src="/remora-mark.svg" alt="" width="${size}" height="${size}"></picture>`
}

function languageLinks(i18n: I18n, path: string): Raw {
  return h`<nav class="lang" aria-label="${i18n.t('footer.language')}">${LOCALES.map(locale => h`<a href="/lang?set=${locale}&amp;next=${raw(encodeURIComponent(path))}" lang="${LOCALE_TAGS[locale]}" hreflang="${LOCALE_TAGS[locale]}"${raw(locale === i18n.locale ? ' aria-current="true"' : '')}>${LOCALE_NAMES[locale]}</a>`)}</nav>`
}

export function page(options: PageOptions): string {
  const { i18n } = options
  const showNav = !(options.nav === false || (options.nav === undefined && options.narrow))
  const header = showNav
    ? h`<header class="topbar" data-testid="hub-signed-in"><div class="topbar-inner">
  <a class="brand" href="/">${mark(22)}<span>Remora</span></a>
  <nav class="nav" aria-label="${i18n.t('nav.label')}">${NAV.map(([key, href, label]) => h`<a href="${href}"${raw(options.nav === key ? ' aria-current="page"' : '')}>${i18n.t(label)}</a>`)}</nav>
</div></header>`
    : raw('')
  const brand = options.narrow ? h`<a class="auth-brand" href="/">${mark(24)}<span>Remora</span></a>` : raw('')
  const scripts = (options.scripts ?? []).map(src => `<script src="${escapeHtml(src)}" defer></script>`).join('\n')
  return `<!doctype html>
<html lang="${LOCALE_TAGS[i18n.locale]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1b1b1c" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Remora">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
${options.refreshSeconds ? `<meta http-equiv="refresh" content="${Math.max(1, Math.round(options.refreshSeconds))}">\n` : ''}<title>${escapeHtml(options.title)} · Remora</title>
<link rel="icon" href="/remora-app.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/remora-180.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="stylesheet" href="/hub.css">
${scripts}
</head>
<body data-i18n="${escapeHtml(JSON.stringify(i18n.client()))}">
${header.value}
<main class="${options.narrow ? 'narrow' : 'wide'}">
${brand.value}${options.body.value}
</main>
<footer class="footer"><div class="footer-inner"><span>${escapeHtml(i18n.t('footer.note', { version: HUB_VERSION }))}</span>${languageLinks(i18n, options.path ?? '/').value}</div></footer>
</body>
</html>
`
}

/** Page title with an optional subtitle and breadcrumbs. */
export function pageHead(title: string | Raw, options: { subtitle?: string | Raw; crumbs?: Raw; className?: string } = {}): Raw {
  return h`<div class="page-head">${options.crumbs ? h`<p class="crumbs">${options.crumbs}</p>` : ''}<h1${raw(options.className ? ` class="${escapeHtml(options.className)}"` : '')}>${title}</h1>${options.subtitle ? h`<p class="subtitle">${options.subtitle}</p>` : ''}</div>`
}

/**
 * Characters that change how text looks without showing up: controls (but
 * tab and newline), format characters (bidi marks and overrides, zero-width
 * marks, tag characters…), separators other than the plain space, private
 * use and unassigned code points, variation selectors, combining grapheme
 * joiner and the blank fillers.
 */
const INVISIBLE = /(?![\t\n])[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}   -   　͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ\u{E0100}-\u{E01EF}]/gu

/**
 * Text the owner must judge before confirming it (a command): every
 * invisible character becomes a visible ⟦U+XXXX⟧, so the page shows what
 * will run. Tabs and newlines stay.
 */
export function visibleText(text: string): { text: string; hidden: boolean } {
  let hidden = false
  const shown = text.replace(INVISIBLE, char => {
    hidden = true
    return `⟦U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟧`
  })
  return { text: shown, hidden }
}

export function flash(message: string | Raw | null | undefined, kind: 'ok' | 'error' | 'warn' = 'ok'): Raw {
  if (!message) return raw('')
  return h`<div class="notice ${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${message}</div>`
}

/** A form that the browser script turns into "confirm with a passkey, then submit". */
export function reauthForm(action: string, fields: Record<string, string>, label: string, className = 'primary'): Raw {
  return h`<form method="post" action="${action}" data-reauth class="reauth-form">
${Object.entries(fields).map(([name, value]) => h`<input type="hidden" name="${name}" value="${value}">`)}
<button class="${className}" type="submit">${label}</button>
<div data-status role="status" hidden></div>
</form>`
}

/** A value with a copy button (/js/webauthn.js wires `data-copy`). */
export function copyField(i18n: I18n, id: string, value: string): Raw {
  return h`<div class="copy"><code id="${id}">${value}</code><button type="button" data-copy="#${id}">${i18n.t('common.copy')}</button></div>`
}
