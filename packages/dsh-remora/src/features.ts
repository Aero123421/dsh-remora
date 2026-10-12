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
  'skills.list': ['sessionController', 'sessionSkillCatalog'],
  'task.start': ['sessionController', 'workspaceRegistry'],
  'task.get': ['sessionController'],
  'task.wait': ['sessionController'],
  'attention.list': ['sessionController'],
  'attention.respond': ['sessionController', 'userQuestions'],
  'changes.get': ['sessionController', 'workspaceChanges'],
  'patch.get': ['sessionController', 'workspaceChanges'],
  'deliverable.read': ['sessionController'],
  'session.usage': ['sessionController'],
  'task.steer': ['sessionController'],
  'task.cancel': ['sessionController'],
  'task.resubmit': ['sessionController'],
  'goal.manage': ['sessionController', 'goals'],
  'job.output': ['sessionController', 'jobs'],
  'workspace.create': ['workspaceRegistry'],
  'model.select': ['sessionController'],
  'command.run': ['sessionController', 'commands'],
  // Answered by holding the `approval/request` chain (adapter/answerer.ts).
  'approval.respond': ['sessionController', 'approval'],
  'sessions.search': ['sessionController'],
  'session.fork': ['sessionController'],
  'job.stop': ['sessionController', 'jobs'],
  'schedules.list': ['sessionController', 'schedule'],
  'schedule.create': ['sessionController', 'schedule'],
  'schedule.delete': ['sessionController', 'schedule'],
  'terminal.run': ['workspaceRegistry', 'subprocess'],
  // Answered by the hub from its confirmation ledger; never offered by a host.
  'confirmation.get': [],
  // Hub maintenance the hub answers itself.
  'audit.export': [],
  'hub.export': [],
  // Served by the connection (rotate-key frames), not by DSH: core/remora.ts.
  'host.rotate-key': [],
}

/**
 * Operations this build of the plugin actually implements. It grows phase by
 * phase; an operation outside this set is never advertised to the hub, even
 * when DSH could support it.
 */
export const IMPLEMENTED: ReadonlySet<OperationId> = new Set<OperationId>([
  'status',
  // P0
  'workspaces.list', 'sessions.list', 'session.get', 'session.read', 'skills.list',
  'task.start', 'task.get', 'task.wait', 'attention.list',
  // P1
  'attention.respond', 'changes.get', 'patch.get', 'deliverable.read', 'session.usage',
  'task.steer', 'task.cancel', 'task.resubmit', 'goal.manage', 'job.output',
  'workspace.create', 'model.select', 'command.run', 'approval.respond',
  // P2
  'sessions.search', 'session.fork', 'job.stop', 'schedules.list', 'schedule.create', 'schedule.delete', 'terminal.run',
  // Served by the connection itself.
  'host.rotate-key',
])

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
