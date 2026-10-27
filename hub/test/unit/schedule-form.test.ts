import { test } from 'node:test'
import assert from 'node:assert/strict'
import { whenFromForm, zonedTime } from '../../src/ui/schedule-form.ts'

const form = (fields: Record<string, string | string[]>) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) for (const item of Array.isArray(value) ? value : [value]) params.append(key, item)
  return params
}

test('zonedTime reads a wall-clock time in a time zone, across daylight saving', () => {
  assert.equal(zonedTime('2026-10-13T09:00', 'Asia/Tokyo'), '2026-10-13T00:00:00Z')
  assert.equal(zonedTime('2026-10-13T09:00', 'UTC'), '2026-10-13T09:00:00Z')
  assert.equal(zonedTime('2026-07-01T12:00', 'America/New_York'), '2026-07-01T16:00:00Z')
  assert.equal(zonedTime('2026-12-01T12:00', 'America/New_York'), '2026-12-01T17:00:00Z')
  assert.equal(zonedTime('2026-10-13 09:00', 'UTC'), null)
  assert.equal(zonedTime('2026-10-13T09:00', 'Mars/Olympus'), null)
  assert.equal(zonedTime('2026-03-08T02:30', 'America/New_York'), null)
  assert.equal(zonedTime('2026-03-08T03:30', 'America/New_York'), '2026-03-08T07:30:00Z')
  assert.equal(zonedTime('2026-11-01T01:30', 'America/New_York'), '2026-11-01T05:30:00Z')
})

test('whenFromForm turns the hub form into one schedule shape', () => {
  assert.deepEqual(whenFromForm(form({ kind: 'daily', time: '09:00', timeZone: 'Asia/Tokyo' })), { ok: true, when: { daily: { time: '09:00', timeZone: 'Asia/Tokyo' } } })
  assert.deepEqual(whenFromForm(form({ kind: 'weekly', time: '18:30', timeZone: 'UTC', weekday: ['5', '1', '5', '9'] })), { ok: true, when: { weekly: { time: '18:30', timeZone: 'UTC', weekdays: [1, 5] } } })
  assert.deepEqual(whenFromForm(form({ kind: 'every', minutes: '90' })), { ok: true, when: { everySeconds: 5400 } })
  assert.deepEqual(whenFromForm(form({ kind: 'after', minutes: '15' })), { ok: true, when: { afterSeconds: 900 } })
  assert.deepEqual(whenFromForm(form({ kind: 'cron', cron: ' 0 9 * * 1-5 ', timeZone: 'Asia/Tokyo' })), { ok: true, when: { cron: { expression: '0 9 * * 1-5', timeZone: 'Asia/Tokyo' } } })
  const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16)
  assert.deepEqual(whenFromForm(form({ kind: 'at', at: future, timeZone: 'UTC' })), { ok: true, when: { at: `${future}:00Z` } })
  const bads: Record<string, string>[] = [
    { kind: 'weekly', time: '18:30', timeZone: 'UTC' },
    { kind: 'daily', time: '9:00', timeZone: 'UTC' },
    { kind: 'daily', time: '09:00', timeZone: 'Nowhere/City' },
    { kind: 'every', minutes: '0' },
    { kind: 'at', at: '2020-01-01T00:00', timeZone: 'UTC' },
    { kind: 'cron', cron: '' },
    { kind: 'sometime' },
  ]
  for (const bad of bads) assert.equal(whenFromForm(form(bad)).ok, false, JSON.stringify(bad))
})
