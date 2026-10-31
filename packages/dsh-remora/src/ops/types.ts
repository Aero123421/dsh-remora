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
export type HostOperationId = Exclude<OperationId, 'status' | 'hosts.list' | 'confirmation.get' | 'audit.export' | 'hub.export' | 'host.rotate-key'>

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
  /** Revalidate one approved placement immediately before creating a folder. */
  resolvePlacement?(placementId: string): Promise<PlacementInfo>
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
  /** Recheck this request's current permission and cancellation before a new effect or disclosure. */
  assertAuthorized?: () => void
}

export type OperationHandler<Op extends HostOperationId> =
  (params: OperationParams[Op], context: OperationContext) => Promise<OperationResults[Op]>

export type OperationHandlers = { [Op in HostOperationId]?: OperationHandler<Op> }

/**
 * One `workspace.create` request, kept durably so a retried idempotency key
 * answers the same workspace after a restart and clone progress survives the
 * request (the clone runs in the background, past the hub's request timeout).
 */
export interface WorkspaceCreationRecord {
  /** `<clientId>\u0000<idempotencyKey>`. */
  key: string
  workspaceId: string | null
  path: string
  name: string
  state: 'ready' | 'cloning' | 'clone-failed'
  message?: string
  createdAt: number
  updatedAt: number
  /** Filesystem identity captured for the directory Remora created; older records omit it. */
  directory?: { placementId: string; placementPath: string; dev: string; ino: string }
}

export interface WorkspaceCreationStore {
  list(): WorkspaceCreationRecord[]
  /** Durable before it resolves. */
  put(record: WorkspaceCreationRecord): Promise<void>
}

/**
 * Whether and how Remora takes part in DSH's answerer chains for questions,
 * plan reviews and approvals. Implemented by the core from the settings tab.
 */
export interface AnswerPolicy {
  /** How long Remora keeps a request open for an outside answer when nothing on this PC answers it (ms). 0: Remora does not take part. */
  waitMs(): number
  /** Approvals may be answered from MCP and CLI without the owner's passkey (otherwise only on the hub page, with it). */
  approvalsFromRemote(): boolean
  /** The kill switch is off and the DSH ceiling allows the operation that answers it. */
  allows(operation: 'attention.respond' | 'approval.respond'): boolean
  /** The hub link is up, so an outside answer can arrive. */
  linked(): boolean
}

/** A scheduled prompt created through Remora, so the kill switch and unpairing can take it away. */
export interface RemoteScheduleRecord {
  scheduleId: string
  sessionId: string
  clientId: string
  clientName: string
  createdAt: number
  /** Retry identity, retained with the schedule for 24 hours; absent on older records. */
  idempotencyKey?: string
  /** Hash of the requested session, title, prompt and rule; never holds prompt text. */
  requestHash?: string
}

export interface RemoteScheduleStore {
  list(): RemoteScheduleRecord[]
  put(record: RemoteScheduleRecord): Promise<void>
  remove(scheduleIds: readonly string[]): Promise<void>
}

export interface AdapterDeps {
  scope: ScopePolicy
  tasks: TaskStore
  /** Remote answering of held questions, plan reviews and approvals. Without it Remora never holds them. */
  answers?: AnswerPolicy
  /** Durable workspace.create ledger. Without it the adapter keeps one in memory. */
  workspaceCreations?: WorkspaceCreationStore
  /** Durable list of schedules created through Remora. Without it the adapter keeps one in memory. */
  remoteSchedules?: RemoteScheduleStore
  /** Queue an event for the hub. The core sends task completion and attention changes at once and batches the rest (≥ 30 s). */
  emit(event: HostEvent): void
  logger: HostContext['logger']
}

export interface Adapter {
  handlers: OperationHandlers
  /** Whether a DSH service is present (feeds the compatibility report). */
  has(service: string): boolean
  /** Recover interrupted workspace clones after acquiring the exclusive host lock. */
  prepare?(): Promise<void>
  /** Stop and await background clones before transferring the host lock. */
  stopClones?(): Promise<void>
  /** Begin watching sessions for task progress and attention. Called once the host is paired and connected. */
  start(): void
  /** The settings tab changed something the adapter reads through its deps (answer policy, kill switch). */
  settingsChanged?(): void
  /** The hub link was stopped and will not reconnect. Held questions and approvals are let go. */
  releaseAnswers?(): void
  /** Delete every schedule created through Remora (kill switch, unpairing). Resolves with how many went. */
  removeRemoteSchedules?(): Promise<number>
  dispose(): void | Promise<void>
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
