/**
 * Remora as an answerer in DSH's blocking request chains (Cordis waterfalls):
 *
 *   - `user-questions/request`: `ask_user_question` in its default (legacy)
 *     mode, and plan reviews (`exit_plan_mode`). Timed questions are left
 *     alone; once `continued` they are answered with `userQuestions.answer`.
 *   - `approval/request`: approvals DSH asks for before a tool runs.
 *
 * Remora puts itself first in each chain and, for a request someone outside
 * may answer, hands it on (`next()`) to the other answerers — DSH Web's card,
 * the terminal UI, ACP — while racing it against an answer from outside
 * (`attention.respond`, `approval.respond`). Whichever comes first wins. When
 * the outside answer wins, the cancellation signal handed down the chain is
 * aborted, so DSH Web withdraws its card.
 *
 * When nothing else can answer — the rest of the chain gives up
 * (`NO_PROVIDER` / `'unavailable'`), or no DSH Web tab is connected at all
 * (DSH would otherwise keep the request until one opens) — Remora keeps the
 * request open for the configured wait and then ends it unanswered: a
 * question fails with `NO_PROVIDER` and the agent carries on; an approval
 * comes back `'unavailable'`, which DSH treats as a rejection. While a DSH
 * Web tab is connected its card keeps waiting exactly as before.
 *
 * Remora holds a request only when someone outside could answer it: the wait
 * is not 0, the kill switch is off, the hub link is up, the DSH ceiling
 * allows the answering operation, and the session is in scope in a trusted,
 * ready workspace. Otherwise the request passes through untouched.
 *
 * A hold that later stops qualifying is let go the same way. The session left
 * scope, its workspace is untrusted or not ready, or it was archived: hand the
 * request back while another answerer still has it, and end it with the
 * chain's own give-up only when that chain has already given up. Stopping the
 * hub link for good (unpair, kill switch, revocation) does this at once. A
 * link that is only reconnecting keeps the hold, so an outside answer can
 * still arrive before the wait ends.
 */
import { OperationError, type AnswerPolicy } from '../ops/types.ts'
import type { DshAgent, DshQuestionItem, DshSessionEvent, Disposer } from './dsh-types.ts'
import { ASK_USER_QUESTION, parseQuestions, type HeldAttention } from './events.ts'
import type { Runtime } from './runtime.ts'

/** How often a held request re-checks whether a DSH Web tab is connected. */
const POLL_MS = 15_000
/** Bound on how far back the open turn is searched for the request's tool call. */
const SCAN_LIMIT = 5_000

export type HeldKind = 'question' | 'plan-review' | 'approval'

export interface QuestionWithIntent extends DshQuestionItem {
  intent?: { kind: string; approve: string; callId?: string }
}

/** One request Remora is holding open for an outside answer. */
export interface HeldRequest {
  readonly attentionId: string
  readonly sessionId: string
  readonly kind: HeldKind
  readonly agent: DshAgent
  /** The questions asked (questions and plan reviews). */
  readonly questions: readonly QuestionWithIntent[]
  readonly createdAt: number
  /** When Remora gives up waiting; null while another answerer (DSH Web) holds the request too. */
  expiresAt: number | null
  /** The rest of the chain gave up: only an outside answer can still arrive. */
  alone: boolean
  /** Settle the request with an outside answer. Returns false when it was already settled. */
  answer(value: unknown): boolean
}

interface QuestionRequest {
  questions?: readonly QuestionWithIntent[]
  agent?: DshAgent
  signal?: AbortSignal | undefined
  wait?: { callId?: string; timed?: boolean }
}

