/**
 * Scheduled prompts (DSH "Automation tasks", `ctx.schedule`): list, create,
 * delete. A schedule delivers its prompt to the session as a new turn when it
 * is due, so creating one is held to the same rules as task.start: the
 * session must be in scope, ordinary, not archived, and in a trusted, ready
 * workspace. Reads and deletion never wake a session.
 */
import type { OperationParams, OperationResults, ScheduleInfo, ScheduleWhen } from '@dsh-remora/protocol'
import type { OperationContext, RemoteScheduleRecord, RemoteScheduleStore } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redactLine, redactTruncate } from '../redact.ts'
import type { DshSchedule, DshScheduleCatalogEntry, DshScheduleCreateRequest } from './dsh-types.ts'
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
  /** `<clientId>\0<key>` → schedule id and when it was created. */
  const created = new Map<string, { scheduleId: string; sessionId: string; at: number }>()
  const remote = rt.deps.remoteSchedules ?? memorySchedules()
  const createdBy = (id: string) => remote.list().find(record => record.scheduleId === id)?.clientName

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

  return {
    async 'schedules.list'(params: Params<'schedules.list'>, context: OperationContext): Promise<Result<'schedules.list'>> {
      if (params.sessionId !== undefined) await rt.row(params.sessionId, context.signal)
      const reachable = new Set((await rt.catalog(context.signal)).filter(row => rt.canAccess(row)).map(row => row.sessionId))
      const schedules = (await catalog())
        .filter(entry => reachable.has(entry.sessionId) && (params.sessionId === undefined || entry.sessionId === params.sessionId))
        .map(entry => scheduleInfo(entry, hasContent(context), createdBy(entry.id)))
        .sort((a, b) => (a.status === b.status ? (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) : a.status === 'active' ? -1 : 1))
      return { schedules }
    },

    async 'schedule.create'(params: Params<'schedule.create'>, context: OperationContext): Promise<Result<'schedule.create'>> {
      const row = await rt.row(params.sessionId, context.signal)
      if (row.subagent) throw invalid(`session ${row.sessionId} is a subagent session`)
      if (row.archived) throw new OperationError('conflict', `session ${row.sessionId} is archived`)
      // A schedule starts turns later, so it obeys the same rule as a prompt now.
      rt.assertCanDriveTurns(row.workspace?.id ?? null)
      const now = Date.now()
      for (const [key, entry] of created) if (now - entry.at > IDEMPOTENCY_MS) created.delete(key)
      const key = `${context.actor.clientId}\u0000${params.idempotencyKey}`
      const earlier = created.get(key)
      if (earlier) {
        const existing = (await catalog()).find(entry => entry.id === earlier.scheduleId)
        if (existing) return { schedule: scheduleInfo(existing, hasContent(context), createdBy(existing.id)) }
      }
      // Remote schedules outlive the call that made them: keep their number bounded.
      const catalogue = await catalog()
      const live = new Set(catalogue.filter(entry => entry.status === 'active').map(entry => entry.id))
      if (remote.list().filter(record => live.has(record.scheduleId)).length >= REMOTE_SCHEDULES_MAX) {
        throw new OperationError('conflict', `${REMOTE_SCHEDULES_MAX} scheduled prompts created through Remora are already active on this host; delete some first`)
      }
      const request = createRequest(params.title.trim(), params.prompt, params.when)
      let record
      try {
        record = await service().create(row.sessionId, request, context.signal)
      } catch (error) {
        throw scheduleError(error, 'creating the automation task failed')
      }
      created.set(key, { scheduleId: record.id, sessionId: row.sessionId, at: now })
      await remote.put({ scheduleId: record.id, sessionId: row.sessionId, clientId: context.actor.clientId, clientName: context.actor.clientName, createdAt: now })
      return { schedule: scheduleInfo({ ...record, sessionId: row.sessionId, status: 'active' }, hasContent(context), context.actor.clientName) }
    },

    async 'schedule.delete'(params: Params<'schedule.delete'>, context: OperationContext): Promise<Result<'schedule.delete'>> {
      const row = await rt.row(params.sessionId, context.signal)
      let outcome
      try {
        outcome = await service().delete({ sessionId: row.sessionId, id: params.scheduleId }, context.signal)
      } catch (error) {
        throw scheduleError(error, 'deleting the automation task failed')
      }
      await remote.remove([params.scheduleId])
      return { deleted: outcome.deleted }
    },

    /** Kill switch or unpairing: take away every schedule created through Remora. */
    async removeRemote(): Promise<number> {
      const records = remote.list()
      if (records.length === 0) return 0
      const schedule = rt.get<DshSchedule>(SERVICES.schedule)
      let removed = 0
      for (const record of records) {
        try {
          if ((await schedule?.delete({ sessionId: record.sessionId, id: record.scheduleId }, AbortSignal.timeout(10_000)))?.deleted) removed++
        } catch {
          // already gone, or the session went away
        }
      }
      await remote.remove(records.map(record => record.scheduleId))
      return removed
    },
  }
}
