/**
 * Watching for task progress and attention without polling: the adapter
 * subscribes to in-process Cordis events (`session/event`,
 * `api-session/status`, `api-session/error`) and re-evaluates the touched
 * session after a short debounce. Only live sessions emit events; cold
 * sessions cannot change.
 */
import { TERMINAL_TASK_STATES, type AttentionEvent, type AttentionSnapshotEvent } from '@dsh-remora/protocol'
import type { Disposer } from './dsh-types.ts'
import { OperationError } from '../ops/types.ts'
import { isLoginFailure } from './events.ts'
import { withoutDetail } from './reads.ts'
import type { Runtime } from './runtime.ts'
import type { Tasks } from './tasks.ts'

const DEBOUNCE_MS = 200

export class Watcher {
  private readonly rt: Runtime
  private readonly tasks: Tasks
  private readonly disposers: Disposer[] = []
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  /** Last attention list observed per session (JSON, without detail). */
  private readonly sent = new Map<string, string>()
  /** Sessions whose last event to the hub was an empty list. */
  private readonly cleared = new Set<string>()
  /** Sessions whose startup read failed. The snapshot tells the hub to keep their rows. */
  private readonly unread = new Set<string>()
  private readonly abort = new AbortController()
  private started = false
  private snapshot: Promise<void> | null = null

  constructor(rt: Runtime, tasks: Tasks) {
    this.rt = rt
    this.tasks = tasks
  }

  start(): void {
    if (this.started) return
    this.started = true
    const on = this.rt.ctx.on
    if (typeof on !== 'function') {
      this.rt.deps.logger.warn('Remora: this DSH context has no event subscription; task completion is only checked on request')
    } else {
      const subscribe = (name: string, listener: (...args: any[]) => void): void => {
        try {
          const dispose = on.call(this.rt.ctx, name, listener, { global: true })
          if (typeof dispose === 'function') this.disposers.push(dispose)
        } catch (error) {
          this.rt.deps.logger.warn(`Remora: could not subscribe to ${name}`, error)
        }
      }
      subscribe('session/event', (session: { id?: string } | undefined, event: { type?: string } | undefined) => {
        const sessionId = session?.id
        if (typeof sessionId !== 'string') return
        if (event?.type === 'assistant/message') this.rt.loginErrors.delete(sessionId)
        if (event?.type === 'assistant/attempt') return
        this.schedule(sessionId)
      })
      subscribe('api-session/status', (sessionId: unknown) => {
        if (typeof sessionId === 'string') this.schedule(sessionId)
      })
      subscribe('api-session/error', (sessionId: unknown, message: unknown) => {
        if (typeof sessionId !== 'string') return
        if (typeof message === 'string' && isLoginFailure(message)) this.rt.loginErrors.set(sessionId, { message, at: Date.now() })
        this.schedule(sessionId)
      })
    }
    // Process start only. A later call (the hub socket reconnecting in this process) does not publish again.
    this.snapshot = this.publishSnapshot()
  }