interface ApprovalRequest {
  agent?: DshAgent
  toolName?: string
  callId?: string
  reason?: string
  signal?: AbortSignal | undefined
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

/** The in-process session behind a live Agent (`session.seq`, `session.eventAt`). */
interface LiveSession { id: string; seq?: unknown; eventAt?: unknown }

interface Gateway { hasLiveClient?: () => boolean }

/** A NO_PROVIDER `UserQuestionError` as DSH rebuilds it from a plain error (`restoreUserQuestionError`). */
export function noAnswerError(waitMs: number): Error {
  const minutes = Math.max(1, Math.round(waitMs / 60_000))
  const error = new Error(`Nobody answered within ${minutes} min (Remora stopped waiting for an answer from outside). Continue without this answer, or ask again later.`)
  error.name = 'UserQuestionError'
  ;(error as Error & { code: string }).code = 'NO_PROVIDER'
  return error
}

function isNoProvider(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'NO_PROVIDER'
}

export class Answerer {
  private readonly rt: Runtime
  private readonly held = new Map<string, Map<string, HeldRequest>>()
  /** End every request: settle unanswered ones with the chain's own result, hand the rest back to the chain. */
  private readonly releases = new Map<HeldRequest, () => void>()
  private readonly disposers: Disposer[] = []
  private started = false
  /** Bumps when a newer eligibility pass should ignore an older catalog read. */
  private eligibilityEpoch = 0
  /** Called when a session's held requests change (the watcher re-sends its attention). */
  onChange: (sessionId: string) => void = () => undefined

  constructor(rt: Runtime) {
    this.rt = rt
    rt.heldFor = sessionId => this.routes(sessionId)
  }

  private get policy(): AnswerPolicy | undefined {
    return this.rt.deps.answers
  }

  start(): void {
    if (this.started) return
    this.started = true
    const on = this.rt.ctx.on
    if (typeof on !== 'function' || !this.policy) return
    const listen = (name: string, listener: (request: any, next: () => Promise<unknown>) => Promise<unknown>): void => {
      try {
        // First in the chain, for every agent (scope filters do not apply to global listeners).
        const dispose = on.call(this.rt.ctx, name, listener, { global: true, prepend: true })
        if (typeof dispose === 'function') this.disposers.push(dispose)
      } catch (error) {
        this.rt.deps.logger.warn(`Remora: could not answer ${name} remotely`, error)
      }
    }
    listen('user-questions/request', (request: QuestionRequest, next) => this.onQuestion(request, next))
    listen('approval/request', (request: ApprovalRequest, next) => this.onApproval(request, next))
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) {
      try { dispose() } catch { /* gone with the plugin fiber */ }
    }
    this.releaseWhere(() => true)
    this.started = false
  }

  /** Settings changed: let go of requests Remora may no longer hold, and re-send the answer routes. */
  settingsChanged(): void {
    const policy = this.policy
    this.releaseWhere(entry => !policy || policy.waitMs() <= 0 || !policy.allows(entry.kind === 'approval' ? 'approval.respond' : 'attention.respond'))
    this.scheduleEligibilityCheck()
    for (const sessionId of this.held.keys()) this.onChange(sessionId)
  }

  /**
   * The hub link was stopped and will not reconnect. Outside answers can no
   * longer arrive, so a card that is still up keeps the request and a chain
   * that already gave up ends with that result.
   */
  linkStopped(): void {
    this.eligibilityEpoch++
    this.releaseWhere(() => true)
  }

  /** A held request, by session and attention id. */
  find(sessionId: string, attentionId: string): HeldRequest | undefined {
    return this.held.get(sessionId)?.get(attentionId)
  }

  /** Answer routes of the held requests of one session (see computeAttention). */
  routes(sessionId: string): ReadonlyMap<string, HeldAttention> | undefined {
    const entries = this.held.get(sessionId)
    if (!entries || entries.size === 0) return undefined
    const approvalVia = this.policy?.approvalsFromRemote() ? 'remote' : 'hub-passkey'
    return new Map([...entries.values()].map(entry => [entry.attentionId, { via: entry.kind === 'approval' ? approvalVia : 'remote', expiresAt: entry.expiresAt }]))
  }

  // --- the two chains -------------------------------------------------------------

