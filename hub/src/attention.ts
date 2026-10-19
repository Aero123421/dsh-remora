/**
 * Helpers for items waiting for a human: the hub page that answers one item,
 * how an item can be answered right now, and the short, redacted text used
 * in push notifications. Pure, so it is unit-tested under Node.
 */
import type { AttentionItem } from './vendor/protocol/api.ts'

const ATTENTION_KINDS = new Set(['approval', 'question', 'plan-review', 'goal-stopped', 'login-expired'])

/** The hub path that opens straight on one item. */
export function answerPath(hostId: string, attentionId: string): string {
  return `/attention/${encodeURIComponent(hostId)}/${encodeURIComponent(attentionId)}`
}

export function answerUrl(origin: string, hostId: string, attentionId: string): string {
  return `${origin}${answerPath(hostId, attentionId)}`
}

function isAttentionItem(value: Record<string, unknown>): boolean {
  return typeof value.attentionId === 'string' && typeof value.hostId === 'string' && value.hostId !== '' && typeof value.sessionId === 'string' && typeof value.kind === 'string' && ATTENTION_KINDS.has(value.kind)
}

/**
 * Fill in `answerUrl` on every attention item inside a result (status,
 * attention.list, task.get, session.get, …). Iterative, cycle-safe.
 */
export function stampAnswerUrls<T>(value: T, origin: string): T {
  const stack: unknown[] = [value]
  const seen = new Set<object>()
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === null || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    if (Array.isArray(item)) {
      for (const child of item) stack.push(child)
      continue
    }
    const record = item as Record<string, unknown>
    if (isAttentionItem(record)) record.answerUrl = answerUrl(origin, record.hostId as string, record.attentionId as string)
    for (const key of Object.keys(record)) stack.push(record[key])
  }
  return value
}

export type AnswerRoute = 'expired' | 'passkey' | 'remote' | 'dsh-web'

/**
 * How the hub page can answer an item now. `answerVia` decides when the
 * host sends it; older plugins only send `answerable`.
 */
export function answerRoute(item: Pick<AttentionItem, 'kind' | 'answerable' | 'answerVia' | 'expiresAt'>, now = Date.now()): AnswerRoute {
  if (typeof item.expiresAt === 'number' && item.expiresAt <= now) return 'expired'
  if (item.answerVia === 'dsh-web') return 'dsh-web'
  if (item.kind === 'approval') return item.answerVia === 'hub-passkey' || item.answerVia === 'remote' || item.answerable ? 'passkey' : 'dsh-web'
  if (item.kind === 'question' || item.kind === 'plan-review') return item.answerVia === 'remote' || (item.answerVia === undefined && item.answerable) ? 'remote' : 'dsh-web'
  return 'dsh-web'
}

const SECRET_LIKE = [
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs]|AKIA|ASIA|AIza|glpat|hf|rmr_pat)[-_A-Za-z0-9]{8,}/g,
  /\b[A-Za-z0-9+/_=-]{32,}/g,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+/g,
]

/** One line, secret-looking strings masked, at most 80 characters: safe to put in a push notification. */
export function pushText(text: string, max = 80): string {
  let line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  for (const pattern of SECRET_LIKE) line = line.replace(pattern, '•••')
  const chars = Array.from(line)
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : line
}