  dispose(): void {
    this.abort.abort()
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // already gone with the plugin fiber
      }
    }
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.started = false
  }

  settingsChanged(): void {
    if (!this.started) return
    for (const sessionId of new Set([
      ...this.sent.keys(),
      ...this.tasks.active().flatMap(record => record.sessionId ? [record.sessionId] : []),
    ])) this.schedule(sessionId, 0)
  }

  /** Re-evaluate one session soon (coalesces bursts of events). */
  schedule(sessionId: string, delay = DEBOUNCE_MS): void {
    if (this.abort.signal.aborted) return
    if (this.running.has(sessionId)) {
      this.again.add(sessionId)
      return
    }
    const existing = this.timers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      const run = this.refresh(sessionId).catch((error: unknown) => {
        this.rt.deps.logger.warn(`Remora: refreshing session ${sessionId} failed`, error)
      }).finally(() => {
        this.running.delete(sessionId)
        if (this.again.delete(sessionId)) this.schedule(sessionId)
      })
      this.running.set(sessionId, run)
    }, delay)
    timer.unref?.()
    this.timers.set(sessionId, timer)
  }

  /** Await pending refreshes, including the startup snapshot, during teardown or in tests. */
  async idle(): Promise<void> {
    await this.drain()
    if (this.snapshot) await this.snapshot
    await this.drain()
  }

  private async drain(): Promise<void> {
    while (this.timers.size > 0 || this.running.size > 0) {
      await Promise.all([...this.running.values()])
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  /**
   * Read the cold catalog and publish one snapshot of attention that is still open.
   * `list`, `inspect` and `projections` do not wake agents. A catalog failure publishes
   * nothing, so a restart does not wipe the hub with an empty list it could not build.
   */
  private async publishSnapshot(): Promise<void> {
    const signal = this.abort.signal
    let rows
    try {
      rows = await this.rt.catalog(signal)
    } catch (error) {
      this.rt.deps.logger.warn('Remora: attention snapshot skipped because the session list failed', error)
      return
    }
    if (signal.aborted) return
    for (const row of rows) {
      if (!this.rt.canAccess(row)) continue
      this.schedule(row.sessionId, 0)
    }
    await this.drain()
    if (signal.aborted) return
    const sessions: AttentionSnapshotEvent['sessions'] = []
    for (const [sessionId, json] of this.sent) {
      const items = JSON.parse(json) as AttentionSnapshotEvent['sessions'][number]['items']
      if (Array.isArray(items) && items.length > 0) sessions.push({ sessionId, items })
    }
    this.rt.deps.emit({
      kind: 'attention-snapshot',
      sessions,
      ...(this.unread.size > 0 ? { unreadSessionIds: [...this.unread] } : {}),
    })
  }

  /**
   * A deleted, missing, or out-of-scope session drops its attention.
   * A temporary read failure leaves the hub's current row in place.
   */
  private keepUnread(sessionId: string, error: unknown): void {
    const code = error instanceof OperationError ? error.code : undefined
    if (code === 'gone' || code === 'denied' || code === 'not_found') {
      this.unread.delete(sessionId)
      if (code === 'gone') void this.tasks.sessionGone(sessionId, error instanceof OperationError ? error.message : '')
      this.clearAttention(sessionId)
      return
    }
    this.unread.add(sessionId)
  }

  private clearAttention(sessionId: string): void {
    this.sent.set(sessionId, '[]')
    if (this.cleared.has(sessionId)) return
    this.cleared.add(sessionId)
    this.rt.deps.emit({ kind: 'attention', sessionId, items: [] })
  }

  private async refresh(sessionId: string): Promise<void> {
    const signal = this.abort.signal
    let inspection
    try {
      await this.rt.row(sessionId, signal)
      inspection = await this.rt.sessions.inspect(sessionId, signal)
    } catch (error) {
      this.keepUnread(sessionId, error)
      return
    }
    const values = await this.rt.projections(sessionId, signal).catch(() => null)
    try {
      await this.rt.row(sessionId, signal)
    } catch (error) {
      this.keepUnread(sessionId, error)
      return
    }
    const events = inspection.events
    for (const record of this.tasks.active(sessionId)) {
      if (TERMINAL_TASK_STATES.has(record.state)) continue
      await this.tasks.refresh(record, signal, { events, values }).catch((error: unknown) => {
        this.rt.deps.logger.warn(`Remora: evaluating task ${record.taskId} failed`, error)
      })
    }
    // Task evaluation can await DSH activity hooks; scope may narrow during them.
    try {
      await this.rt.row(sessionId, signal)
    } catch (error) {
      this.keepUnread(sessionId, error)
      return
    }
    this.unread.delete(sessionId)
    const items = this.rt.attention(sessionId, events, values).map(withoutDetail)
    const key = JSON.stringify(items)
    if (this.sent.get(sessionId) === key) return
    if (!this.sent.has(sessionId) && items.length === 0) {
      this.sent.set(sessionId, key)
      return
    }
    this.sent.set(sessionId, key)
    if (items.length === 0) this.cleared.add(sessionId)
    else this.cleared.delete(sessionId)
    const event: AttentionEvent = { kind: 'attention', sessionId, items }
    this.rt.deps.emit(event)
  }
}
