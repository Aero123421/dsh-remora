/**
 * Durable list of the DSH schedules created through Remora
 * (`RemoteScheduleStore`): they keep starting turns after the call that made
 * them, so the kill switch and unpairing delete them, and the lists say who
 * made them. Holds ids and client names only, never prompts.
 */
import type { RemoteScheduleRecord, RemoteScheduleStore } from '../ops/types.ts'
import { asObject, type DocumentSpec, type JsonDocument } from './storage.ts'

export interface RemoteSchedulesDocument { schedules: RemoteScheduleRecord[] }

function parseRecord(value: unknown, index: number): RemoteScheduleRecord {
  const raw = asObject(value, `schedules[${index}]`)
  if (typeof raw.scheduleId !== 'string' || typeof raw.sessionId !== 'string' || typeof raw.clientId !== 'string') throw new Error(`schedules[${index}] is invalid`)
  return {
    scheduleId: raw.scheduleId,
    sessionId: raw.sessionId,
    clientId: raw.clientId,
    clientName: typeof raw.clientName === 'string' ? raw.clientName : raw.clientId,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
  }
}

export const remoteSchedulesSpec: DocumentSpec<RemoteSchedulesDocument> = {
  file: 'remote-schedules.json',
  version: 1,
  migrations: [],
  initial: () => ({ schedules: [] }),
  parse: (value) => {
    const raw = asObject(value, 'remote-schedules')
    if (!Array.isArray(raw.schedules)) throw new Error('schedules must be an array')
    return { schedules: raw.schedules.map(parseRecord) }
  },
}

export class FileRemoteScheduleStore implements RemoteScheduleStore {
  private readonly document: JsonDocument<RemoteSchedulesDocument>

  constructor(document: JsonDocument<RemoteSchedulesDocument>) {
    this.document = document
  }

  list(): RemoteScheduleRecord[] {
    return this.document.value.schedules.map(record => ({ ...record }))
  }

  async put(record: RemoteScheduleRecord): Promise<void> {
    // Never trimmed by age: records go when their schedule leaves DSH's catalogue (the adapter prunes them).
    await this.document.update(current => ({ schedules: [...current.schedules.filter(item => item.scheduleId !== record.scheduleId), { ...record }] }))
  }

  async remove(scheduleIds: readonly string[]): Promise<void> {
    if (scheduleIds.length === 0) return
    await this.document.update(current => ({ schedules: current.schedules.filter(item => !scheduleIds.includes(item.scheduleId)) }))
  }
}
