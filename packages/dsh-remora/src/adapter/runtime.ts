/**
 * Shared adapter state: service lookup, the session catalog (non-waking
 * reads), scope checks, and tombstones for sessions that disappeared.
 */
import { realpath } from 'node:fs/promises'
import type { ModelChoice, SessionSummary } from '@dsh-remora/protocol'
import type { HostContext } from '../dsh.ts'
import type { AdapterDeps, OperationContext, SessionScopeInput } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redactLine } from '../redact.ts'
import type {
  DshAgent, DshAgents, DshProjectionValues, DshSessionController, DshSessionEvent, DshSessionSummary, DshWorkspace,
  DshWorkspaceRegistry, EventfulContext,
} from './dsh-types.ts'
import { SERVICES } from './dsh-types.ts'
import { denied, fromDsh, notFound, unavailable } from './errors.ts'

export const CONTENT_SCOPE = 'dsh.content'
const TOMBSTONE_MS = 24 * 60 * 60 * 1000

export interface SessionRow {
  summary: DshSessionSummary
  sessionId: string
  title: string
  workspace: DshWorkspace | null
  workspacePath: string | null
  /** Parent for subagent sessions (origin === 'subagent'); forks are ordinary sessions. */
  parentSessionId: string | null
  subagent: boolean
  pinned: boolean
  archived: boolean
  values: DshProjectionValues
}

export function hasContent(context: Pick<OperationContext, 'scopes'>): boolean {
  return context.scopes.includes(CONTENT_SCOPE)
}

export function modelOf(values: DshProjectionValues | null | undefined): ModelChoice | null {
  const selection = values?.modelSelection?.next ?? values?.modelSelection?.lastUsed ?? null
  if (!selection) return null
  return { provider: selection.provider ?? null, model: selection.model ?? null, effort: selection.reasoningEffort ?? null }
}

export class Runtime {
  readonly ctx: HostContext & EventfulContext
  readonly deps: AdapterDeps
  /** Sessions this adapter has seen exist, so a later miss can be reported as `gone`. */
  private readonly seen = new Set<string>()
  private readonly tombstones = new Map<string, number>()
  /** Sessions whose Agent Remora itself woke; used by the `hasLiveClient` heuristic. */
  readonly wokenByRemora = new Set<string>()
  /** Latest auth-looking `api-session/error` per session (login-expired attention). */
  readonly loginErrors = new Map<string, { message: string; at: number }>()

  constructor(ctx: HostContext, deps: AdapterDeps) {
    this.ctx = ctx as HostContext & EventfulContext
    this.deps = deps
  }

  get<T>(name: string): T | undefined {
    return this.ctx.get(name) as T | undefined
  }

  require<T>(name: string): T {
    const service = this.get<T>(name)
    if (service === undefined) throw unavailable(`DSH service "${name}" is not available`)
    return service
  }

  get sessions(): DshSessionController { return this.require<DshSessionController>(SERVICES.sessionController) }
  get workspaces(): DshWorkspaceRegistry | undefined { return this.get<DshWorkspaceRegistry>(SERVICES.workspaceRegistry) }
  get agents(): DshAgents | undefined { return this.get<DshAgents>(SERVICES.agents) }

  liveAgent(sessionId: string): DshAgent | undefined {
    try {
      return this.agents?.get(sessionId)
    } catch {
      return undefined
    }
  }

  isRunning(sessionId: string): boolean {
    return this.liveAgent(sessionId)?.status === 'running'
  }

  /**
   * Heuristic: DSH has no public "who is viewing" API. DSH Web's `follow`
   * wakes the session, so a live Agent that Remora did not wake itself most
   * likely has a browser attached (other wakers: schedules, subagent
   * deliveries).
   */
  hasLiveClient(sessionId: string): boolean {
    return this.liveAgent(sessionId) !== undefined && !this.wokenByRemora.has(sessionId)
  }

  // --- catalog -------------------------------------------------------------------

  /** Every session DSH lists, enriched with workspace, pin and archive facts. Never wakes a session. */
  async catalog(signal: AbortSignal): Promise<SessionRow[]> {
    let items: readonly DshSessionSummary[]
    try {
      items = (await this.sessions.list({}, signal)).items
    } catch (error) {
      throw fromDsh(error, 'listing sessions failed')
    }
    const registry = this.workspaces
    const workspaces = registry?.list() ?? []
    const owner = new Map<string, DshWorkspace>()
    for (const workspace of workspaces) for (const id of workspace.sessionIds) if (!owner.has(id)) owner.set(id, workspace)
    const archived = new Set(registry?.archivedSessionIds ?? [])
    const pinned = new Set(registry?.pinnedSessionIds ?? [])
    const byId = new Map(items.map(item => [item.sessionId, item]))
    const workspaceOf = (item: DshSessionSummary, depth = 0): DshWorkspace | null => {
      const direct = owner.get(item.sessionId)
      if (direct) return direct
      if (item.origin === 'subagent' && item.parentSessionId && depth < 16) {
        const parent = byId.get(item.parentSessionId)
        if (parent) return workspaceOf(parent, depth + 1)
      }
      return null
    }
    const archivedOf = (item: DshSessionSummary, depth = 0): boolean => {
      if (archived.has(item.sessionId)) return true
      if (item.origin === 'subagent' && item.parentSessionId && depth < 16) {
        if (archived.has(item.parentSessionId)) return true
        const parent = byId.get(item.parentSessionId)
        if (parent) return archivedOf(parent, depth + 1)
      }
      return false
    }
    return items.map((summary) => {
      const values = summary.projections?.values ?? {}
      const workspace = workspaceOf(summary)
      const subagent = summary.origin === 'subagent'
      this.seen.add(summary.sessionId)
      this.tombstones.delete(summary.sessionId)
      return {
        summary,
        sessionId: summary.sessionId,
        title: typeof values.title === 'string' && values.title !== '' ? values.title : '',
        workspace,
        workspacePath: workspace?.path ?? summary.cwd ?? null,
        parentSessionId: subagent ? summary.parentSessionId ?? null : null,
        subagent,
        pinned: pinned.has(summary.sessionId),
        archived: archivedOf(summary),
        values,
      }
    })
  }

