/**
 * Durable ledger of `workspace.create` requests (`WorkspaceCreationStore`):
 * makes the idempotency key survive a restart and records background clone
 * progress. Holds folder names and paths only.
 */
import type { WorkspaceCreationRecord, WorkspaceCreationStore } from '../ops/types.ts'
import { asObject, type DocumentSpec, type JsonDocument } from './storage.ts'

const RETENTION_MS = 30 * 24 * 60 * 60_000
const LIMIT = 500
const STATES = new Set(['ready', 'cloning', 'clone-failed'])

export interface WorkspaceCreationsDocument { creations: WorkspaceCreationRecord[] }

function parseRecord(value: unknown, index: number): WorkspaceCreationRecord {
  const raw = asObject(value, `creations[${index}]`)
  if (typeof raw.key !== 'string' || typeof raw.path !== 'string' || typeof raw.name !== 'string' || typeof raw.state !== 'string' || !STATES.has(raw.state)) {
    throw new Error(`creations[${index}] is invalid`)
  }
  return {
    key: raw.key,
    workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : null,
    path: raw.path,
    name: raw.name,
    state: raw.state as WorkspaceCreationRecord['state'],
    ...(typeof raw.message === 'string' ? { message: raw.message } : {}),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
}

export const workspaceCreationsSpec: DocumentSpec<WorkspaceCreationsDocument> = {
  file: 'workspace-creations.json',
  version: 1,
  migrations: [],
  initial: () => ({ creations: [] }),
  parse: (value) => {
    const raw = asObject(value, 'workspace-creations')
    if (!Array.isArray(raw.creations)) throw new Error('creations must be an array')
    return { creations: raw.creations.map(parseRecord) }
  },
}

export class FileWorkspaceCreationStore implements WorkspaceCreationStore {
  private readonly document: JsonDocument<WorkspaceCreationsDocument>
  private readonly now: () => number

  constructor(document: JsonDocument<WorkspaceCreationsDocument>, now: () => number = Date.now) {
    this.document = document
    this.now = now
  }

  list(): WorkspaceCreationRecord[] {
    return this.document.value.creations.map(record => ({ ...record }))
  }

  async put(record: WorkspaceCreationRecord): Promise<void> {
    const copy = { ...record }
    await this.document.update((current) => {
      const cutoff = this.now() - RETENTION_MS
      const creations = current.creations.filter(item => item.key !== copy.key && (item.state === 'cloning' || item.updatedAt >= cutoff))
      creations.push(copy)
      return { creations: creations.slice(-LIMIT) }
    })
  }
}
