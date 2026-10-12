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

  async put(record: TaskRecord): Promise<void> {
    const copy: TaskRecord = { ...record }
    await this.document.update(current => {
      const tasks = current.tasks.filter(item => item.taskId !== copy.taskId)
      tasks.push(copy)
      return { tasks: prune(tasks, this.now()) }
    })
    this.index.clear()
    for (const item of this.document.value.tasks) this.index.set(item.taskId, item)
  }
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
