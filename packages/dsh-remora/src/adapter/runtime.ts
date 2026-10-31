/**
 * Shared adapter state: service lookup, the session catalog (non-waking
 * reads), scope checks, and tombstones for sessions that disappeared.
 */
import { realpath } from 'node:fs/promises'
import type { AttentionItem, ModelChoice, SessionSummary } from '@dsh-remora/protocol'
import type { HostContext } from '../dsh.ts'
import type { AdapterDeps, OperationContext, SessionScopeInput, WorkspaceCreationRecord, WorkspaceCreationStore } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redactLine } from '../redact.ts'
import type {
  DshAgent, DshAgents, DshProjectionValues, DshSessionController, DshSessionEvent, DshSessionSummary, DshWorkspace,
  DshWorkspaceRegistry, EventfulContext,
} from './dsh-types.ts'
import { SERVICES } from './dsh-types.ts'
import { denied, fromDsh, notFound, unavailable } from './errors.ts'
import { computeAttention, type HeldAttention } from './events.ts'

export const CONTENT_SCOPE = 'dsh.content'
/** Where the owner trusts a cloned workspace. */
export const UNTRUSTED_FIX = 'dsh:settings/remora#scope'
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
  private readonly parents = new Map<string, string>()
  /** Sessions whose Agent Remora itself woke; used by the `hasLiveClient` heuristic. */
  readonly wokenByRemora = new Set<string>()
  /** Latest auth-looking `api-session/error` per session (login-expired attention). */
  readonly loginErrors = new Map<string, { message: string; at: number }>()

  /** Durable workspace.create ledger (memory fallback when the core gives none). */
  readonly creations: WorkspaceCreationStore
  /** Requests Remora holds open for outside answers, per session (installed by the answerer). */
  heldFor: (sessionId: string) => ReadonlyMap<string, HeldAttention> | undefined = () => undefined

  constructor(ctx: HostContext, deps: AdapterDeps) {
    this.ctx = ctx as HostContext & EventfulContext
    this.deps = deps
    this.creations = deps.workspaceCreations ?? memoryCreations()
  }

  /**
   * Refuse anything that would start or continue agent turns in a workspace
   * that is still cloning, failed to clone, or was cloned and is not trusted
   * yet. DSH lets the model load any skill a turn names in prose, so the only
   * way to keep a cloned repository's skills off is to not drive turns there.
   * Called by every acting path: task.start / steer / resubmit, goal.manage
   * set / resume, command.run, and attention.respond.
   */
  assertCanDriveTurns(workspaceId: string | null): void {
    if (workspaceId === null) return
    const state = this.workspaceState(workspaceId)
    if (state === 'cloning') throw new OperationError('conflict', 'the workspace is still being cloned; try again when workspaces.list shows it ready')
    if (state === 'clone-failed') throw new OperationError('conflict', 'cloning this workspace failed; create it again')
    if (this.deps.scope.isUntrustedWorkspace(workspaceId)) {
      throw new OperationError('denied', 'this workspace was cloned through Remora and is not trusted yet; trust it on the DSH Remora tab (Scope → Untrusted workspaces) before driving the agent there remotely', {
        denial: { layer: 'dsh', reason: 'switched-off' }, fix: UNTRUSTED_FIX,
      })
    }
  }

  /** Clone state of a workspace Remora created; undefined for every other workspace (ready). */
  workspaceState(workspaceId: string): WorkspaceCreationRecord['state'] | undefined {
    let found: WorkspaceCreationRecord | undefined
    for (const record of this.creations.list()) {
      if (record.workspaceId === workspaceId && (!found || record.updatedAt >= found.updatedAt)) found = record
    }
    return found?.state
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

  /**
   * Every session `sessionController.list` returns, enriched with workspace, pin and archive facts.
   * Since DSH 0.2.1-alpha.3 that list omits rows `remoteAccess.allows` rejects. This call is not a
   * Remote invocation, so the owner plugin still receives every row; Remora's own scope applies after that.
   * Never wakes a session.
   */
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
    for (const item of items) {
      if (item.origin === 'subagent' && item.parentSessionId) this.parents.set(item.sessionId, item.parentSessionId)
      else this.parents.delete(item.sessionId)
    }
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
    const current = this.currentRow(row)
    return { sessionId: row.sessionId, workspaceId: current.workspace?.id ?? null, workspacePath: current.workspacePath }
  }

  /** Registry ownership can change while a native read or Agent lookup is pending. */
  currentRow(row: SessionRow): SessionRow {
    const registry = this.workspaces
    if (!registry) return row
    const workspaces = registry.list()
    let id: string | undefined = row.sessionId
    let workspace: DshWorkspace | null = null
    let archived = false
    for (let depth = 0; id && depth < 17; depth++) {
      archived ||= registry.archivedSessionIds.includes(id)
      workspace ??= workspaces.find(item => item.sessionIds.includes(id!)) ?? null
      id = this.parents.get(id)
    }
    return { ...row, workspace, workspacePath: workspace?.path ?? row.summary.cwd ?? null, archived, pinned: registry.pinnedSessionIds.includes(row.sessionId) }
  }

  assertAuthorized(context: OperationContext): void {
    if (context.signal.aborted) {
      throw context.signal.reason instanceof OperationError ? context.signal.reason : unavailable('remote operation was cancelled')
    }
    context.assertAuthorized?.()
  }

  /** Check immediately before native side effects and before returning async reads. */
  assertSession(row: SessionRow, context: OperationContext, drives = false): void {
    this.assertAuthorized(context)
    Object.assign(row, this.currentRow(row))
    if (!this.canAccess(row)) throw denied(`session ${row.sessionId} is outside the workspaces Remora may reach`)
    if (drives) {
      if (row.archived) throw new OperationError('conflict', `session ${row.sessionId} is archived`)
      this.assertCanDriveTurns(row.workspace?.id ?? null)
    }
  }

  assertWorkspace(workspace: DshWorkspace, context: OperationContext, drives = false): void {
    this.assertAuthorized(context)
    const current = this.workspace(workspace.id)
    if (current.path !== workspace.path) throw denied('the workspace folder changed while the operation was pending')
    if (drives) this.assertCanDriveTurns(current.id)
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

  /** Everything waiting for a human in one session, with the routes Remora can answer it by. */
  attention(sessionId: string, events: readonly DshSessionEvent[] | null, values: DshProjectionValues | null): AttentionItem[] {
    return computeAttention(sessionId, { events, values, loginError: this.loginErrors.get(sessionId) ?? null, held: this.heldFor(sessionId) })
  }

  // --- non-waking reads --------------------------------------------------------

  async events(sessionId: string, signal: AbortSignal): Promise<readonly DshSessionEvent[]> {
    try {
      const sessions = this.sessions
      if (typeof sessions.inspect === 'function') return (await sessions.inspect(sessionId, signal)).events
      if (typeof sessions.events !== 'function') throw unavailable('DSH session history is not available')
      const parentSessionId = this.parents.get(sessionId)
      const address = parentSessionId
        ? { kind: 'subagent' as const, parentSessionId, childSessionId: sessionId, mode: 'unknown' as const }
        : { kind: 'session' as const, sessionId }
      const pages: DshSessionEvent[][] = []
      let throughSeq: number | undefined
      let beforeSeq: number | undefined
      for (;;) {
        signal.throwIfAborted()
        const page = await sessions.events({ address, maxMessages: 1000,
          ...(throughSeq === undefined ? {} : { throughSeq }),
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        }, signal)
        signal.throwIfAborted()
        const events = page.records.map(record => record.event)
        pages.push(events)
        throughSeq ??= page.cursor
        if (!page.hasMore) return pages.reverse().flat()
        const firstSeq = events[0]?.seq
        if (firstSeq === undefined || (beforeSeq !== undefined && firstSeq >= beforeSeq)) {
          throw unavailable('DSH session history did not advance to an older page')
        }
        beforeSeq = firstSeq
      }
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
    // Native WorkspaceEntity exposes these through prototype getters; spreading
    // it would discard its path and title instead of capturing their values.
    return {
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      sessionIds: [...workspace.sessionIds],
    }
  }
}

export function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'session/not-found' || code === 'subagent/not-found' || code === 'SESSION_QUERY_SESSION_NOT_FOUND') return true
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

function memoryCreations(): WorkspaceCreationStore {
  const records = new Map<string, WorkspaceCreationRecord>()
  return {
    list: () => [...records.values()],
    put: async (record) => { records.set(record.key, { ...record }) },
  }
}
