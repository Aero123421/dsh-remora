/**
 * The task ledger (`TaskStore`). Records never hold prompt text. `put`
 * resolves only after the record is durable, so the adapter can write a task
 * before handing its requestId to DSH (write-ahead).
 */
import { TERMINAL_TASK_STATES } from '@dsh-remora/protocol'
import type { TaskRecord, TaskStore } from '../ops/types.ts'
import type { JsonDocument } from './storage.ts'
import type { TasksDocument } from './settings.ts'

export const TASK_RETENTION_MS = 30 * 24 * 60 * 60_000
export const TASK_LIMIT = 2000

export class FileTaskStore implements TaskStore {
  private readonly document: JsonDocument<TasksDocument>
  private readonly index = new Map<string, TaskRecord>()
  private readonly now: () => number

  constructor(document: JsonDocument<TasksDocument>, now: () => number = Date.now) {
    this.document = document
    this.now = now
    for (const record of document.value.tasks) this.index.set(record.taskId, record)
  }

  get(taskId: string): TaskRecord | undefined {
    return this.index.get(taskId)
  }

  list(): TaskRecord[] {
    return [...this.index.values()]
  }

  /** Load the ledger written by a previous connection owner before takeover. */
  async refresh(): Promise<void> {
    const current = await this.document.refresh()
    this.index.clear()
    for (const item of current.tasks) this.index.set(item.taskId, item)
  }

  async put(record: TaskRecord): Promise<void> {
    const copy: TaskRecord = { ...record }
    await this.document.update(current => {
      const previous = current.tasks.find(item => item.taskId === copy.taskId)
      if (previous && !canReplaceTask(previous.state, copy.state)) return current
      const tasks = current.tasks.filter(item => item.taskId !== copy.taskId)
      tasks.push(copy)
      return { tasks: prune(tasks, this.now()) }
    })
    this.index.clear()
    for (const item of this.document.value.tasks) this.index.set(item.taskId, item)
  }
}

/**
 * A cancelled task stays cancelled. A completed task stays completed.
 * `failed` may return to `accepted` for a retry that DSH has not accepted yet.
 * No other terminal state becomes a non-terminal one.
 */
export function canReplaceTask(previous: TaskRecord['state'], next: TaskRecord['state']): boolean {
  if (previous === next) return true
  if (previous === 'cancelled' || previous === 'completed') return false
  if (previous === 'failed') return next === 'accepted'
  if (TERMINAL_TASK_STATES.has(previous) && !TERMINAL_TASK_STATES.has(next)) return false
  return true
}

/** Forget finished tasks after the retention period, and the oldest finished ones beyond the limit. */
export function prune(tasks: TaskRecord[], now: number): TaskRecord[] {
  let kept = tasks.filter(task => !(TERMINAL_TASK_STATES.has(task.state) && now - task.updatedAt > TASK_RETENTION_MS))
  if (kept.length > TASK_LIMIT) {
    const finished = kept.filter(task => TERMINAL_TASK_STATES.has(task.state)).sort((a, b) => a.updatedAt - b.updatedAt)
    const drop = new Set(finished.slice(0, kept.length - TASK_LIMIT).map(task => task.taskId))
    kept = kept.filter(task => !drop.has(task.taskId))
  }
  return kept
}
