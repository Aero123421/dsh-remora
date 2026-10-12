/** HTTP helpers: JSON and error bodies, cookies, CSRF origin checks. */
import { HTTP_STATUS_FOR_ERROR, type HttpErrorBody, type RemoraError } from './vendor/protocol/index.ts'

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store')
  return new Response(JSON.stringify(body), { ...init, headers })
}

export function errorResponse(error: RemoraError, headers: HeadersInit = {}): Response {
  const body: HttpErrorBody = { error }
  return json(body, { status: HTTP_STATUS_FOR_ERROR[error.code] ?? 500, headers })
}

export function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) if (!headers.has(key)) headers.set(key, value)
  headers.set('content-type', 'text/html; charset=utf-8')
  return new Response(body, { ...init, headers })
}

export function redirect(location: string, headers: HeadersInit = {}, status = 303): Response {
  const out = new Headers(headers)
  out.set('location', location)
  out.set('cache-control', 'no-store')
  return new Response(null, { status, headers: out })
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

export function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

/**
 * CSRF defence for cookie-authenticated, state-changing requests: on top of
 * SameSite=Strict, the request must come from the hub's own origin.
 */
export function sameOrigin(request: Request, origin: string): boolean {
  const sent = request.headers.get('origin')
  if (sent !== null) return sent === origin
  const site = request.headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin'
  const referer = request.headers.get('referer')
  if (referer !== null) {
    try {
      return new URL(referer).origin === origin
    } catch {
      return false
    }
  }
  return false
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown'
}

export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > maxBytes) throw new Error('body too large')
  const text = await request.text()
  if (text.length > maxBytes) throw new Error('body too large')
  return text === '' ? {} : JSON.parse(text)
}

/** Read a body as UTF-8 regardless of its content type (workerd warns on `.text()` for form bodies). */
export async function bodyText(request: Request): Promise<string> {
  return new TextDecoder().decode(await request.arrayBuffer())
}

export async function readForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/x-www-form-urlencoded')) return new URLSearchParams(await bodyText(request))
  if (type.includes('multipart/form-data')) {
    const form = await request.formData()
    const params = new URLSearchParams()
    for (const [key, value] of form) if (typeof value === 'string') params.append(key, value)
    return params
  }
  return new URLSearchParams()
}
