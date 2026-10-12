/**
 * Pure readers over a DSH session event log (as returned by
 * `sessionController.inspect`) and projection values. No DSH calls here, so
 * everything is unit-testable with plain arrays.
 */
import type { AttentionItem, AttentionOption, TranscriptItem, TurnPreview } from '@dsh-remora/protocol'
import { redact, redactLine, redactTruncate } from '../redact.ts'
import type { DshPendingUserQuestion, DshProjectionValues, DshQuestionItem, DshSessionEvent } from './dsh-types.ts'

export const ASK_USER_QUESTION = 'ask_user_question'
export const EXIT_PLAN_MODE = 'exit_plan_mode'

/** Concatenated text blocks of a message `content` array. */
export function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('')
}

/** The `source.rpcId` of a user message event or inbox item, when it came from `session.prompt`. */
export function rpcIdOf(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined
  const source = (message as { source?: unknown }).source
  if (!source || typeof source !== 'object') return undefined
  const { kind, rpcId } = source as { kind?: unknown; rpcId?: unknown }
  return kind === 'user' && typeof rpcId === 'string' ? rpcId : undefined
}

export interface TaskTurn {
  /** Seq of the user/message carrying the request id. */
  messageSeq: number
  /** The text the user message carried (used by task.resubmit). */
  text: string
  /** Turn the message entered, or null if it was appended outside a turn. */
  turn: number | null
  /** Set once the turn closed. */
  end: { seq: number; reason: { kind: string; error?: { message?: string; code?: string; status?: number } } } | null
}

/** Locate the turn a request id entered (`source.rpcId` on the durable user message). */
export function findTaskTurn(events: readonly DshSessionEvent[], requestId: string): TaskTurn | null {
  let openTurn: number | null = null
  let found: TaskTurn | null = null
  for (const event of events) {
    if (event.type === 'turn/start') openTurn = numberOr(event.data?.turn, openTurn)
    if (found === null) {
      if (event.type === 'user/message' && rpcIdOf(event.data) === requestId) {
        found = { messageSeq: event.seq, text: contentText(event.data?.content), turn: openTurn, end: null }
      }
    } else if (event.type === 'turn/end' && found.turn !== null && event.data?.turn === found.turn) {
      found.end = { seq: event.seq, reason: event.data?.reason ?? { kind: 'completed' } }
      return found
    }
    if (event.type === 'turn/end') openTurn = null
  }
  return found
}

/** Final assistant reply of one turn (text blocks of the last non-empty assistant message). */
export function turnReply(events: readonly DshSessionEvent[], turn: number): string | null {
  let reply: string | null = null
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data?.turn !== turn) continue
    const text = contentText(event.data?.message?.content)
    if (text.trim() !== '') reply = text
  }
  return reply
}

/** Last assistant reply in the log. */
export function lastReply(events: readonly DshSessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type !== 'assistant/message') continue
    const text = contentText(event.data?.message?.content)
    if (text.trim() !== '') return text
  }
  return null
}

