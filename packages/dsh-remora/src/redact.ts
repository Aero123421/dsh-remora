/**
 * Secret masking applied to every piece of text that leaves the DSH host
 * (titles, transcript text, questions, patches, deliverables, job output,
 * command output). Best effort: it catches common credential shapes, not
 * every secret. The mask keeps a short, non-secret prefix so a reader can
 * tell what kind of value was hidden.
 */

export const MASK = '[REDACTED]'

interface Rule {
  pattern: RegExp
  replace: (match: string, ...groups: string[]) => string
}

const keep = (prefix: string): string => `${prefix}${MASK}`

const RULES: readonly Rule[] = [
  // PEM private keys (RSA, EC, OPENSSH, PGP, ...). Whole block, including an unterminated tail.
  {
    pattern: /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g,
    replace: (_m, kind) => `-----BEGIN ${kind}-----\n${MASK}\n-----END ${kind}-----`,
  },
  // Authorization headers and bearer tokens.
  {
    pattern: /\b(Authorization\s*[:=]\s*["']?(?:Bearer|Basic|Token|Bot)\s+)[^\s"',;]+/gi,
    replace: (_m, head) => keep(head),
  },
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, replace: (_m, head) => keep(head) },
  // Anthropic before OpenAI (both start with sk-).
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: () => keep('sk-ant-') },
  { pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, replace: () => keep('sk-') },
  // GitHub tokens.
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: () => keep('github_pat_') },
  { pattern: /\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, replace: (_m, head) => keep(head) },
  // GitLab, Slack, Google, Stripe, npm, Hugging Face.
  { pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: () => keep('glpat-') },
  { pattern: /\b(xox[abposr]-)[A-Za-z0-9-]{10,}/g, replace: (_m, head) => keep(head) },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: () => keep('AIza') },
  { pattern: /\b((?:sk|rk|pk)_(?:live|test)_)[A-Za-z0-9]{16,}/g, replace: (_m, head) => keep(head) },
  { pattern: /\bnpm_[A-Za-z0-9]{30,}/g, replace: () => keep('npm_') },
  { pattern: /\bhf_[A-Za-z0-9]{30,}/g, replace: () => keep('hf_') },
  // AWS access key ids and secret keys.
  { pattern: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{4})[A-Z0-9]{12}\b/g, replace: (_m, head) => keep(head) },
  {
    pattern: /\b(aws_?secret_?(?:access_?)?key(?:_id)?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{30,}/gi,
    replace: (_m, head) => keep(head),
  },
  // JWT-looking tokens (header.payload.signature, base64url, header starting with {").
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: () => keep('eyJ') },
  // URL credentials: https://user:password@host
  { pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, replace: (_m, head) => `${head}${MASK}@` },
  // .env style assignments: FOO_KEY=..., API_TOKEN: "...", DB_PASSWORD = ...
  {
    pattern: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*["']?[ \t]*[:=][ \t]*)(["']?)([^\s"',;]{4,})\2/g,
    replace: (match, head, quote, value) => maskAssignment(match, head, quote, value),
  },
  // lower-case config keys (client_secret: ..., api_key = "...") only when the value looks random.
  {
    pattern: /\b([a-z0-9_]*(?:api_?key|secret|token|password|passwd)[a-z0-9_]*["']?[ \t]*[:=][ \t]*)(["']?)([A-Za-z0-9_\-+/=.~]{12,})\2/g,
    replace: (match, head, quote, value) => /\d/.test(value) ? maskAssignment(match, head, quote, value) : match,
  },
]

function maskAssignment(match: string, head: string, quote: string, value: string): string {
  if (value.includes(MASK) || /^(?:true|false|null|none|undefined)$/i.test(value)) return match
  return `${head}${quote}${MASK}${quote}`
}

/** Mask secrets in `text`. Idempotent: redacting twice changes nothing more. */
export function redact(text: string): string {
  let out = text
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replace as (substring: string, ...args: any[]) => string)
  return out
}

/** Redact and cut to at most `max` characters (UTF-16 units), marking the cut. */
/**
 * Output whose head was cut off (a tail kept from a longer stream) can start
 * in the middle of a secret, past the prefix that redaction recognizes. Drop
 * that first partial line before redacting (or, without a line break near
 * the start, the first 256 characters).
 */
export function dropPartialHead(text: string): string {
  const newline = text.indexOf('\n')
  if (newline >= 0 && newline < 4096) return text.slice(newline + 1)
  return text.length > 256 ? `…${text.slice(256)}` : ''
}

export function redactTruncate(text: string, max: number): { text: string; truncated: boolean } {
  const masked = redact(text)
  if (masked.length <= max) return { text: masked, truncated: false }
  return { text: `${masked.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

/** One-line, redacted summary of at most `max` characters. */
export function redactLine(text: string, max = 120): string {
  return redactTruncate(text.replace(/\s+/g, ' ').trim(), max).text
}
