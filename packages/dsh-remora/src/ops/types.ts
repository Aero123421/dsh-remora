/**
 * The boundary inside the DSH plugin between
 *   - the adapter (src/adapter/**): implements operations on top of DSH APIs, and
 *   - the core (src/core/**, src/client.tsx): pairing, the hub connection,
 *     storage, permission checks, the settings tab, and dispatch.
 *
 * The core calls `createAdapter(ctx, deps)` once and dispatches every allowed
 * request to `adapter.handlers[op]`. The core has ALREADY checked the grant
 * (decide), the kill switch, input validation and confirmations before a
 * handler runs. Handlers still enforce scope (which workspaces/sessions are
 * reachable) through `deps.scope`, because only they know which session an
 * operation touches.
 */
import type {
  Actor, ErrorCode, HostEvent, OperationId, OperationParams, OperationResults, PlacementInfo, RemoraError, TaskState,
} from '@dsh-remora/protocol'
import type { HostContext } from '../dsh.ts'

/** Operations answered by the hub itself never reach the plugin. */
export type HostOperationId = Exclude<OperationId, 'status' | 'hosts.list'>

export interface SessionScopeInput {
  sessionId: string
  workspaceId: string | null
  /** Absolute folder of the workspace, when known. */
  workspacePath: string | null
}

/** What outside clients may reach, as configured on the DSH settings tab. Implemented by the core. */
export interface ScopePolicy {
  canAccessWorkspace(workspaceId: string | null, path: string | null): boolean
  /** Workspace rule + "sessions outside any workspace" switch + per-session exceptions. */
  canAccessSession(session: SessionScopeInput): boolean
  /** Allowed parent folders for new workspaces (realpath-checked by the core when configured). */
  placements(): PlacementInfo[]
  isAllowedSkill(name: string, workspaceId: string | null): boolean
  isAllowedAgentPreset(name: string): boolean
  /** Explicit allow-list only (full access does not widen it); always false for FORBIDDEN_COMMANDS. */
  isAllowedCommand(name: string): boolean
  /** alias -> sessionId, configured on the settings tab. */
  aliases(): Readonly<Record<string, string>>
  /** Hosts allowed in `gitUrl` (e.g. github.com). */
  gitHosts(): readonly string[]
  /** Workspaces created by cloning a Git URL: skills inside stay disabled until allowed on DSH. */
  isUntrustedWorkspace(workspaceId: string): boolean
  markUntrustedWorkspace(workspaceId: string): Promise<void>
}

/** A task started through Remora. Never holds prompt text. Persisted by the core. */
export interface TaskRecord {
  taskId: string
  clientId: string
  sessionId: string | null
  /** remoraRequestId(clientId, taskId): the write-ahead id given to session.prompt. */
  requestId: string
  state: TaskState
  createdAt: number
  updatedAt: number
  error?: RemoraError
}

export interface TaskStore {
  get(taskId: string): TaskRecord | undefined
  list(): TaskRecord[]
  /** Must be durable before it resolves (write-ahead). */
  put(record: TaskRecord): Promise<void>
}

export interface OperationContext {
  actor: Actor
  /** The hub's request id (unique per request). */
  requestId: string
  /** Hub-assigned task id for task.start / task.steer / task.resubmit. */
  taskId?: string
  idempotencyKey?: string
  /** OAuth scopes of the caller; e.g. include `detail`/transcript text only with dsh.content. */
  scopes: readonly string[]
  /**
   * Whether THIS caller has unexpired full remote access: the DSH ceiling AND
   * the caller's hub grant are both `full` and neither has expired. Never
   * derive this from the ceiling alone. Full access does not widen the skill,
   * agent-preset or command allow-lists.
   */
  fullAccess: boolean
  signal: AbortSignal
}

export type OperationHandler<Op extends HostOperationId> =
  (params: OperationParams[Op], context: OperationContext) => Promise<OperationResults[Op]>

export type OperationHandlers = { [Op in HostOperationId]?: OperationHandler<Op> }

export interface AdapterDeps {
  scope: ScopePolicy
  tasks: TaskStore
  /** Queue an event for the hub. The core sends task completion and attention changes at once and batches the rest (≥ 30 s). */
  emit(event: HostEvent): void
  logger: HostContext['logger']
}

export interface Adapter {
  handlers: OperationHandlers
  /** Whether a DSH service is present (feeds the compatibility report). */
  has(service: string): boolean
  /** Begin watching sessions for task progress and attention. Called once the host is paired and connected. */
  start(): void
  dispose(): void
}

export type CreateAdapter = (ctx: HostContext, deps: AdapterDeps) => Adapter

/** Throw from a handler to answer with a structured error instead of `internal`. */
export class OperationError extends Error {
  readonly code: ErrorCode
  readonly details: Partial<RemoraError>
  constructor(code: ErrorCode, message: string, details: Partial<RemoraError> = {}) {
    super(message)
    this.name = 'OperationError'
    this.code = code
    this.details = details
  }
}
