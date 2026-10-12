/**
 * Outgoing event queue. Task completion (and `needs_attention`), attention
 * changes and host status go out at once; other task progress is coalesced
 * per task and sent at most once every `PROGRESS_BATCH_MS`, which keeps the
 * hub's Durable Object requests inside the free tier. While the hub link is
 * down, events are kept (coalesced, bounded) and sent once it is back.
 */
import { PROGRESS_BATCH_MS, TERMINAL_TASK_STATES, type HostEvent } from '@dsh-remora/protocol'

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const MAX_PENDING_EVENTS = 1000

function keyOf(event: HostEvent): string {
  switch (event.kind) {
    case 'task': return `task:${event.taskId}`
    case 'attention': return `attention:${event.sessionId}`
    case 'host-status': return 'host-status'
  }
}

export function isImmediate(event: HostEvent): boolean {
  if (event.kind !== 'task') return true
  return TERMINAL_TASK_STATES.has(event.state) || event.state === 'needs_attention'
}

export class EventQueue {
  private readonly pending = new Map<string, HostEvent>()
  private readonly send: (events: HostEvent[]) => boolean
  private readonly clock: Clock
  private readonly batchMs: number
  private timer: unknown = null
  private lastSentAt = -Infinity

  /** `send` returns false when the hub link is down; the events stay queued. */
  constructor(send: (events: HostEvent[]) => boolean, clock: Clock = systemClock, batchMs = PROGRESS_BATCH_MS) {
    this.send = send
    this.clock = clock
    this.batchMs = batchMs
  }

  emit(event: HostEvent): void {
    const key = keyOf(event)
    this.pending.delete(key)
    this.pending.set(key, event)
    while (this.pending.size > MAX_PENDING_EVENTS) {
      const oldest = this.pending.keys().next().value as string
      this.pending.delete(oldest)
    }
    if (isImmediate(event)) {
      this.flush()
      return
    }
    if (this.timer === null) {
      const delay = Math.max(0, this.lastSentAt + this.batchMs - this.clock.now())
      this.timer = this.clock.setTimeout(() => { this.timer = null; this.flush() }, delay)
    }
  }

  /** Send everything queued now (e.g. right after the hub link comes up). */
  flush(): void {
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.size === 0) return
    const events = [...this.pending.values()]
    if (!this.send(events)) return
    this.pending.clear()
    this.lastSentAt = this.clock.now()
  }

  get size(): number {
    return this.pending.size
  }

  dispose(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }
}
