import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROGRESS_BATCH_MS, type HostEvent } from '@dsh-remora/protocol'
import { EventQueue, type Clock } from '../src/core/events.ts'

function manualClock() {
  let now = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: handle => { timers.delete(handle as number) },
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at
      timers.delete(due[0])
      due[1].fn()
    }
    now = target
  }
  return { clock, advance, pending: () => timers.size }
}

const progress = (taskId: string, updatedAt: number): HostEvent => ({ kind: 'task', taskId, state: 'running', updatedAt })

test('completion and attention go out at once; progress is batched and coalesced', () => {
  const { clock, advance } = manualClock()
  const sent: HostEvent[][] = []
  const queue = new EventQueue(events => { sent.push(events); return true }, clock)
  queue.emit({ kind: 'task', taskId: 't1', state: 'completed', updatedAt: 1 })
  assert.equal(sent.length, 1)
  queue.emit(progress('t2', 2))
  queue.emit(progress('t2', 3))
  queue.emit(progress('t3', 4))
  assert.equal(sent.length, 1, 'progress waits for the batch window')
  advance(PROGRESS_BATCH_MS - 1)
  assert.equal(sent.length, 1)
  advance(1)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1], [progress('t2', 3), progress('t3', 4)])
  queue.emit(progress('t2', 5))
  advance(1000)
  assert.equal(sent.length, 2, 'next batch is at least PROGRESS_BATCH_MS after the last send')
  queue.emit({ kind: 'attention', sessionId: 's1', items: [] })
  assert.equal(sent.length, 3, 'attention flushes immediately, carrying pending progress along')
  assert.deepEqual(sent[2]?.map(e => e.kind), ['task', 'attention'])
})

test('events wait while the hub link is down and are sent when it is back', () => {
  const { clock, advance } = manualClock()
  let up = false
  const sent: HostEvent[][] = []
  const queue = new EventQueue(events => { if (!up) return false; sent.push(events); return true }, clock)
  queue.emit({ kind: 'task', taskId: 't1', state: 'needs_attention', updatedAt: 1 })
  queue.emit(progress('t2', 2))
  advance(PROGRESS_BATCH_MS * 2)
  assert.equal(sent.length, 0)
  assert.equal(queue.size, 2)
  up = true
  queue.flush()
  assert.equal(sent.length, 1)
  assert.equal(queue.size, 0)
})
