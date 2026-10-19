/**
 * The hub's "add a scheduled prompt" form → the `when` of schedule.create.
 * Kept apart from the page code so it can be unit-tested without Workers.
 */
import type { MessageKey, Vars } from '../i18n/index.ts'
import type { ScheduleWhen } from '../vendor/protocol/api.ts'

/** A failure names its message; the page renders it in the reader's language. */
export type WhenOutcome = { ok: true; when: ScheduleWhen } | { ok: false; message: MessageKey; vars?: Vars }

/** `2026-10-13T09:00` read as a wall-clock time in `timeZone` → RFC 3339 in UTC, or null. */
export function zonedTime(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim())
  if (!match) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number]
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return null
  }
  // How far the zone's wall clock is ahead of UTC at one instant.
  const offset = (at: number) => {
    const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]))
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - at
  }
  // Two passes settle the offset around a daylight-saving change.
  const first = wall - offset(wall)
  const utc = wall - offset(first)
  return Number.isFinite(utc) ? new Date(utc).toISOString().replace('.000Z', 'Z') : null
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function validZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export function whenFromForm(form: URLSearchParams): WhenOutcome {
  const fail = (message: MessageKey, vars?: Vars): WhenOutcome => ({ ok: false, message, ...(vars ? { vars } : {}) })
  const kind = form.get('kind') ?? ''
  const timeZone = (form.get('timeZone') ?? '').trim() || 'UTC'
  const minutes = Number(form.get('minutes') ?? '')
  const time = (form.get('time') ?? '').trim()
  if (['at', 'daily', 'weekly', 'cron'].includes(kind) && !validZone(timeZone)) return fail('schedules.error.zone', { zone: timeZone })
  switch (kind) {
    case 'after':
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 366 * 24 * 60) return fail('schedules.error.after')
      return { ok: true, when: { afterSeconds: Math.round(minutes * 60) } }
    case 'every':
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 366 * 24 * 60) return fail('schedules.error.every')
      return { ok: true, when: { everySeconds: Math.round(minutes * 60) } }
    case 'at': {
      const at = zonedTime(form.get('at') ?? '', timeZone)
      if (!at) return fail('schedules.error.at')
      if (Date.parse(at) <= Date.now()) return fail('schedules.error.past')
      return { ok: true, when: { at } }
    }
    case 'daily':
      if (!TIME.test(time)) return fail('schedules.error.time')
      return { ok: true, when: { daily: { time, timeZone } } }
    case 'weekly': {
      if (!TIME.test(time)) return fail('schedules.error.time')
      const weekdays = [...new Set(form.getAll('weekday').map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b)
      if (weekdays.length === 0) return fail('schedules.error.weekdays')
      return { ok: true, when: { weekly: { time, timeZone, weekdays } } }
    }
    case 'cron': {
      const expression = (form.get('cron') ?? '').trim()
      if (expression === '' || expression.length > 200) return fail('schedules.error.cron')
      return { ok: true, when: { cron: { expression, timeZone } } }
    }
    default:
      return fail('schedules.error.kind')
  }
}