  scopeInput(row: SessionRow): SessionScopeInput {
    return { sessionId: row.sessionId, workspaceId: row.workspace?.id ?? null, workspacePath: row.workspacePath }
  }

  canAccess(row: SessionRow): boolean {
    try {
      return this.deps.scope.canAccessSession(this.scopeInput(row))
    } catch {
      return false
    }
  }

  /** Find one session the caller may reach, or throw not_found / gone / denied. */
  async row(sessionId: string, signal: AbortSignal): Promise<SessionRow> {
    const rows = await this.catalog(signal)
    const row = rows.find(item => item.sessionId === sessionId)
    if (!row) throw this.missing(sessionId)
    if (!this.canAccess(row)) throw denied(`session ${sessionId} is outside the workspaces Remora may reach`)
    return row
  }

  /** Error for an unknown session: `gone` when it existed before (tombstone), else `not_found`. */
  missing(sessionId: string): OperationError {
    const now = Date.now()
    for (const [id, at] of this.tombstones) if (now - at > TOMBSTONE_MS) this.tombstones.delete(id)
    if (this.seen.has(sessionId)) {
      this.seen.delete(sessionId)
      this.tombstones.set(sessionId, now)
    }
    if (this.tombstones.has(sessionId)) return new OperationError('gone', `session ${sessionId} was deleted`)
    return notFound(`session ${sessionId} not found`)
  }

  markSeen(sessionId: string): void {
    this.seen.add(sessionId)
  }

  summaryOf(row: SessionRow): SessionSummary {
    return {
      sessionId: row.sessionId,
      title: redactLine(row.title || 'New session', 200),
      workspaceId: row.workspace?.id ?? null,
      parentSessionId: row.parentSessionId,
      pinned: row.pinned,
      archived: row.archived,
      running: row.summary.running || this.isRunning(row.sessionId),
      updatedAt: row.summary.updatedAt ?? null,
      agentPreset: typeof row.values.agentPreset === 'string' ? row.values.agentPreset : null,
      model: modelOf(row.values),
    }
  }

  // --- non-waking reads --------------------------------------------------------

  async events(sessionId: string, signal: AbortSignal): Promise<readonly DshSessionEvent[]> {
    try {
      return (await this.sessions.inspect(sessionId, signal)).events
    } catch (error) {
      if (isNotFound(error)) throw this.missing(sessionId)
      throw fromDsh(error, 'reading the session log failed')
    }
  }

  async projections(sessionId: string, signal: AbortSignal): Promise<DshProjectionValues | null> {
    try {
      const value = await this.sessions.projections({ sessionId }, signal)
      return value === null ? null : value.values
    } catch (error) {
      if (isNotFound(error)) return null
      throw fromDsh(error, 'reading session projections failed')
    }
  }

  // --- waking operations -------------------------------------------------------

  /** Resolve (and wake if cold) the live Agent of an ordinary session. Only for operations that act. */
  async agent(sessionId: string): Promise<DshAgent> {
    const wasLive = this.liveAgent(sessionId) !== undefined
    let result: Awaited<ReturnType<DshSessionController['resolveAgent']>>
    try {
      result = await this.sessions.resolveAgent(sessionId)
    } catch (error) {
      throw fromDsh(error, 'waking the session failed')
    }
    if ('error' in result) {
      if (result.error.code === 'session/not-found') throw this.missing(sessionId)
      throw fromDsh(result.error, 'waking the session failed')
    }
    if (!wasLive) this.wokenByRemora.add(sessionId)
    return result.agent
  }

  noteWake(sessionId: string, wasLive: boolean): void {
    if (!wasLive) this.wokenByRemora.add(sessionId)
  }

  /** Workspace the caller may reach, or throw. */
  workspace(workspaceId: string): DshWorkspace {
    const registry = this.workspaces
    if (!registry) throw unavailable('DSH workspace registry is not available')
    const workspace = registry.get(workspaceId)
    if (!workspace) throw notFound(`workspace ${workspaceId} not found`)
    if (!this.deps.scope.canAccessWorkspace(workspace.id, workspace.path)) {
      throw denied(`workspace ${workspaceId} is outside the workspaces Remora may reach`)
    }
    return workspace
  }
}

export function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'session/not-found' || code === 'SESSION_QUERY_SESSION_NOT_FOUND') return true
  // inspect() throws ApiSessionNotFound (a bare Error subclass) for a cold miss.
  return error instanceof Error && code === undefined
    && (error.constructor.name === 'ApiSessionNotFound' || /^session ".*" not found$/.test(error.message))
}

/** realpath that returns null instead of throwing. */
export async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}
