/**
 * Scheduled prompts (DSH "Automation tasks", `ctx.schedule`): list, create,
 * delete. A schedule delivers its prompt to the session as a new turn when it
 * is due, so creating one is held to the same rules as task.start: the
 * session must be in scope, ordinary, not archived, and in a trusted, ready
 * workspace. Reads and deletion never wake a session.
 */
import { createHash } from 'node:crypto'
import type { OperationParams, OperationResults, ScheduleInfo, ScheduleWhen } from '@dsh-remora/protocol'
import type { OperationContext, RemoteScheduleRecord, RemoteScheduleStore } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redactLine, redactTruncate } from '../redact.ts'
import type { Disposer, DshSchedule, DshScheduleCatalogEntry, DshScheduleCreateRequest } from './dsh-types.ts'
import { SERVICES } from './dsh-types.ts'
import { fromDsh, invalid, unavailable } from './errors.ts'
import { hasContent, type Runtime } from './runtime.ts'

type Params<Op extends keyof OperationParams> = OperationParams[Op]
type Result<Op extends keyof OperationResults> = OperationResults[Op]

const WEEKDAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
/** How long a create's idempotency key is remembered. */
const IDEMPOTENCY_MS = 24 * 60 * 60_000
/** Active schedules created through Remora on one host, at most. */
export const REMOTE_SCHEDULES_MAX = 20

function memorySchedules(): RemoteScheduleStore {
  let records: RemoteScheduleRecord[] = []
  return {
    list: () => records.map(record => ({ ...record })),
    put: async record => { records = [...records.filter(item => item.scheduleId !== record.scheduleId), { ...record }] },
    remove: async ids => { records = records.filter(item => !ids.includes(item.scheduleId)) },
  }
}

function seconds(value: number): string {
  if (value % 86_400 === 0) return `${value / 86_400} d`
  if (value % 3_600 === 0) return `${value / 3_600} h`
  if (value % 60 === 0) return `${value / 60} min`
  return `${value} s`
}

const hhmm = (time: string) => time.slice(0, 5)

/** The rule in words, e.g. `daily 09:00 Asia/Tokyo`. */
export function ruleText(entry: DshScheduleCatalogEntry): string {
  switch (entry.kind) {
    case 'after': return `once, ${seconds(entry.afterSeconds)} after it was created`
    case 'at': return `once at ${entry.scheduledAt}`
    case 'every': return `every ${seconds(entry.everySeconds)}`
    case 'daily': return `daily ${hhmm(entry.time)} ${entry.timeZone}`
    case 'weekly': return `weekly ${entry.weekdays.map(day => WEEKDAYS[day] ?? String(day)).join(',')} ${hhmm(entry.time)} ${entry.timeZone}`
    case 'cron': return `cron ${entry.expression} ${entry.timeZone}`
  }
}

