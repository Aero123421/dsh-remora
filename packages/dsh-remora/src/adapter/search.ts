/**
 * sessions.search: find words in the titles, prompts and replies of the
 * sessions the caller may reach. DSH Web ships its full-text index switched
 * off (`session-query-sqlite` with `openAt: never`), so Remora scans the
 * session logs itself through the non-waking `inspect` read: newest sessions
 * first, within a time and size budget, reporting `partial` when it stops
 * early.
 */
import type { OperationParams, OperationResults, SearchHit } from '@dsh-remora/protocol'
import type { OperationContext } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redactLine } from '../redact.ts'
import { contentText } from './events.ts'
import { hasContent, type Runtime } from './runtime.ts'

type Params<Op extends keyof OperationParams> = OperationParams[Op]
type Result<Op extends keyof OperationResults> = OperationResults[Op]

export const SEARCH_BUDGET = { sessions: 300, ms: 8_000, hitsPerSession: 5 }

/** Lower-cased words of a query (at most 8). */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8)
}

/** Text around the first word, on one line, redacted. */
export function snippet(text: string, words: readonly string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  const at = Math.max(0, Math.min(...words.map(word => lower.indexOf(word)).filter(index => index >= 0)))
  const start = Math.max(0, at - 80)
  const end = Math.min(flat.length, at + 160)
  return redactLine(`${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`, 260)
}

export function createSearch(rt: Runtime) {
  return {
    async 'sessions.search'(params: Params<'sessions.search'>, context: OperationContext): Promise<Result<'sessions.search'>> {
      if (!hasContent(context)) throw new OperationError('denied', 'searching session text needs the dsh.content scope', { denial: { layer: 'token', reason: 'missing-scope' } })
      const words = queryWords(params.query)
      if (words.length === 0) throw new OperationError('invalid_request', 'give at least one word to search for')
      const matches = (text: string) => {
        const lower = text.toLowerCase()
        return words.every(word => lower.includes(word))
      }
      if (params.sessionId !== undefined) await rt.row(params.sessionId, context.signal)
      const rows = (await rt.catalog(context.signal))
        .filter(row => rt.canAccess(row)
          && (params.workspaceId === undefined || row.workspace?.id === params.workspaceId)
          && (params.sessionId === undefined || row.sessionId === params.sessionId))
        .sort((a, b) => (b.summary.updatedAt ?? 0) - (a.summary.updatedAt ?? 0))
      const limit = params.limit ?? 20
      const deadline = Date.now() + SEARCH_BUDGET.ms
      const hits: SearchHit[] = []
      let scanned = 0
      let partial = false
      for (const [index, row] of rows.entries()) {
        if (hits.length >= limit) {
          partial = index < rows.length
          break
        }
        if (scanned >= SEARCH_BUDGET.sessions || Date.now() > deadline) {
          partial = true
          break
        }
        context.signal.throwIfAborted()
        scanned++
        const base = { sessionId: row.sessionId, title: redactLine(row.title || 'New session', 200), workspaceId: row.workspace?.id ?? null }
        const found: SearchHit[] = []
        if (row.title && matches(row.title)) found.push({ ...base, role: 'title', turn: null, at: row.summary.updatedAt ?? null, snippet: snippet(row.title, words) })
        let events
        try {
          events = await rt.events(row.sessionId, context.signal)
        } catch {
          continue
        }
        let turn: number | null = null
        for (const event of events) {
          if (found.length >= SEARCH_BUDGET.hitsPerSession) break
          if (event.type === 'turn/start') turn = typeof event.data?.turn === 'number' ? event.data.turn : turn
          let role: 'user' | 'assistant' | null = null
          let text = ''
          if (event.type === 'user/message' && (event.data?.source?.kind === 'user' || event.data?.source?.kind === 'user-question-reply')) {
            role = 'user'
            text = contentText(event.data?.content)
          } else if (event.type === 'assistant/message') {
            role = 'assistant'
            text = contentText(event.data?.message?.content)
          }
          if (role !== null && text !== '' && matches(text)) found.push({ ...base, role, turn, at: event.time, snippet: snippet(text, words) })
        }
        hits.push(...found)
      }
      return { hits: hits.slice(0, limit), scanned, partial, untrusted: true }
    },
  }
}
