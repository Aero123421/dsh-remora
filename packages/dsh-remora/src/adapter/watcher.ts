/**
 * Watching for task progress and attention without polling: the adapter
 * subscribes to in-process Cordis events (`session/event`,
 * `api-session/status`, `api-session/error`) and re-evaluates the touched
 * session after a short debounce. Only live sessions emit events; cold
 * sessions cannot change.
 */
import { TERMINAL_TASK_STATES, type AttentionEvent } from '@dsh-remora/protocol'
import type { Disposer, DshWorkspace } from './dsh-types.ts'
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
  /** Last attention list sent per session (JSON, without detail). */
  private readonly sent = new Map<string, string>()
  private readonly abort = new AbortController()
  private started = false

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
    // Catch up after a restart or reconnect: every unfinished task, once.
    for (const sessionId of new Set(this.tasks.active().flatMap(record => record.sessionId ? [record.sessionId] : []))) this.schedule(sessionId, 0)
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

  /** Wait for pending refreshes (tests). */
  async idle(): Promise<void> {
    while (this.timers.size > 0 || this.running.size > 0) {
      await Promise.all([...this.running.values()])
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  private scopeAllows(sessionId: string, meta: { cwd?: string; origin?: string; parentSession?: string } | undefined): boolean {
    const registry = this.rt.workspaces
    const workspaces: readonly DshWorkspace[] = registry?.list() ?? []
    const owner = (id: string): DshWorkspace | undefined => workspaces.find(workspace => workspace.sessionIds.includes(id))
    const workspace = owner(sessionId) ?? (meta?.origin === 'subagent' && meta.parentSession ? owner(meta.parentSession) : undefined)
    try {
      return this.rt.deps.scope.canAccessSession({ sessionId, workspaceId: workspace?.id ?? null, workspacePath: workspace?.path ?? meta?.cwd ?? null })
    } catch {
      return false
    }
  }

  private async refresh(sessionId: string): Promise<void> {
    const signal = this.abort.signal
    let inspection
    try {
      inspection = await this.rt.sessions.inspect(sessionId, signal)
    } catch {
      return
    }
    const values = await this.rt.projections(sessionId, signal).catch(() => null)
    const events = inspection.events
    for (const record of this.tasks.active(sessionId)) {
      if (TERMINAL_TASK_STATES.has(record.state)) continue
      await this.tasks.refresh(record, signal, { events, values }).catch((error: unknown) => {
        this.rt.deps.logger.warn(`Remora: evaluating task ${record.taskId} failed`, error)
      })
    }
    if (!this.scopeAllows(sessionId, inspection.meta)) return
    const items = this.rt.attention(sessionId, events, values).map(withoutDetail)
    const key = JSON.stringify(items)
    if (this.sent.get(sessionId) === key) return
    if (!this.sent.has(sessionId) && items.length === 0) {
      this.sent.set(sessionId, key)
      return
    }
    this.sent.set(sessionId, key)
    const event: AttentionEvent = { kind: 'attention', sessionId, items }
    this.rt.deps.emit(event)
  }
}