function epoch(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function scheduleInfo(entry: DshScheduleCatalogEntry, withPrompt: boolean, createdBy?: string): ScheduleInfo {
  return {
    ...(createdBy ? { createdBy: redactLine(createdBy, 80) } : {}),
    scheduleId: entry.id,
    sessionId: entry.sessionId,
    title: redactLine(entry.title, 120),
    ...(withPrompt ? { prompt: redactTruncate(entry.prompt, 20_000).text } : {}),
    kind: entry.kind,
    rule: redactLine(ruleText(entry), 200),
    nextAt: epoch(entry.scheduledAt),
    status: entry.status,
    lastDeliveredAt: epoch(entry.lastDelivery?.deliveredAt),
  }
}

/** HH:mm → HH:mm:ss, as DSH expects. */
const fullTime = (time: string) => (time.length === 5 ? `${time}:00` : time)

/** The DSH create request for one `when` shape. */
export function createRequest(title: string, prompt: string, when: ScheduleWhen): DshScheduleCreateRequest {
  const base = { title, prompt }
  if ('afterSeconds' in when) return { ...base, after_seconds: when.afterSeconds }
  if ('at' in when) {
    if (!Number.isFinite(Date.parse(when.at))) throw invalid(`"${when.at}" is not an RFC 3339 time`)
    return { ...base, at: when.at }
  }
  if ('everySeconds' in when) return { ...base, every_seconds: when.everySeconds }
  if ('daily' in when) return { ...base, daily: { time: fullTime(when.daily.time), time_zone: when.daily.timeZone } }
  if ('weekly' in when) {
    const weekdays = [...new Set(when.weekly.weekdays)].sort((a, b) => a - b)
    if (weekdays.length === 0) throw invalid('weekly needs at least one weekday')
    return { ...base, weekly: { time: fullTime(when.weekly.time), time_zone: when.weekly.timeZone, weekdays } }
  }
  return { ...base, cron: { expression: when.cron.expression, time_zone: when.cron.timeZone } }
}

/** DSH's ScheduleInputError (invalid_prompt, invalid_rule, not_future, …) → invalid_request. */
function scheduleError(error: unknown, fallback: string): OperationError {
  const code = (error as { code?: unknown } | null)?.code
  const message = (error as { message?: unknown } | null)?.message
  if (typeof code === 'string' && /^[a-z_]+$/.test(code) && typeof message === 'string') {
    return code === 'subagent_session' || code === 'internal_error'
      ? new OperationError(code === 'internal_error' ? 'internal' : 'invalid_request', message.slice(0, 500))
      : invalid(`${code}: ${message}`.slice(0, 500))
  }
  return fromDsh(error, fallback)
}

export function createSchedules(rt: Runtime) {
  /** Serialize creation and removal so revocation also catches an in-flight create. */
  let creating: Promise<unknown> = Promise.resolve()
  let disposed = false
  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(unavailable('the Remora adapter was unloaded'))
    const run = creating.then(operation)
    creating = run.catch(() => undefined)
    return run
  }
  const remote = rt.deps.remoteSchedules ?? memorySchedules()
  const createdBy = (id: string) => remote.list().find(record => record.scheduleId === id)?.clientName
  let unobserve: Disposer | undefined
  if (typeof rt.ctx.on === 'function') {
    // This in-process event follows a durable native deletion. A catalogue
    // miss (including schedule/changed) cannot provide the same confirmation.
    unobserve = rt.ctx.on('domain/changed', (event: unknown) => {
      if (typeof event !== 'object' || event === null || Array.isArray(event)) return
      const change = event as Record<string, unknown>
      if (change.domain !== 'schedule' || change.table !== 'tasks' || change.operation !== 'deleted'
        || typeof change.key !== 'string' || change.key === '' || change.value !== undefined) return
      const scheduleId = change.key
      void mutate(async () => {
        if (remote.list().some(record => record.scheduleId === scheduleId)) await remote.remove([scheduleId])
      }).catch((error: unknown) => rt.deps.logger.warn('Remora: recording native schedule deletion failed', error))
    }, { global: true })
  }

  function service(): DshSchedule {
    const schedule = rt.get<DshSchedule>(SERVICES.schedule)
    if (!schedule) throw unavailable('DSH automation tasks are not available')
    return schedule
  }

  async function catalog(): Promise<DshScheduleCatalogEntry[]> {
    try {
      return await service().catalog()
    } catch (error) {
      throw fromDsh(error, 'reading the automation tasks failed')
    }
  }

  async function create(params: Params<'schedule.create'>, context: OperationContext): Promise<Result<'schedule.create'>> {
    if (context.signal.aborted) throw unavailable('creating the automation task was cancelled')
    const row = await rt.row(params.sessionId, context.signal)
    if (row.subagent) throw invalid(`session ${row.sessionId} is a subagent session`)
    if (row.archived) throw new OperationError('conflict', `session ${row.sessionId} is archived`)
    // A schedule starts turns later, so it obeys the same rule as a prompt now.
    rt.assertCanDriveTurns(row.workspace?.id ?? null)
    const now = Date.now()
    const request = createRequest(params.title.trim(), params.prompt, params.when)
    const requestHash = createHash('sha256').update(JSON.stringify({ sessionId: row.sessionId, request })).digest('hex')
    const earlier = remote.list().find(record => record.clientId === context.actor.clientId
      && record.idempotencyKey === params.idempotencyKey && now - record.createdAt <= IDEMPOTENCY_MS)
    if (earlier) {
      if (earlier.requestHash !== requestHash) throw new OperationError('conflict', 'this idempotencyKey was already used for a different scheduled prompt')
      const existing = (await catalog()).find(entry => entry.id === earlier.scheduleId)
      if (existing) return { schedule: scheduleInfo(existing, hasContent(context), createdBy(existing.id)) }
      throw unavailable('the tracked automation task is missing from this DSH process; restart DSH before retrying')
    }
    // Remote schedules outlive the call that made them: keep their number bounded.
    const catalogue = await catalog()
    const known = new Set(catalogue.map(entry => entry.id))
    if (remote.list().some(record => !known.has(record.scheduleId))) throw unavailable('tracked automation tasks are missing from this DSH process; restart DSH before creating another')
    const live = new Set(catalogue.filter(entry => entry.status === 'active').map(entry => entry.id))
    if (remote.list().filter(record => live.has(record.scheduleId)).length >= REMOTE_SCHEDULES_MAX) {
      throw new OperationError('conflict', `${REMOTE_SCHEDULES_MAX} scheduled prompts created through Remora are already active on this host; delete some first`)
    }
    if (context.signal.aborted) throw unavailable('creating the automation task was cancelled')
    let record
    try {
      record = await service().create(row.sessionId, request, context.signal)
    } catch (error) {
      throw scheduleError(error, 'creating the automation task failed')
    }
    try {
      await remote.put({
        scheduleId: record.id, sessionId: row.sessionId, clientId: context.actor.clientId,
        clientName: context.actor.clientName, createdAt: now, idempotencyKey: params.idempotencyKey, requestHash,
      })
    } catch (error) {
      // A schedule without its durable retry / revocation record must not keep running.
      await service().delete({ sessionId: row.sessionId, id: record.id }, AbortSignal.timeout(10_000)).catch((failure: unknown) => {
        rt.deps.logger.warn('Remora: removing an untracked automation task failed', failure)
      })
      throw error
    }
    return { schedule: scheduleInfo({ ...record, sessionId: row.sessionId, status: 'active' }, hasContent(context), context.actor.clientName) }
  }

  return {
    async dispose(): Promise<void> {
      if (!disposed) {
        disposed = true
        try { unobserve?.() } catch (error) { rt.deps.logger.warn('Remora: removing the native schedule observer failed', error) }
      }
      await creating
    },
    async 'schedules.list'(params: Params<'schedules.list'>, context: OperationContext): Promise<Result<'schedules.list'>> {
      if (params.sessionId !== undefined) await rt.row(params.sessionId, context.signal)
      const reachable = new Set((await rt.catalog(context.signal)).filter(row => rt.canAccess(row)).map(row => row.sessionId))
      const schedules = (await catalog())
        .filter(entry => reachable.has(entry.sessionId) && (params.sessionId === undefined || entry.sessionId === params.sessionId))
        .map(entry => scheduleInfo(entry, hasContent(context), createdBy(entry.id)))
        .sort((a, b) => (a.status === b.status ? (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) : a.status === 'active' ? -1 : 1))
      return { schedules }
    },

    'schedule.create'(params: Params<'schedule.create'>, context: OperationContext): Promise<Result<'schedule.create'>> {
      return mutate(() => create(params, context))
    },

    'schedule.delete'(params: Params<'schedule.delete'>, context: OperationContext): Promise<Result<'schedule.delete'>> {
      return mutate(async () => {
        const row = await rt.row(params.sessionId, context.signal)
        let outcome
        try {
          outcome = await service().delete({ sessionId: row.sessionId, id: params.scheduleId }, context.signal)
        } catch (error) {
          throw scheduleError(error, 'deleting the automation task failed')
        }
        // Forget it only once it is really gone (DSH fences deletes by session).
        if (outcome.deleted) await remote.remove([params.scheduleId])
        return { deleted: outcome.deleted }
      })
    },

    /** Kill switch or unpairing: take away every schedule created through Remora. */
    removeRemote(): Promise<number> {
      return mutate(async () => {
        const records = remote.list()
        if (records.length === 0) return 0
        const schedule = rt.get<DshSchedule>(SERVICES.schedule)
        if (!schedule) return 0
        const catalogue = await catalog().catch(() => null)
        const known = catalogue === null ? null : new Set(catalogue.map(entry => entry.id))
        const gone: string[] = []
        for (const record of records) {
          // An empty cached domain does not prove that the native row is gone.
          // Keep it for a fresh DSH process rather than discarding its only tracker.
          if (known === null || !known.has(record.scheduleId)) continue
          try {
            if ((await schedule.delete({ sessionId: record.sessionId, id: record.scheduleId }, AbortSignal.timeout(10_000))).deleted) gone.push(record.scheduleId)
          } catch {
            // kept: tried again next time
          }
        }
        await remote.remove(gone)
        return gone.length
      })
    },
  }
}
