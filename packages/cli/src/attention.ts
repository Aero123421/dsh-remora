/** How items waiting for a human are shown: how to answer them, until when, and where. */
import type { AttentionItem } from '@dsh-remora/protocol'
import { isAllowedEndpoint } from './config.ts'
import { ATTENTION_KIND_LABEL, clean, fmtElapsed, table } from './format.ts'

/** `hub:/path` or `/path` → an absolute URL on the hub; absolute http(s) URLs stay. Anything else → null. */
export function hubLink(hubUrl: string, link: string | undefined | null): string | null {
  if (!link) return null
  if (link.startsWith('hub:/')) return hubUrl + link.slice(4)
  if (link.startsWith('/') && !link.startsWith('//')) return hubUrl + link
  return isAllowedEndpoint(link) ? link : null
}

/** Where the owner answers an approval with a passkey (the hub's attention page). */
export function passkeyUrl(hubUrl: string, item: Pick<AttentionItem, 'answerUrl' | 'hostId' | 'attentionId'>): string {
  return hubLink(hubUrl, item.answerUrl) ?? `${hubUrl}/attention#${encodeURIComponent(item.hostId)}-${encodeURIComponent(item.attentionId)}`
}

/** `あと 4分05秒`, `期限切れ`, or `-`. */
export function countdown(expiresAt: number | null | undefined, now: number): string {
  if (expiresAt === null || expiresAt === undefined || !Number.isFinite(expiresAt)) return '-'
  const left = expiresAt - now
  return left <= 0 ? '期限切れ' : `あと ${fmtElapsed(left)}`
}

export type AnswerRoute = 'remote' | 'hub-passkey' | 'dsh-web'

/** `answerVia`, or a guess from `answerable` for hubs that predate it. */
export function routeOf(item: AttentionItem): AnswerRoute {
  if (item.answerVia) return item.answerVia
  if (item.answerable) return 'remote'
  return item.kind === 'approval' ? 'hub-passkey' : 'dsh-web'
}

export function routeLabel(item: AttentionItem): string {
  switch (routeOf(item)) {
    case 'remote':
      return item.kind === 'approval' ? 'remora approve / reject' : item.kind === 'question' || item.kind === 'plan-review' ? 'remora answer' : 'DSH Web で'
    case 'hub-passkey':
      return 'ハブでパスキー'
    case 'dsh-web':
      return 'DSH Web で'
  }
}

/** The table plus one line per extra (options, passkey links, details). */
export function attentionLines(items: readonly AttentionItem[], hubUrl: string, now: number, withDetail = false): string[] {
  const lines = table(['ID', '種類', 'セッション', '内容', '回答方法', '期限'], items.map(a => [
    a.attentionId,
    ATTENTION_KIND_LABEL[a.kind] ?? a.kind,
    a.sessionId,
    clean(a.title),
    routeLabel(a),
    countdown(a.expiresAt, now),
  ]), 60)
  for (const item of items) {
    if (withDetail && item.detail) lines.push(`  ${item.attentionId}: ${clean(item.detail, true).split('\n').join('\n    ')}`)
    if (item.options?.length) lines.push(`  ${item.attentionId} の選択肢: ${item.options.map(o => `${o.id}=${clean(o.label)}`).join('、')}`)
    if (routeOf(item) === 'hub-passkey') lines.push(`  ${item.attentionId} はハブでパスキーを使って答えます: ${passkeyUrl(hubUrl, item)}`)
  }
  return lines
}

/** One suggested command per answerable item. */
export function nextSteps(items: readonly AttentionItem[]): string[] {
  const steps: string[] = []
  for (const item of items) {
    if (routeOf(item) !== 'remote') continue
    if (item.kind === 'approval') steps.push(`承認: remora approve ${item.attentionId}（拒否は remora reject ${item.attentionId}）`)
    else if (item.kind === 'question') steps.push(`回答: remora answer ${item.attentionId} --text "…"${item.options?.length ? '（または --option <ID>）' : ''}`)
    else if (item.kind === 'plan-review') steps.push(`プラン: remora answer ${item.attentionId} --approve（または --reject、--text "…"）`)
  }
  return steps
}