  private async onQuestion(request: QuestionRequest, next: () => Promise<unknown>): Promise<unknown> {
    if (!request || request.wait?.timed === true || !Array.isArray(request.questions) || request.questions.length === 0) return next()
    const agent = request.agent
    const sessionId = await this.eligible('attention.respond', agent, request.signal)
    if (sessionId === null || !agent) return next()
    const plan = request.questions.find(question => question.intent?.kind === 'plan-review')
    const callId = plan?.intent?.callId ?? request.wait?.callId ?? await this.questionCall(agent, sessionId, request.questions).catch(() => null)
    if (typeof callId !== 'string' || this.find(sessionId, callId)) return next()
    return this.hold({ attentionId: callId, sessionId, kind: plan ? 'plan-review' : 'question', agent, questions: request.questions }, request, next, {
      gaveUp: outcome => !outcome.ok && isNoProvider(outcome.error),
      unanswered: waitMs => ({ ok: false, error: noAnswerError(waitMs) }),
    })
  }

  private async onApproval(request: ApprovalRequest, next: () => Promise<unknown>): Promise<unknown> {
    if (!request || typeof request.toolName !== 'string') return next()
    const agent = request.agent
    const sessionId = await this.eligible('approval.respond', agent, request.signal)
    if (sessionId === null || !agent) return next()
    const id = await this.approvalId(agent, sessionId, request).catch(() => null)
    if (id === null) return next()
    return this.hold({ attentionId: `approval:${id}`, sessionId, kind: 'approval', agent, questions: [] }, request, next, {
      gaveUp: outcome => outcome.ok && outcome.value === 'unavailable',
      unanswered: () => ({ ok: true, value: 'unavailable' }),
    })
  }

  /** The session id when Remora may hold this request, else null. */
  private async eligible(operation: 'attention.respond' | 'approval.respond', agent: DshAgent | undefined, signal: AbortSignal | undefined): Promise<string | null> {
    const policy = this.policy
    if (!policy || policy.waitMs() <= 0 || !policy.allows(operation) || !policy.linked()) return null
    if (signal?.aborted) return null
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return null
    try {
      const row = await this.rt.row(sessionId, AbortSignal.timeout(5_000))
      // Subagent sessions are reached through their parent; their requests pass through untouched.
      if (row.subagent || row.archived) return null
      this.rt.assertCanDriveTurns(row.workspace?.id ?? null)
    } catch {
      return null
    }
    return sessionId
  }

  // --- holding ----------------------------------------------------------------------

