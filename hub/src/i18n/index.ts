/**
 * Hub languages: English, Japanese and Simplified Chinese (the two DSH ships
 * plus Japanese). The page language comes from the `remora_lang` cookie set
 * by /lang, else from Accept-Language, else English. Pure, so it is
 * unit-tested under Node.
 */
import { escapeHtml, Raw } from '../ui/html.ts'
import { en } from './en.ts'
import { ja } from './ja.ts'
import { zh } from './zh.ts'

export type MessageKey = keyof typeof en
export type Messages = Readonly<Record<MessageKey, string>>

export const LOCALES = ['en', 'ja', 'zh'] as const
export type Locale = (typeof LOCALES)[number]

/** Each language named in itself, for the switcher. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { en: 'English', ja: '日本語', zh: '中文' }

/** BCP 47 tags for `lang=""` and Intl. */
export const LOCALE_TAGS: Readonly<Record<Locale, string>> = { en: 'en', ja: 'ja', zh: 'zh-CN' }

export const LANG_COOKIE = 'remora_lang'

const CATALOG: Readonly<Record<Locale, Messages>> = { en, ja, zh }

/** Whether a key built at run time (`op.${id}`) has a message. */
export function hasMessage(key: string): key is MessageKey {
  return Object.hasOwn(en, key)
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** The best supported language for an Accept-Language header (q-values honoured), else English. */
export function negotiate(header: string | null | undefined): Locale {
  if (!header) return 'en'
  const ranked = header.split(',').map((part, index) => {
    const [tag = '', ...params] = part.trim().split(';')
    const q = params.map(param => param.trim()).find(param => param.startsWith('q='))
    const weight = q === undefined ? 1 : Number(q.slice(2))
    return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index }
  }).filter(entry => entry.tag !== '' && entry.weight > 0).sort((a, b) => b.weight - a.weight || a.index - b.index)
  for (const { tag } of ranked) {
    const base = tag.split('-')[0]
    if (isLocale(base)) return base
  }
  return 'en'
}

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index >= 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

/** The language a page for this request is rendered in. */
export function localeOf(request: Request): Locale {
  const chosen = cookie(request, LANG_COOKIE)
  return isLocale(chosen) ? chosen : negotiate(request.headers.get('accept-language'))
}

export function langCookie(locale: Locale | null): string {
  return locale
    ? `${LANG_COOKIE}=${locale}; Path=/; Secure; SameSite=Lax; Max-Age=31536000`
    : `${LANG_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`
}

export type Vars = Readonly<Record<string, string | number>>
export type RichVars = Readonly<Record<string, string | number | Raw>>

export interface I18n {
  readonly locale: Locale
  /** BCP 47 tag of the locale. */
  readonly tag: string
  /** Plain text with `{name}` placeholders filled in. Escaped wherever it is rendered with `h`. */
  t(key: MessageKey, vars?: Vars): string
  /** Markup: the message is escaped, `Raw` values are inserted as they are. */
  rich(key: MessageKey, vars: RichVars): Raw
  /** A `<time>` element: UTC on the server, rewritten to the reader's time zone by /js/live.js. */
  time(at: number | null | undefined): Raw
  /** Date and time in UTC, as text. */
  dateText(at: number | null | undefined): string
  /** "5 minutes ago", "in 2 hours". */
  relative(at: number | null | undefined, now?: number): string
  /** Time left before a deadline, or "expired". */
  countdown(expiresAt: number, now?: number): string
  number(value: number): string
  /** Strings /js/*.js need, as one object (keys starting with `js.` or `time.`). */
  client(): Record<string, string>
}

function fill(template: string, vars: Vars | undefined): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}

export function countdownParts(expiresAt: number, now: number): { left: number; hours: number; minutes: number; seconds: number } {
  const left = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return { left, hours: Math.floor(left / 3600), minutes: Math.floor((left % 3600) / 60), seconds: left % 60 }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function dateFormat(tag: string): Intl.DateTimeFormat {
  let format = formatters.get(tag)
  if (!format) {
    format = new Intl.DateTimeFormat(tag, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })
    formatters.set(tag, format)
  }
  return format
}

export function i18n(locale: Locale): I18n {
  const messages = CATALOG[locale]
  const tag = LOCALE_TAGS[locale]
  const text = (key: MessageKey): string => messages[key] ?? en[key] ?? key
  const self: I18n = {
    locale,
    tag,
    t: (key, vars) => fill(text(key), vars),
    rich: (key, vars) => {
      const parts = text(key).split(/(\{\w+\})/)
      return new Raw(parts.map(part => {
        const match = /^\{(\w+)\}$/.exec(part)
        if (match && (match[1] as string) in vars) {
          const value = vars[match[1] as string]
          return value instanceof Raw ? value.value : escapeHtml(String(value))
        }
        return escapeHtml(part)
      }).join(''))
    },
    dateText: at => (at ? `${dateFormat(tag).format(at)} UTC` : '—'),
    time: at => {
      if (!at) return new Raw('—')
      return new Raw(`<time datetime="${new Date(at).toISOString()}" data-ts="${at}">${escapeHtml(self.dateText(at))}</time>`)
    },
    relative: (at, now = Date.now()) => {
      if (!at) return '—'
      const seconds = Math.round((at - now) / 1000)
      const format = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' })
      const size = Math.abs(seconds)
      if (size < 45) return format.format(0, 'second')
      if (size < 3600) return format.format(Math.round(seconds / 60), 'minute')
      if (size < 86_400) return format.format(Math.round(seconds / 3600), 'hour')
      return format.format(Math.round(seconds / 86_400), 'day')
    },
    countdown: (expiresAt, now = Date.now()) => {
      const { left, hours, minutes, seconds } = countdownParts(expiresAt, now)
      if (left === 0) return text('time.expired')
      if (hours > 0) return fill(text('time.leftHours'), { h: hours, m: minutes })
      return fill(text('time.leftMinutes'), { m: minutes, s: String(seconds).padStart(2, '0') })
    },
    number: value => value.toLocaleString(tag),
    client: () => Object.fromEntries((Object.keys(en) as MessageKey[]).filter(key => key.startsWith('js.') || key.startsWith('time.')).map(key => [key, text(key)])),
  }
  return self
}

/** The translator for a request. */
export function i18nFor(request: Request): I18n {
  return i18n(localeOf(request))
}
