/** Post-login redirect target validation. Pure, so it is unit-tested under Node. */
/**
 * Where to go after signing in: a path on this origin only. Control
 * characters and backslashes are refused outright (browsers strip or
 * normalise them, turning `/\t/evil.com` or `/\\evil.com` into another host).
 * The same rule is in public/js/webauthn.js.
 */
export function safeNext(value: string | null | undefined, origin: string): string {
  if (!value || !value.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value)) return '/'
  try {
    const url = new URL(value, origin)
    if (url.origin !== origin) return '/'
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return '/'
  }
}