  private hold(
    base: Pick<HeldRequest, 'attentionId' | 'sessionId' | 'kind' | 'agent' | 'questions'>,
    request: { signal?: AbortSignal | undefined },
    next: () => Promise<unknown>,
    rules: { gaveUp(outcome: Outcome): boolean; unanswered(waitMs: number): Outcome },
  ): Promise<unknown> {
    const original = request.signal
    if (original?.aborted) return next()
    return new Promise((resolve, reject) => {
      const settle = (outcome: Outcome) => (outcome.ok ? resolve(outcome.value) : reject(outcome.error))
      // The signal the rest of the chain sees: follows the caller's, and also
      // aborts when an outside answer wins so DSH Web withdraws its card.
      const handedDown = new AbortController()
      let swapped = false
      try {
        request.signal = handedDown.signal
        swapped = request.signal === handedDown.signal
      } catch {
        // A frozen request: DSH Web's card then stays up after an outside answer until the turn ends.
      }
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let downstream: Outcome | null = null
      const fromChain = Promise.resolve().then(next)
      const entry: HeldRequest = {
        ...base,
        createdAt: Date.now(),
        expiresAt: null,
        alone: false,
        answer: (value: unknown) => {
          if (done) return false
          finish({ ok: true, value }, true)
          return true
        },
      }

      const finish = (outcome: Outcome | 'chain', withdraw: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.remove(entry)
        if (withdraw) handedDown.abort(new Error('answered from outside through Remora'))
        if (swapped) {
          try {
            if (original === undefined) delete request.signal
            else request.signal = original
          } catch { /* see above */ }
        }
        if (outcome === 'chain') fromChain.then(resolve, reject)
        else settle(outcome)
      }

      const waitMs = (): number => this.policy?.waitMs() ?? 0
      const tick = (): void => {
        if (done) return
        // Scope, trust and archive can change without a settings write. A
        // reconnecting link is left alone; linkStopped covers a link that is gone.
        this.scheduleEligibilityCheck()
        const now = Date.now()
        if (entry.alone) {
          if (entry.expiresAt === null || now >= entry.expiresAt) { finish(rules.unanswered(waitMs()), false); return }
          schedule(entry.expiresAt - now)
          return
        }
        // The rest of the chain still holds the request.
        if (this.webConnected() !== false) {
          // DSH Web's card (or another answerer we cannot see) waits as before: no deadline.
          if (entry.expiresAt !== null) { entry.expiresAt = null; this.onChange(entry.sessionId) }
          schedule(POLL_MS)
          return
        }
        if (entry.expiresAt === null) { entry.expiresAt = now + waitMs(); this.onChange(entry.sessionId) }
        if (now >= entry.expiresAt) {
          this.rt.deps.logger.warn(`Remora: nobody answered ${entry.kind} ${entry.attentionId} in session ${entry.sessionId}; DSH continues without an answer`)
          finish(rules.unanswered(waitMs()), true)
          return
        }
        schedule(Math.min(POLL_MS, entry.expiresAt - now))
      }
      const schedule = (delay: number): void => {
        clearTimeout(timer)
        // Not unref'd: the deadline must fire even if nothing else is pending (dispose clears it).
        timer = setTimeout(tick, Math.max(0, Math.min(delay, 2 ** 31 - 1)))
      }

      original?.addEventListener('abort', () => {
        handedDown.abort(original.reason)
        finish({ ok: false, error: original.reason ?? new Error('aborted') }, false)
      }, { once: true })

      fromChain.then(
        value => { downstream = { ok: true, value } },
        (error: unknown) => { downstream = { ok: false, error } },
      ).then(() => {
        if (done || downstream === null) return
        if (!rules.gaveUp(downstream)) { finish(downstream, false); return }
        // Nobody else can answer: keep it open for an outside answer until the wait ends.
        entry.alone = true
        if (entry.expiresAt === null) entry.expiresAt = Date.now() + waitMs()
        this.onChange(entry.sessionId)
        tick()
      })

      this.releases.set(entry, () => finish(entry.alone ? (downstream ?? rules.unanswered(waitMs())) : 'chain', false))
      this.add(entry)
      if (this.webConnected() === false) entry.expiresAt = entry.createdAt + waitMs()
      this.onChange(entry.sessionId)
      schedule(entry.expiresAt === null ? POLL_MS : Math.min(POLL_MS, entry.expiresAt - entry.createdAt))
    })
  }

  private add(entry: HeldRequest): void {
    const entries = this.held.get(entry.sessionId) ?? new Map<string, HeldRequest>()
    entries.set(entry.attentionId, entry)
    this.held.set(entry.sessionId, entries)
  }

  private remove(entry: HeldRequest): void {
    this.releases.delete(entry)
    const entries = this.held.get(entry.sessionId)
    if (entries?.get(entry.attentionId) !== entry) return
    entries.delete(entry.attentionId)
    if (entries.size === 0) this.held.delete(entry.sessionId)
    this.onChange(entry.sessionId)
  }

  private releaseWhere(test: (entry: HeldRequest) => boolean): void {
    for (const [entry, release] of [...this.releases]) if (test(entry)) release()
  }

  /** Re-read each held session. A newer pass cancels an older one before it lets go. */
  private scheduleEligibilityCheck(): void {
    const epoch = ++this.eligibilityEpoch
    const entries = [...this.releases.keys()]
    if (entries.length === 0) return
    void this.dropIneligible(entries, epoch)
  }

  private async dropIneligible(entries: readonly HeldRequest[], epoch: number): Promise<void> {
    for (const entry of entries) {
      if (this.eligibilityEpoch !== epoch) return
      const release = this.releases.get(entry)
      if (!release) continue
      const decision = await this.sessionStillEligible(entry)
      if (this.eligibilityEpoch !== epoch) return
      if (decision === 'release') release()
    }
  }

