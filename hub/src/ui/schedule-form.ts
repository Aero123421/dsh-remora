/**
 * The hub's "add a scheduled prompt" form → the `when` of schedule.create.
 * Kept apart from the page code so it can be unit-tested without Workers.
 */
import type { ScheduleWhen } from '../vendor/protocol/api.ts'

export type WhenOutcome = { ok: true; when: ScheduleWhen } | { ok: false; message: string }

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
  const fail = (message: string): WhenOutcome => ({ ok: false, message })
  const kind = form.get('kind') ?? ''
  const timeZone = (form.get('timeZone') ?? '').trim() || 'UTC'
  const minutes = Number(form.get('minutes') ?? '')
  const time = (form.get('time') ?? '').trim()
  if (['at', 'daily', 'weekly', 'cron'].includes(kind) && !validZone(timeZone)) return fail(`タイムゾーン「${timeZone}」が分かりません（例: Asia/Tokyo）。`)
  switch (kind) {
    case 'after':
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 366 * 24 * 60) return fail('何分後かを 1 から 527040 の間で入れてください。')
      return { ok: true, when: { afterSeconds: Math.round(minutes * 60) } }
    case 'every':
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 366 * 24 * 60) return fail('間隔を 1 から 527040 分の間で入れてください。')
      return { ok: true, when: { everySeconds: Math.round(minutes * 60) } }
    case 'at': {
      const at = zonedTime(form.get('at') ?? '', timeZone)
      if (!at) return fail('日時を入れてください。')
      if (Date.parse(at) <= Date.now()) return fail('過去の日時は指定できません。')
      return { ok: true, when: { at } }
    }
    case 'daily':
      if (!TIME.test(time)) return fail('時刻を HH:mm で入れてください。')
      return { ok: true, when: { daily: { time, timeZone } } }
    case 'weekly': {
      if (!TIME.test(time)) return fail('時刻を HH:mm で入れてください。')
      const weekdays = [...new Set(form.getAll('weekday').map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b)
      if (weekdays.length === 0) return fail('曜日を 1 つ以上選んでください。')
      return { ok: true, when: { weekly: { time, timeZone, weekdays } } }
    }
    case 'cron': {
      const expression = (form.get('cron') ?? '').trim()
      if (expression === '' || expression.length > 200) return fail('cron 式を入れてください（例: 0 9 * * 1-5）。')
      return { ok: true, when: { cron: { expression, timeZone } } }
    }
    default:
      return fail('いつ実行するかを選んでください。')
  }
}