export function countTurns(events: readonly DshSessionEvent[]): number {
  let count = 0
  for (const event of events) if (event.type === 'turn/start') count++
  return count
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Turn previews from the `turnOutline` projection, or rebuilt from the log. */
export function turnPreviews(events: readonly DshSessionEvent[] | null, values: DshProjectionValues | null): TurnPreview[] {
  const outline = values?.turnOutline
  if (Array.isArray(outline) && outline.length > 0) {
    const times = new Map<number, number>()
    for (const event of events ?? []) if (event.type === 'turn/start') times.set(event.seq, event.time)
    return outline.map(entry => ({ index: entry.turn, request: entry.prompt, reply: entry.response, at: times.get(entry.seq) ?? null }))
  }
  const turns: TurnPreview[] = []
  let current: TurnPreview | null = null
  for (const event of events ?? []) {
    if (event.type === 'turn/start') {
      current = { index: numberOr(event.data?.turn, turns.length + 1) ?? turns.length + 1, request: '', reply: '', at: event.time }
      turns.push(current)
    } else if (current && event.type === 'user/message' && current.request === '' && event.data?.source?.kind === 'user') {
      current.request = contentText(event.data?.content)
    } else if (current && event.type === 'assistant/message') {
      const text = contentText(event.data?.message?.content)
      if (text.trim() !== '') current.reply = text
    }
  }
  return turns
}

const TOOL_TEXT_MAX = 2_000
const MESSAGE_TEXT_MAX = 20_000

/** Transcript items for `session.read` depth=page, with their event seq for paging. Redacted. */
export function transcriptItems(events: readonly DshSessionEvent[]): (TranscriptItem & { seq: number })[] {
  const items: (TranscriptItem & { seq: number })[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const kind = event.data?.source?.kind
        if (kind !== 'user' && kind !== 'user-question-reply') break
        items.push({ seq: event.seq, role: 'user', text: redactTruncate(contentText(event.data?.content), MESSAGE_TEXT_MAX).text, at: event.time })
        break
      }
      case 'assistant/message': {
        const text = contentText(event.data?.message?.content)
        if (text.trim() === '') break
        items.push({ seq: event.seq, role: 'assistant', text: redactTruncate(text, MESSAGE_TEXT_MAX).text, at: event.time })
        break
      }
      case 'tool/call': {
        const name = String(event.data?.name ?? 'tool')
        items.push({ seq: event.seq, role: 'tool', toolName: name, text: redactTruncate(`${name} ${String(event.data?.arguments ?? '')}`, TOOL_TEXT_MAX).text, at: event.time })
        break
      }
      case 'tool/result': {
        const message = event.data?.message
        const text = contentText(message?.content)
        items.push({ seq: event.seq, role: 'tool', text: redactTruncate(`${message?.isError ? 'error: ' : ''}${text}`, TOOL_TEXT_MAX).text, at: event.time })
        break
      }
      case 'turn/end': {
        const reason = event.data?.reason
        if (reason?.kind === 'error' || reason?.kind === 'aborted') {
          const text = reason.kind === 'error' ? `turn failed: ${String(reason.error?.message ?? 'error')}` : 'turn cancelled'
          items.push({ seq: event.seq, role: 'system', text: redactLine(text, 500), at: event.time })
        }
        break
      }
    }
  }
  return items
}

// --- attention ------------------------------------------------------------------

export interface AttentionInputs {
  events: readonly DshSessionEvent[] | null
  values: DshProjectionValues | null
  /** Message of the latest `api-session/error` seen for this session, when it looks like an auth failure. */
  loginError?: { message: string; at: number } | null
}

/** Questions parsed from an `ask_user_question` call's raw JSON arguments. */
export function parseQuestions(argumentsJson: unknown): DshQuestionItem[] {
  try {
    const parsed = JSON.parse(String(argumentsJson)) as { questions?: unknown }
    if (!Array.isArray(parsed.questions)) return []
    return parsed.questions.flatMap((item): DshQuestionItem[] => {
      if (!item || typeof item !== 'object') return []
      const q = item as Record<string, unknown>
      if (typeof q.question !== 'string') return []
      const options = Array.isArray(q.options)
        ? q.options.flatMap(o => o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string'
          ? [{ label: (o as { label: string }).label, ...(typeof (o as { description?: unknown }).description === 'string' ? { description: (o as { description: string }).description } : {}) }]
          : [])
        : undefined
      return [{
        id: typeof q.id === 'string' ? q.id : '',
        question: q.question,
        ...(typeof q.header === 'string' ? { header: q.header } : {}),
        ...(options ? { options } : {}),
        ...(q.multi_select === true ? { multiSelect: true } : {}),
      }]
    })
  } catch {
    return []
  }
}

function planOf(argumentsJson: unknown): string {
  try {
    const parsed = JSON.parse(String(argumentsJson)) as { plan?: unknown }
    return typeof parsed.plan === 'string' ? parsed.plan : ''
  } catch {
    return ''
  }
}

function planTitle(plan: string): string {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match) return match[1]!
  }
  return 'Plan'
}

/** Option ids are the option's position, so a long or duplicated label never becomes an id. */
export function optionsOf(question: DshQuestionItem | undefined): AttentionOption[] | undefined {
  if (!question?.options || question.options.length === 0) return undefined
  return question.options.map((option, index) => ({ id: String(index), label: redactLine(option.label, 200) }))
}