  /**
   * `release` only when this session is positively no longer one Remora may
   * drive. A catalog timeout or an unknown failure keeps the hold: ending it
   * would reject an approval the owner can still answer.
   */
  private async sessionStillEligible(entry: HeldRequest): Promise<'keep' | 'release'> {
    try {
      const row = await this.rt.row(entry.sessionId, AbortSignal.timeout(5_000))
      if (row.subagent || row.archived) return 'release'
      this.rt.assertCanDriveTurns(row.workspace?.id ?? null)
      return 'keep'
    } catch (error) {
      if (error instanceof OperationError && (error.code === 'denied' || error.code === 'conflict' || error.code === 'gone' || error.code === 'not_found')) return 'release'
      return 'keep'
    }
  }

  /** Whether a DSH Web tab is connected; null when this DSH cannot tell (no gateway, e.g. the terminal UI). */
  private webConnected(): boolean | null {
    const gateway = this.rt.get<Gateway>('typertGateway')
    if (!gateway || typeof gateway.hasLiveClient !== 'function') return null
    try {
      return gateway.hasLiveClient()
    } catch {
      return null
    }
  }

  // --- finding the attention item a request belongs to -------------------------------

  /** Events of the open turn, oldest first: read in-process from the live session, else through inspect. */
  private async openTurn(agent: DshAgent, sessionId: string): Promise<DshSessionEvent[]> {
    const session = agent.session as LiveSession
    if (typeof session.seq === 'number' && typeof session.eventAt === 'function') {
      const events: DshSessionEvent[] = []
      const eventAt = session.eventAt as (seq: number) => { type?: unknown; data?: unknown; time?: unknown } | undefined
      for (let seq = session.seq - 1; seq >= 0 && events.length < SCAN_LIMIT; seq--) {
        const event = eventAt.call(session, seq)
        if (!event || typeof event.type !== 'string') continue
        if (event.type === 'turn/start') break
        events.push({ type: event.type, seq, time: typeof event.time === 'number' ? event.time : 0, data: event.data })
      }
      return events.reverse()
    }
    const all = await this.rt.events(sessionId, AbortSignal.timeout(5_000))
    let start = 0
    for (let index = all.length - 1; index >= 0; index--) {
      if (all[index]!.type === 'turn/start') { start = index + 1; break }
    }
    return all.slice(start)
  }

  /** The unanswered `ask_user_question` call these questions came from (the legacy tool does not pass its call id). */
  private async questionCall(agent: DshAgent, sessionId: string, questions: readonly QuestionWithIntent[]): Promise<string | null> {
    const events = await this.openTurn(agent, sessionId)
    const answered = new Set(events.filter(event => event.type === 'tool/result').map(event => String(event.data?.message?.toolCallId)))
    const candidates = events.filter(event => event.type === 'tool/call' && event.data?.name === ASK_USER_QUESTION
      && !answered.has(String(event.data?.callId)) && !this.find(sessionId, String(event.data?.callId)))
    const first = questions[0]?.question
    const matching = candidates.filter(event => parseQuestions(event.data?.arguments)[0]?.question === first)
    const pick = matching.at(-1) ?? (candidates.length === 1 ? candidates[0] : undefined)
    return pick ? String(pick.data.callId) : null
  }

  /** The `approval/asked` id DSH logged for this request just before asking. */
  private async approvalId(agent: DshAgent, sessionId: string, request: ApprovalRequest): Promise<string | null> {
    const events = await this.openTurn(agent, sessionId)
    const decided = new Set(events.filter(event => event.type === 'approval/decided').map(event => String(event.data?.id)))
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!
      if (event.type !== 'approval/asked') continue
      const id = String(event.data?.id)
      if (decided.has(id) || this.find(sessionId, `approval:${id}`)) continue
      if (event.data?.toolName !== request.toolName) continue
      if (request.callId !== undefined && event.data?.callId !== request.callId) continue
      return id
    }
    return null
  }
}
