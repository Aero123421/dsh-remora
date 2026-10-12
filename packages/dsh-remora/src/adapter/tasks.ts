/**
 * Tasks: delivering prompts exactly once, and following them to completion.
 *
 * Exactly-once: the task record (with `requestId = remora:<clientId>:<taskId>`)
 * is persisted BEFORE `session.prompt`; a retry calls prompt again with the
 * same requestId and DSH answers with the original acceptance.
 *
 * Completion: the task's turn is the one whose user message carries
 * `source.rpcId === requestId`. The task is completed when that turn ended,
 * the session is idle (no running Agent and nothing reported by the
 * `workspace/session-activity` waterfall), its queue is empty and nothing
 * needs a human.
 */
import { createHash } from 'node:crypto'
import {
  remoraRequestId, TASK_WAIT_MAX_MS, TERMINAL_TASK_STATES,
  type AttentionItem, type DeliverableRef, type OperationParams, type OperationResults, type RemoraError, type TaskInfo, type TaskState,
} from '@dsh-remora/protocol'
import type { OperationContext, TaskRecord } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redactLine, redactTruncate } from '../redact.ts'
import type {
  DshProjectionValues, DshSessionEvent, DshSessionSkillCatalog, DshSkills, DshWorkspace, DshWorkspaceChanges,
} from './dsh-types.ts'
import { SERVICES } from './dsh-types.ts'
import { denied, fromDsh, invalid, notFound } from './errors.ts'
import {
  changesEvents, computeAttention, contentText, findTaskTurn, presentedFiles, rpcIdOf, skillGestures, spanReply,
} from './events.ts'
import { forCaller } from './reads.ts'
import { hasContent, type Runtime, type SessionRow } from './runtime.ts'

type Params<Op extends keyof OperationParams> = OperationParams[Op]
type Result<Op extends keyof OperationResults> = OperationResults[Op]

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Activity families that keep a task running. Schedules are long-lived and never block completion. */
const BLOCKING_ACTIVITY = new Set(['turn', 'subagent', 'job'])

interface Evaluation {
  state: TaskState
  error?: RemoraError
  attention: AttentionItem[]
  events: readonly DshSessionEvent[]
  /** The task's turns (its own and DSH-started follow-ups), empty until it entered one. */
  turns: number[]
}