function questionDetail(questions: readonly DshQuestionItem[]): string {
  return questions.map((q) => {
    const lines = [q.header ? `${q.header}: ${q.question}` : q.question]
    if (q.detail) lines.push(q.detail)
    for (const [index, option] of (q.options ?? []).entries()) {
      lines.push(`  [${index}] ${option.label}${option.description ? ` — ${option.description}` : ''}`)
    }
    return lines.join('\n')
  }).join('\n\n')
}

const LOGIN_CODES = new Set(['INVALID_CREDENTIAL', 'MISSING_CREDENTIAL'])
const LOGIN_TEXT = /\b(401|unauthori[sz]ed|invalid[_ ]credential|missing[_ ]credential|login (?:expired|required)|re-?authenticate|expired token|token (?:has )?expired)\b/i

/** Whether an LLM failure (or an `api-session/error` message) means the provider login is no longer valid. */
export function isLoginFailure(error: { code?: unknown; status?: unknown; message?: unknown } | string | undefined): boolean {
  if (error === undefined) return false
  if (typeof error === 'string') return LOGIN_TEXT.test(error)
  if (typeof error.code === 'string' && LOGIN_CODES.has(error.code)) return true
  if (error.status === 401) return true
  return typeof error.message === 'string' && LOGIN_TEXT.test(error.message)
}

/**
 * Everything waiting for a human in one session, newest last. `detail` is
 * included (redacted); callers drop it for events and for callers without
 * the dsh.content scope.
 *
 * - approval: `approval/asked` without its `approval/decided`, inside the open turn
 * - question / plan-review: `ask_user_question` / `exit_plan_mode` `tool/call` with
 *   no `tool/result` inside the open turn, plus timed questions the `userQuestions`
 *   projection still lists (those already have a timeout result)
 * - goal-stopped: goal projection phase `blocked`
 * - login-expired: the last turn failed with a credential error, or `api-session/error` said so
 */
export function computeAttention(sessionId: string, input: AttentionInputs): AttentionItem[] {
  const items: AttentionItem[] = []
  const events = input.events ?? []
  const asked = new Map<string, DshSessionEvent>()
  const calls = new Map<string, DshSessionEvent>()
  let lastTurnEnd: DshSessionEvent | null = null
  let lastSuccess = -1
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        asked.clear()
        calls.clear()
        break
      case 'turn/end':
        asked.clear()
        calls.clear()
        lastTurnEnd = event
        break
      case 'approval/asked':
        asked.set(String(event.data?.id), event)
        break
      case 'approval/decided':
        asked.delete(String(event.data?.id))
        break
      case 'tool/call':
        if (event.data?.name === ASK_USER_QUESTION || event.data?.name === EXIT_PLAN_MODE) calls.set(String(event.data.callId), event)
        break
      case 'tool/result':
        calls.delete(String(event.data?.message?.toolCallId))
        break
      case 'assistant/message':
        lastSuccess = event.seq
        break
    }
  }

  for (const [id, event] of asked) {
    const tool = String(event.data?.toolName ?? 'a tool')
    const reason = typeof event.data?.reason === 'string' ? event.data.reason : ''
    items.push({
      attentionId: `approval:${id}`,
      hostId: '',
      sessionId,
      kind: 'approval',
      title: redactLine(`Approve ${tool}${reason ? `: ${reason}` : ''}`),
      ...(reason ? { detail: redact(reason) } : {}),
      answerable: false,
      createdAt: event.time,
    })
  }

  const continued = new Map<string, DshPendingUserQuestion>()
  for (const question of input.values?.userQuestions?.active ?? []) continued.set(question.callId, question)

  for (const [callId, event] of calls) {
    if (event.data?.name === EXIT_PLAN_MODE) {
      const plan = planOf(event.data?.arguments)
      items.push({
        attentionId: callId,
        hostId: '',
        sessionId,
        kind: 'plan-review',
        title: redactLine(`Plan review: ${planTitle(plan)}`),
        detail: redact(plan),
        options: [{ id: 'approve', label: 'Approve' }, { id: 'keep-planning', label: 'Keep planning' }],
        // DSH asks plan reviews through the blocking user-questions waterfall only; no answer API exists.
        answerable: false,
        createdAt: event.time,
      })
      continue
    }
    const pending = continued.get(callId)
    const questions = pending?.questions.length ? [...pending.questions] : parseQuestions(event.data?.arguments)
    items.push(questionItem(sessionId, callId, questions, pending?.state === 'continued', event.time))
    continued.delete(callId)
  }
  for (const [callId, pending] of continued) {
    items.push(questionItem(sessionId, callId, [...pending.questions], pending.state === 'continued', null))
  }

  const goal = input.values?.goal
  if (goal && goal.goal.phase === 'blocked') {
    const reason = goal.goal.blockedReason?.message ?? 'blocked'
    items.push({
      attentionId: `goal:${goal.goal.id}:${goal.goal.revision}`,
      hostId: '',
      sessionId,
      kind: 'goal-stopped',
      title: redactLine(`Goal stopped: ${reason}`),
      detail: redact(`${goal.goal.objective}\n\n${reason}`),
      options: [{ id: 'resume', label: 'Resume' }, { id: 'clear', label: 'Clear' }],
      answerable: true,
      createdAt: goal.updatedAt,
    })
  }

  const endReason = lastTurnEnd?.data?.reason
  const turnLogin = endReason?.kind === 'error' && lastTurnEnd!.seq > lastSuccess && isLoginFailure(endReason.error)
  const liveLogin = input.loginError && isLoginFailure(input.loginError.message)
  if (turnLogin || liveLogin) {
    const message = turnLogin ? String(endReason.error?.message ?? '') : input.loginError!.message
    items.push({
      attentionId: `login:${sessionId}`,
      hostId: '',
      sessionId,
      kind: 'login-expired',
      title: redactLine(`Provider login expired: ${message}`),
      answerable: false,
      createdAt: turnLogin ? lastTurnEnd!.time : input.loginError!.at,
    })
  }
  return items
}

