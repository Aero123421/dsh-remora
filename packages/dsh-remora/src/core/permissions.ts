/**
 * DSH-side permission helpers: what the ceiling allows, and whether a
 * settings change widens what outsiders can reach. Widening changes are only
 * accepted from a browser on this PC (see `routes.ts`); narrowing is always
 * accepted, from anywhere.
 */
import { SCOPES, decide, type Grant, type OperationId } from '@dsh-remora/protocol'
import { ALL_OPERATION_IDS, type RemoraSettings } from './settings.ts'

const UNLIMITED: Grant = { level: 'full' }

/** Operations the ceiling alone allows right now (the hub grant and token scope still apply per request). */
export function ceilingAllows(ceiling: Grant, now: number): Set<OperationId> {
  const allowed = new Set<OperationId>()
  for (const id of ALL_OPERATION_IDS) {
    if (decide({ operation: id, ceiling, hubGrant: UNLIMITED, tokenScopes: SCOPES, now }).allowed) allowed.add(id)
  }
  return allowed
}

/** Whether a full ceiling is in force (set and not expired). */
export function fullAccessActive(ceiling: Grant, now: number): boolean {
  return ceiling.level === 'full' && (ceiling.fullAccessExpiresAt === undefined || ceiling.fullAccessExpiresAt > now)
}

function added<T>(before: readonly T[], after: readonly T[]): T[] {
  return after.filter(item => !before.includes(item))
}

/**
 * Reasons why `next` reaches more than `previous`. Empty means the change is
 * neutral or narrowing. Aliases and the display name never widen access.
 */
export function wideningReasons(previous: RemoraSettings, next: RemoraSettings, now: number): string[] {
  const reasons: string[] = []
  const before = ceilingAllows(previous.ceiling, now)
  const after = ceilingAllows(next.ceiling, now)
  if ([...after].some(id => !before.has(id))) reasons.push('operations')
  if (fullAccessActive(next.ceiling, now)) {
    const was = fullAccessActive(previous.ceiling, now) ? previous.ceiling.fullAccessExpiresAt ?? Infinity : -Infinity
    if ((next.ceiling.fullAccessExpiresAt ?? Infinity) > was) reasons.push('full-access')
  }
  if (previous.killSwitch && !next.killSwitch) reasons.push('kill-switch')
  const a = previous.scope
  const b = next.scope
  if (added(a.workspaces, b.workspaces).length > 0) reasons.push('workspaces')
  if (!a.outsideWorkspace && b.outsideWorkspace) reasons.push('outside-workspace')
  const allowExceptions = (list: typeof a.exceptions) => list.filter(e => e.allow).map(e => e.sessionId)
  const denyExceptions = (list: typeof a.exceptions) => list.filter(e => !e.allow).map(e => e.sessionId)
  if (added(allowExceptions(a.exceptions), allowExceptions(b.exceptions)).length > 0) reasons.push('exceptions')
  if (denyExceptions(a.exceptions).some(id => !denyExceptions(b.exceptions).includes(id))) reasons.push('exceptions')
  const placementKey = (p: { placementId: string; path: string }) => `${p.placementId}\n${p.path}`
  if (added(a.placements.map(placementKey), b.placements.map(placementKey)).length > 0) reasons.push('placements')
  if (added(a.skills, b.skills).length > 0) reasons.push('skills')
  if (added(a.agentPresets, b.agentPresets).length > 0) reasons.push('agent-presets')
  if (added(a.commands, b.commands).length > 0) reasons.push('commands')
  if (added(a.gitHosts, b.gitHosts).length > 0) reasons.push('git-hosts')
  if (a.untrustedWorkspaces.some(id => !b.untrustedWorkspaces.includes(id))) reasons.push('trust')
  if (previous.hubUrl !== next.hubUrl && next.hubUrl !== null) reasons.push('hub-url')
  return [...new Set(reasons)]
}
