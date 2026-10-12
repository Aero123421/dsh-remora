/**
 * Feature detection. DSH is still evolving, so the plugin never assumes a
 * service exists: an operation is offered only when every DSH service it
 * needs is present AND the plugin implements it. Missing pieces disable just
 * that operation and are listed on the settings tab under compatibility.
 */
import { OPERATIONS, type OperationId } from '@dsh-remora/protocol'

/** DSH services each operation needs. Names are Cordis service keys at DSH 0.2.1-alpha.2. */
export const SERVICE_REQUIREMENTS: Readonly<Record<OperationId, readonly string[]>> = {
  'status': [],
  'hosts.list': [],
  'workspaces.list': ['workspaceRegistry'],
  'sessions.list': ['sessionController'],
  'session.get': ['sessionController'],
  'session.read': ['sessionController'],
  'skills.list': ['sessionController'],
  'task.start': ['sessionController'],
  'task.get': ['sessionController'],
  'task.wait': ['sessionController'],
  'attention.list': ['sessionController'],
  'attention.respond': ['sessionController'],
  'changes.get': ['sessionController'],
  'patch.get': ['sessionController'],
  'deliverable.read': ['sessionController'],
  'session.usage': ['sessionController'],
  'task.steer': ['sessionController'],
  'task.cancel': ['sessionController'],
  'task.resubmit': ['sessionController'],
  'goal.manage': ['sessionController'],
  'job.output': ['sessionController'],
  'workspace.create': ['workspaceRegistry'],
  'model.select': ['sessionController'],
  'command.run': ['commands'],
  'approval.respond': ['sessionController'],
  'terminal.run': ['sessionController'],
  'job.stop': ['sessionController'],
  'schedule.manage': ['sessionController'],
}

/**
 * Operations this build of the plugin actually implements. It grows phase by
 * phase; an operation outside this set is never advertised to the hub, even
 * when DSH could support it.
 */
export const IMPLEMENTED: ReadonlySet<OperationId> = new Set<OperationId>(['status'])

export interface FeatureReport {
  available: OperationId[]
  /** Operations the plugin implements but this DSH cannot serve, with the missing services. */
  missing: { operation: OperationId; services: string[] }[]
}

export function detectFeatures(has: (service: string) => boolean, implemented: ReadonlySet<OperationId> = IMPLEMENTED): FeatureReport {
  const available: OperationId[] = []
  const missing: FeatureReport['missing'] = []
  for (const { id } of OPERATIONS) {
    if (!implemented.has(id)) continue
    const absent = SERVICE_REQUIREMENTS[id].filter(service => !has(service))
    if (absent.length === 0) available.push(id)
    else missing.push({ operation: id, services: absent })
  }
  return { available, missing }
}