function questionItem(sessionId: string, callId: string, questions: DshQuestionItem[], answerable: boolean, createdAt: number | null): AttentionItem {
  const first = questions[0]
  const options = questions.length === 1 ? optionsOf(first) : undefined
  return {
    attentionId: callId,
    hostId: '',
    sessionId,
    kind: 'question',
    title: redactLine(first ? (first.header ? `${first.header}: ${first.question}` : first.question) : 'Question from the agent'),
    detail: redact(questionDetail(questions)),
    ...(options ? { options } : {}),
    answerable,
    createdAt,
  }
}

// --- deliverables and changes ---------------------------------------------------

export interface ChangesEvent { seq: number; turn: number }

/** `workspace/changes` events (latest per turn wins), optionally for one turn. */
export function changesEvents(events: readonly DshSessionEvent[], turn?: number): ChangesEvent[] {
  const byTurn = new Map<number, number>()
  for (const event of events) {
    if (event.type !== 'workspace/changes') continue
    const t = event.data?.turn
    if (typeof t !== 'number' || (turn !== undefined && t !== turn)) continue
    byTurn.set(t, event.seq)
  }
  return [...byTurn].map(([t, seq]) => ({ seq, turn: t }))
}

export interface PresentedFile { deliverableId: string; path: string; description?: string; turn: number }

/** Files the `present` tool delivered (`deliverables/presented`), optionally for one turn. */
export function presentedFiles(events: readonly DshSessionEvent[], turn?: number): PresentedFile[] {
  const files: PresentedFile[] = []
  for (const event of events) {
    if (event.type !== 'deliverables/presented') continue
    if (turn !== undefined && event.data?.turn !== turn) continue
    const list = Array.isArray(event.data?.files) ? event.data.files : []
    list.forEach((file: { path?: unknown; description?: unknown }, index: number) => {
      if (typeof file?.path !== 'string') return
      files.push({
        deliverableId: `${String(event.data.callId)}#${index}`,
        path: file.path,
        ...(typeof file.description === 'string' ? { description: file.description } : {}),
        turn: Number(event.data?.turn),
      })
    })
  }
  return files
}

/** Skill gestures in a prompt, with the same grammar as DSH's tool-skill. */
export function skillGestures(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g)) {
    const name = match[2]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}