/** Deterministic DSH session id for a `new` target, so a retried task.start adopts instead of creating twice. */
export function sessionIdFor(requestId: string): string {
  const hex = createHash('sha256').update(requestId).digest('hex')
  return `session-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export class Tasks {
  private readonly rt: Runtime
  /** Tasks whose prompt call is in flight: evaluation must not judge them yet. */
  private readonly inflight = new Set<string>()
  private readonly waiters = new Map<string, Set<() => void>>()

  constructor(rt: Runtime) {
    this.rt = rt
  }

  // --- records ---------------------------------------------------------------

  private own(taskId: string, context: OperationContext): TaskRecord {
    const record = this.rt.deps.tasks.get(taskId)
    if (!record || record.clientId !== context.actor.clientId) throw notFound(`task ${taskId} not found on this host`)
    return record
  }

  private async save(record: TaskRecord, state: TaskState, error?: RemoraError): Promise<TaskRecord> {
    if (record.state === state && error === undefined) return record
    const next: TaskRecord = { ...record, state, updatedAt: Date.now() }
    if (error) next.error = error
    else delete next.error
    await this.rt.deps.tasks.put(next)
    this.rt.deps.emit({
      kind: 'task',
      taskId: next.taskId,
      state: next.state,
      ...(next.sessionId ? { sessionId: next.sessionId } : {}),
      updatedAt: next.updatedAt,
      ...(next.error ? { error: next.error } : {}),
    })
    for (const wake of this.waiters.get(next.taskId) ?? []) wake()
    return next
  }

  /** Active (non-terminal) tasks, optionally of one session. */
  active(sessionId?: string): TaskRecord[] {
    return this.rt.deps.tasks.list().filter(record =>
      !TERMINAL_TASK_STATES.has(record.state) && record.state !== 'parked'
      && (sessionId === undefined || record.sessionId === sessionId))
  }

  // --- evaluation --------------------------------------------------------------

  private async activity(sessionId: string): Promise<boolean> {
    if (this.rt.isRunning(sessionId)) return true
    const waterfall = this.rt.ctx.waterfall
    if (typeof waterfall !== 'function') return false
    try {
      const list = await waterfall.call(this.rt.ctx, 'workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      return Array.isArray(list) && list.some(item => BLOCKING_ACTIVITY.has(String((item as { kind?: unknown }).kind)))
    } catch {
      return false
    }
  }

  async evaluate(record: TaskRecord, signal: AbortSignal, preloaded?: { events: readonly DshSessionEvent[]; values: DshProjectionValues | null }): Promise<Evaluation> {
    const unchanged = (): Evaluation => ({ state: record.state, attention: [], events: [], turns: [], ...(record.error ? { error: record.error } : {}) })
    if (record.sessionId === null || TERMINAL_TASK_STATES.has(record.state) || this.inflight.has(record.taskId)) return unchanged()
    const sessionId = record.sessionId
    const events = preloaded?.events ?? await this.rt.events(sessionId, signal)
    const values = preloaded ? preloaded.values : await this.rt.projections(sessionId, signal)
    const attention = computeAttention(sessionId, { events, values, loginError: this.rt.loginErrors.get(sessionId) ?? null })
    const turn = findTaskTurn(events, record.requestId)
    const base = { attention, events, turns: turn?.turns ?? [] }
    if (!turn) {
      const queued = [...values?.inbox?.['next-turn'] ?? [], ...values?.inbox?.['next-step'] ?? []].some(item => rpcIdOf(item) === record.requestId)
      if (queued) return { ...base, state: 'accepted' }
      if (record.state === 'accepted' && !this.rt.isRunning(sessionId)) {
        // Neither logged nor queued after DSH accepted it. Either a turn claimed it and
        // failed before logging the message, or someone removed it from the queue.
        const failedTurn = events.findLast(event => event.type === 'turn/end' && event.time >= record.createdAt - 1000)
        const reason = failedTurn?.data?.reason
        if (reason?.kind === 'error') {
          return { ...base, state: 'failed', error: { code: 'internal', message: redactLine(`the turn failed: ${String(reason.error?.message ?? 'error')}`, 500) } }
        }
        return { ...base, state: 'cancelled' }
      }
      return { ...base, state: record.state }
    }
    if (!turn.end) return { ...base, state: attention.length > 0 ? 'needs_attention' : 'running' }
    const reason = turn.end.reason
    switch (reason.kind) {
      case 'aborted':
        return { ...base, state: 'cancelled' }
      case 'error':
        if (attention.some(item => item.kind === 'login-expired')) return { ...base, state: 'needs_attention' }
        return { ...base, state: 'failed', error: { code: 'internal', message: redactLine(`the turn failed: ${reason.error?.message ?? 'error'}`, 500) } }
      case 'blocked':
        return { ...base, state: 'failed', error: { code: 'conflict', message: 'DSH blocked the turn (the session is archived)' } }
      case 'interrupted':
      case 'forked':
        return { ...base, state: 'failed', error: { code: 'internal', message: 'the turn was interrupted (DSH stopped while it ran)' } }
    }
    if (attention.length > 0) return { ...base, state: 'needs_attention' }
    const queue = (values?.inbox?.['next-turn']?.length ?? 0) + (values?.inbox?.['next-step']?.length ?? 0)
    if (queue > 0 || await this.activity(sessionId)) return { ...base, state: 'running' }
    return { ...base, state: 'completed' }
  }

  /** Re-evaluate one task and persist/emit a state change. */
  async refresh(record: TaskRecord, signal: AbortSignal, preloaded?: { events: readonly DshSessionEvent[]; values: DshProjectionValues | null }): Promise<{ record: TaskRecord; evaluation: Evaluation }> {
    let evaluation: Evaluation
    try {
      evaluation = await this.evaluate(record, signal, preloaded)
    } catch (error) {
      if (error instanceof OperationError && error.code === 'gone' && !TERMINAL_TASK_STATES.has(record.state)) {
        const next = await this.save(record, 'failed', { code: 'gone', message: error.message })
        return { record: next, evaluation: { state: 'failed', attention: [], events: [], turns: [] } }
      }
      throw error
    }
    const next = await this.save(record, evaluation.state, evaluation.error)
    return { record: next, evaluation }
  }

  async info(record: TaskRecord, context: OperationContext, evaluation?: Evaluation): Promise<TaskInfo> {
    const info: TaskInfo = {
      taskId: record.taskId,
      hostId: '',
      sessionId: record.sessionId,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.error ? { error: record.error } : {}),
    }
    if (record.sessionId === null) return info
    info.hasLiveClient = this.rt.hasLiveClient(record.sessionId)
    if (record.state === 'needs_attention') {
      info.attention = forCaller(evaluation?.attention ?? computeAttention(record.sessionId, {
        events: await this.rt.events(record.sessionId, context.signal).catch(() => null),
        values: await this.rt.projections(record.sessionId, context.signal).catch(() => null),
        loginError: this.rt.loginErrors.get(record.sessionId) ?? null,
      }), context)
    }
    if (TERMINAL_TASK_STATES.has(record.state)) {
      const events = evaluation?.events.length ? evaluation.events : await this.rt.events(record.sessionId, context.signal).catch(() => [] as const)
      const turns = evaluation?.turns.length ? evaluation.turns : findTaskTurn(events, record.requestId)?.turns ?? []
      if (turns.length > 0) {
        const reply = spanReply(events, turns)
        info.result = {
          reply: hasContent(context) && reply !== null ? redactTruncate(reply, 20_000).text : null,
          changes: this.turnChanges(record.sessionId, events, turns),
          deliverables: presentedFiles(events, turns).map((file): DeliverableRef => ({
            deliverableId: file.deliverableId,
            title: redactLine(file.description ?? file.path.split(/[\\/]/).pop() ?? file.path, 200),
            mimeType: null,
          })),
        }
      } else {
        info.result = { reply: null }
      }
    }
    return info
  }

  private turnChanges(sessionId: string, events: readonly DshSessionEvent[], turns: readonly number[]): NonNullable<NonNullable<TaskInfo['result']>['changes']> {
    const service = this.rt.get<DshWorkspaceChanges>(SERVICES.workspaceChanges)
    if (!service) return []
    const files = new Map<string, { path: string; status: 'modified'; additions: number; deletions: number }>()
    for (const { seq } of changesEvents(events, turns)) {
      for (const file of service.summary(sessionId, seq)?.files ?? []) {
        files.set(file.path, { path: redactLine(file.display || file.path, 1000), status: 'modified', additions: file.added, deletions: file.deleted })
      }
    }
    return [...files.values()]
  }

  // --- targets and validation --------------------------------------------------

  private ensurePromptable(row: SessionRow): void {
    if (row.subagent) throw invalid(`session ${row.sessionId} is a subagent session; send prompts to its parent`)
    if (row.archived) throw new OperationError('conflict', `session ${row.sessionId} is archived; unarchive it in DSH Web first`)
  }

  private async resolveTarget(target: Params<'task.start'>['target'], signal: AbortSignal): Promise<{ row: SessionRow } | { create: { workspace: DshWorkspace; agentPreset?: string; title?: string } }> {
    const rt = this.rt
    if ('new' in target) {
      const workspace = rt.workspace(target.new.workspaceId)
      if (target.new.agentPreset !== undefined && !rt.deps.scope.isAllowedAgentPreset(target.new.agentPreset)) {
        throw denied(`agent preset "${target.new.agentPreset}" is not allowed for remote use`)
      }
      return { create: { workspace, ...(target.new.agentPreset !== undefined ? { agentPreset: target.new.agentPreset } : {}), ...(target.new.title !== undefined ? { title: target.new.title } : {}) } }
    }
    if ('sessionId' in target) return { row: await rt.row(target.sessionId, signal) }
    if ('alias' in target) {
      const sessionId = rt.deps.scope.aliases()[target.alias]
      if (sessionId === undefined) throw notFound(`alias "${target.alias}" is not configured on DSH`)
      return { row: await rt.row(sessionId, signal) }
    }
    const rows = (await rt.catalog(signal)).filter(row =>
      !row.subagent && !row.archived && rt.canAccess(row)
      && (target.workspaceId === undefined || row.workspace?.id === target.workspaceId))
    if ('latest' in target) {
      const latest = rows.sort((a, b) => (b.summary.updatedAt ?? 0) - (a.summary.updatedAt ?? 0))[0]
      if (!latest) throw notFound('no session found to send the prompt to')
      return { row: latest }
    }
    const matches = rows.filter(row => row.title === target.title)
    if (matches.length === 0) throw notFound(`no session titled "${redactLine(target.title, 100)}"`)
    if (matches.length > 1) throw new OperationError('conflict', `several sessions are titled "${redactLine(target.title, 100)}": ${matches.map(row => row.sessionId).join(', ')}`)
    return { row: matches[0]! }
  }

  private async knownSkills(sessionId: string | null, cwd: string | null, signal: AbortSignal): Promise<Set<string> | null> {
    try {
      if (sessionId !== null) {
        const catalog = this.rt.get<DshSessionSkillCatalog>(SERVICES.sessionSkillCatalog)
        if (catalog) return new Set((await catalog.list({ sessionId }, signal)).skills.map(skill => skill.name))
      }
      const skills = this.rt.get<DshSkills>(SERVICES.skills)
      if (skills && cwd) return new Set((await skills.list({ cwd })).map(skill => skill.name))
    } catch {
      // fall through: fail closed below
    }
    return null
  }

  /**
   * Build the prompt text: requested skills appended as `/name`, and every
   * skill gesture anywhere in the text checked against the DSH allow-list.
   * Gestures that name no installed skill are ordinary text (DSH ignores
   * them); when the skill catalog cannot be read, every gesture is checked.
   */
  private async promptText(prompt: string, skills: readonly string[], workspaceId: string | null, sessionId: string | null, cwd: string | null, signal: AbortSignal): Promise<string> {
    if (prompt.trim() === '') throw invalid('prompt must not be empty')
    const scope = this.rt.deps.scope
    const untrusted = workspaceId !== null && scope.isUntrustedWorkspace(workspaceId)
    for (const name of skills) {
      if (!SKILL_NAME.test(name)) throw invalid(`"${name}" is not a skill name`)
    }
    const text = skills.length > 0 ? `${prompt}\n\n${skills.map(name => `/${name}`).join(' ')}` : prompt
    const gestures = skillGestures(text)
    if (gestures.length === 0) return text
    const known = await this.knownSkills(sessionId, cwd, signal)
    for (const name of skills) {
      if (known && !known.has(name)) throw invalid(`skill "${name}" is not available in this session`)
    }
    for (const name of gestures) {
      if (known && !known.has(name)) continue
      if (untrusted) throw denied(`skills are disabled in this workspace until it is trusted on DSH (cloned through Remora): /${name}`)
      if (!scope.isAllowedSkill(name, workspaceId)) throw denied(`skill "/${name}" is not allowed for remote use`)
    }
    return text
  }

  private async deliver(record: TaskRecord, text: string, mode: 'queue' | 'steer', context: OperationContext): Promise<TaskRecord> {
    const sessionId = record.sessionId!
    const wasLive = this.rt.liveAgent(sessionId) !== undefined
    this.inflight.add(record.taskId)
    try {
      await this.rt.sessions.prompt({ requestId: record.requestId, sessionId, mode, content: [{ type: 'text', text }] }, context.signal)
    } catch (error) {
      const failure = fromDsh(error, 'DSH did not accept the prompt')
      if (failure.code !== 'unavailable' || !/cancelled/.test(failure.message)) {
        await this.save(record, 'failed', { code: failure.code, message: failure.message })
      }
      throw failure
    } finally {
      this.inflight.delete(record.taskId)
      this.rt.noteWake(sessionId, wasLive)
    }
    return record
  }

  private newRecord(taskId: string, context: OperationContext, sessionId: string | null): TaskRecord {
    const now = Date.now()
    return { taskId, clientId: context.actor.clientId, sessionId, requestId: remoraRequestId(context.actor.clientId, taskId), state: 'accepted', createdAt: now, updatedAt: now }
  }

  private taskIdOf(context: OperationContext): string {
    if (!context.taskId) throw invalid('the hub did not assign a task id')
    return context.taskId
  }

  private async finish(record: TaskRecord, context: OperationContext): Promise<TaskInfo> {
    const { record: next, evaluation } = await this.refresh(record, context.signal).catch(() => ({ record, evaluation: undefined }))
    return this.info(next, context, evaluation)
  }

  // --- operations --------------------------------------------------------------

  async start(params: Params<'task.start'>, context: OperationContext): Promise<Result<'task.start'>> {
    const taskId = this.taskIdOf(context)
    const existing = this.rt.deps.tasks.get(taskId)
    if (existing && existing.clientId !== context.actor.clientId) throw new OperationError('conflict', `task ${taskId} belongs to another client`)
    // A retry re-delivers only while DSH may not have the prompt yet; DSH dedupes on requestId anyway.
    if (existing && existing.state !== 'accepted' && !(existing.state === 'failed' && existing.sessionId === null) && !(existing.state === 'failed' && existing.error?.code !== 'internal')) {
      return this.finish(existing, context)
    }

    let row: SessionRow | null = null
    let create: { workspace: DshWorkspace; agentPreset?: string; title?: string } | null = null
    if (existing?.sessionId) {
      row = await this.rt.row(existing.sessionId, context.signal)
    } else {
      const target = await this.resolveTarget(params.target, context.signal)
      if ('row' in target) row = target.row
      else create = target.create
    }
    if (row) this.ensurePromptable(row)
    const workspaceId = row ? row.workspace?.id ?? null : create!.workspace.id
    const cwd = row ? row.workspacePath : create!.workspace.path
    const text = await this.promptText(params.prompt, params.skills ?? [], workspaceId, row?.sessionId ?? null, cwd, context.signal)

    // Write-ahead: the record (and its requestId) is durable before DSH sees the prompt.
    let record = existing ?? this.newRecord(taskId, context, row?.sessionId ?? null)
    if (!existing) await this.rt.deps.tasks.put(record)
    else if (existing.state === 'failed') record = await this.save(existing, 'accepted')

    if (record.sessionId === null && create) {
      const sessionId = sessionIdFor(record.requestId)
      try {
        await this.rt.sessions.create({ workspaceId: create.workspace.id, sessionId, ...(create.agentPreset !== undefined ? { agentPreset: create.agentPreset } : {}) })
      } catch (error) {
        const failure = fromDsh(error, 'creating the session failed')
        await this.save(record, 'failed', { code: failure.code, message: failure.message })
        throw failure
      }
      this.rt.wokenByRemora.add(sessionId)
      this.rt.markSeen(sessionId)
      record = { ...record, sessionId, updatedAt: Date.now() }
      await this.rt.deps.tasks.put(record)
      if (create.title !== undefined) {
        await this.rt.sessions.rename({ sessionId, title: create.title }).catch((error: unknown) => {
          this.rt.deps.logger.warn('Remora: could not title the new session', error)
        })
      }
    }
    await this.deliver(record, text, 'queue', context)
    return this.finish(record, context)
  }

  async get(params: Params<'task.get'>, context: OperationContext): Promise<Result<'task.get'>> {
    return this.finish(this.own(params.taskId, context), context)
  }

  async wait(params: Params<'task.wait'>, context: OperationContext): Promise<Result<'task.wait'>> {
    let record = this.own(params.taskId, context)
    const deadline = Date.now() + Math.min(params.timeoutMs ?? TASK_WAIT_MAX_MS, TASK_WAIT_MAX_MS)
    const settled = (state: TaskState): boolean => TERMINAL_TASK_STATES.has(state) || state === 'needs_attention'
    let evaluation: Evaluation | undefined
    try {
      ({ record, evaluation } = await this.refresh(record, context.signal))
    } catch {
      // keep the stored state
    }
    while (!settled(record.state) && Date.now() < deadline && !context.signal.aborted) {
      await new Promise<void>((resolveWait) => {
        const set = this.waiters.get(record.taskId) ?? new Set()
        const done = (): void => {
          clearTimeout(timer)
          set.delete(done)
          context.signal.removeEventListener('abort', done)
          resolveWait()
        }
        const timer = setTimeout(done, Math.max(0, deadline - Date.now()))
        set.add(done)
        this.waiters.set(record.taskId, set)
        context.signal.addEventListener('abort', done, { once: true })
      })
      record = this.rt.deps.tasks.get(record.taskId) ?? record
      evaluation = undefined
    }
    return this.info(record, context, evaluation)
  }

  async steer(params: Params<'task.steer'>, context: OperationContext): Promise<Result<'task.steer'>> {
    const taskId = this.taskIdOf(context)
    const existing = this.rt.deps.tasks.get(taskId)
    if (existing) {
      if (existing.clientId !== context.actor.clientId) throw new OperationError('conflict', `task ${taskId} belongs to another client`)
      if (existing.state !== 'accepted') return this.finish(existing, context)
    }
    let sessionId = existing?.sessionId ?? params.sessionId
    if (params.taskId !== undefined) {
      const original = this.own(params.taskId, context)
      if (params.sessionId !== undefined && params.sessionId !== original.sessionId) throw invalid('taskId and sessionId do not match')
      sessionId = original.sessionId ?? undefined
    }
    if (!sessionId) throw invalid('give taskId or sessionId')
    const row = await this.rt.row(sessionId, context.signal)
    this.ensurePromptable(row)
    const text = await this.promptText(params.prompt, [], row.workspace?.id ?? null, row.sessionId, row.workspacePath, context.signal)
    const record = existing ?? this.newRecord(taskId, context, row.sessionId)
    if (!existing) await this.rt.deps.tasks.put(record)
    await this.deliver(record, text, this.rt.isRunning(row.sessionId) ? 'steer' : 'queue', context)
    return this.finish(record, context)
  }

  async resubmit(params: Params<'task.resubmit'>, context: OperationContext): Promise<Result<'task.resubmit'>> {
    const taskId = this.taskIdOf(context)
    const existing = this.rt.deps.tasks.get(taskId)
    if (existing) {
      if (existing.clientId !== context.actor.clientId) throw new OperationError('conflict', `task ${taskId} belongs to another client`)
      if (existing.state !== 'accepted') return this.finish(existing, context)
    }
    const original = this.own(params.taskId, context)
    if (!original.sessionId) throw new OperationError('conflict', `task ${params.taskId} never reached a session`)
    const row = await this.rt.row(original.sessionId, context.signal)
    this.ensurePromptable(row)
    // The prompt is not stored by Remora: read it back from the session log (or its queue).
    const events = await this.rt.events(row.sessionId, context.signal)
    let text = findTaskTurn(events, original.requestId)?.text
    if (text === undefined) {
      const values = await this.rt.projections(row.sessionId, context.signal)
      const queued = [...values?.inbox?.['next-turn'] ?? [], ...values?.inbox?.['next-step'] ?? []].find(item => rpcIdOf(item) === original.requestId)
      text = queued ? contentText((queued as { content?: unknown }).content) : undefined
    }
    if (!text) throw new OperationError('gone', `the prompt of task ${params.taskId} is no longer in the session`)
    const checked = await this.promptText(text, [], row.workspace?.id ?? null, row.sessionId, row.workspacePath, context.signal)
    const record = existing ?? this.newRecord(taskId, context, row.sessionId)
    if (!existing) await this.rt.deps.tasks.put(record)
    await this.deliver(record, checked, 'queue', context)
    return this.finish(record, context)
  }

  async cancel(params: Params<'task.cancel'>, context: OperationContext): Promise<Result<'task.cancel'>> {
    let record = this.own(params.taskId, context)
    if (TERMINAL_TASK_STATES.has(record.state)) return { cancelled: false, how: 'already-finished' }
    if (!record.sessionId) {
      await this.save(record, 'cancelled')
      return { cancelled: true, how: 'removed-from-queue' }
    }
    const sessionId = record.sessionId
    await this.rt.row(sessionId, context.signal)
    const values = await this.rt.projections(sessionId, context.signal)
    const inbox = [...values?.inbox?.['next-turn'] ?? [], ...values?.inbox?.['next-step'] ?? []]
    const queued = inbox.find(item => rpcIdOf(item) === record.requestId) as { id?: unknown } | undefined
    if (queued && typeof queued.id === 'string') {
      try {
        await this.rt.sessions.updateQueue({ sessionId, itemId: queued.id, action: { kind: 'remove' } })
      } catch (error) {
        const failure = fromDsh(error, 'removing the queued prompt failed')
        if (failure.code !== 'not_found') throw failure
      }
      await this.save(record, 'cancelled')
      return { cancelled: true, how: 'removed-from-queue' }
    }
    const events = await this.rt.events(sessionId, context.signal)
    const turn = findTaskTurn(events, record.requestId)
    if (turn && !turn.end && this.rt.liveAgent(sessionId)) {
      try {
        await this.rt.sessions.cancel({ sessionId })
      } catch (error) {
        throw fromDsh(error, 'stopping the session failed')
      }
      record = await this.save(record, 'cancelled')
      return { cancelled: true, how: 'stopped-session' }
    }
    await this.refresh(record, context.signal).catch(() => undefined)
    return { cancelled: false, how: 'already-finished' }
  }
}
