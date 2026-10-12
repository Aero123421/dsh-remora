/**
 * Inputs and outputs of every operation. MCP tools, the HTTP API
 * (`POST /api/v1/ops/<operationId>`), the CLI and the DSH plugin all use
 * these shapes. Field names are part of the public contract: add optional
 * fields freely, never rename or remove one.
 *
 * Conventions
 * - `hostId` may be omitted when exactly one host is paired; the hub fills it
 *   in. With several hosts and no `hostId`, the hub answers `invalid_request`
 *   listing the hosts.
 * - Text that comes from a DSH session (titles, prompts, replies, questions)
 *   is untrusted data. Results that carry transcript text set `untrusted: true`.
 * - Times are epoch milliseconds. Cursors are opaque strings.
 * - `hostId` fields in anything a host sends are overwritten by the hub with
 *   the id of the host connection it arrived on; hosts may send `''`.
 * - Task ids are minted by the hub as `<hostId>-<random>`; the hub routes
 *   ledger operations (task.get / task.wait / task.resubmit) by that prefix.
 * - `task.start` is accepted while the host is offline: the hub parks it
 *   (state `parked`) and delivers it when the host reconnects, or fails it
 *   after an hour. `task.steer`, `task.resubmit` and every other operation
 *   fail fast with `host_offline`.
 * - A task's own final reply (`TaskInfo.result.reply`) is returned to callers
 *   with `dsh.tasks` or `dsh.content`; other transcript text needs `dsh.content`.
 */
import type { RemoraError } from './errors.ts'
import type { AttentionKind, TaskState } from './operations.ts'
import type { Grant } from './permissions.ts'

// --- shared shapes ------------------------------------------------------

export interface HostRef {
  /** Optional when exactly one host is paired. */
  hostId?: string
}

export interface HostSummary {
  hostId: string
  name: string
  online: boolean
  lastSeenAt: number | null
  pluginVersion: string | null
  dshVersion: string | null
  /** Operations this host can serve right now (feature detection ∩ implemented). */
  operations: string[]
  /** The DSH-side ceiling for remote access, as last reported by the host. */
  ceiling: Grant | null
  /** The calling client's grant on this host, set on the hub. */
  grant: Grant | null
  killSwitch: boolean
}

export interface WorkspaceSummary {
  workspaceId: string
  name: string
  /** Absolute folder path on the DSH host. */
  path: string | null
  pinned: boolean
  archived: boolean
  /** Created by cloning a Git URL through Remora; skills inside are not trusted until allowed on DSH. */
  untrusted: boolean
}

export interface ModelChoice {
  provider: string | null
  model: string | null
  effort: string | null
}

export interface ContextPressure {
  usedTokens: number | null
  maxTokens: number | null
  /** 0..1 when both numbers are known. */
  ratio: number | null
}

export interface SessionSummary {
  sessionId: string
  title: string
  workspaceId: string | null
  /** Set for subagent sessions; they are listed under their parent. */
  parentSessionId: string | null
  pinned: boolean
  archived: boolean
  running: boolean
  updatedAt: number | null
  /** Agent preset, e.g. standard / ptc / cordis. Locked after the first turn. */
  agentPreset: string | null
  model: ModelChoice | null
}

export interface TurnPreview {
  index: number
  request: string
  reply: string
  at: number | null
}

export interface AttentionOption {
  id: string
  label: string
}

export interface AttentionItem {
  /** Stable id within the host, e.g. the tool call id or approval id. */
  attentionId: string
  hostId: string
  sessionId: string
  kind: AttentionKind
  /** Short, single-line summary (≤ 120 chars). Untrusted. */
  title: string
  /** Longer text such as the full question or plan. Untrusted. Only returned with the dsh.content scope. */
  detail?: string
  options?: AttentionOption[]
  /** Whether Remora can answer it remotely (questions in continued mode, plan reviews; approvals only in P2). */
  answerable: boolean
  createdAt: number | null
}

export interface ChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown'
  previousPath?: string
  additions?: number
  deletions?: number
}

export interface DeliverableRef {
  deliverableId: string
  title: string
  mimeType: string | null
}

export interface TaskResult {
  /** Final assistant reply of the task's turn. Untrusted. */
  reply: string | null
  changes?: ChangedFile[]
  deliverables?: DeliverableRef[]
}

export interface TaskInfo {
  taskId: string
  hostId: string
  sessionId: string | null
  state: TaskState
  createdAt: number
  updatedAt: number
  /** Present once the task reached a terminal state and the host is reachable. */
  result?: TaskResult
  /** Present while `state` is `needs_attention`. */
  attention?: AttentionItem[]
  error?: RemoraError
  /** True when DSH Web currently shows this session to someone. */
  hasLiveClient?: boolean
}

// --- operation params and results ----------------------------------------

export interface StatusParams {}
export interface StatusResult {
  hosts: HostSummary[]
  running: TaskInfo[]
  attention: AttentionItem[]
  /** Share of the Cloudflare free tier used today, 0..1, per meter. */
  freeTier: { workerRequests: number; durableObjectRequests: number; kvWrites: number }
}

export interface HostsListParams {}
export interface HostsListResult { hosts: HostSummary[] }

export interface WorkspacesListParams extends HostRef { includeArchived?: boolean }
export interface WorkspacesListResult { workspaces: WorkspaceSummary[] }

export interface SessionsListParams extends HostRef {
  workspaceId?: string
  includeArchived?: boolean
  limit?: number
  cursor?: string
}
export interface SessionsListResult { sessions: SessionSummary[]; nextCursor: string | null }

export interface SessionGetParams extends HostRef { sessionId: string }
export interface SessionGetResult {
  session: SessionSummary
  context: ContextPressure | null
  recentTurns: TurnPreview[]
  queueLength: number
  attention: AttentionItem[]
  hasLiveClient: boolean
  untrusted: true
}

export interface TranscriptItem {
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  at: number | null
  toolName?: string
}

export interface SessionReadParams extends HostRef {
  sessionId: string
  depth: 'summary' | 'turns' | 'page'
  cursor?: string
  limit?: number
}
export interface SessionReadResult {
  depth: 'summary' | 'turns' | 'page'
  summary?: { title: string; turnCount: number; lastReply: string | null }
  turns?: TurnPreview[]
  items?: TranscriptItem[]
  nextCursor: string | null
  untrusted: true
}

export interface SkillInfo {
  name: string
  description: string
  /** Where the skill was found, e.g. `.dsh/skills`, `~/.agents/skills`. */
  source: string
}
export interface SkillsListParams extends HostRef { sessionId?: string; workspaceId?: string }
export interface SkillsListResult { skills: SkillInfo[] }

export type TaskTarget =
  | { sessionId: string }
  | { latest: true; workspaceId?: string }
  | { title: string; workspaceId?: string }
  | { alias: string }
  | { new: { workspaceId: string; agentPreset?: string; title?: string } }

export interface TaskStartParams extends HostRef {
  target: TaskTarget
  prompt: string
  /** Skill names; each is added to the prompt as `/name` after an allow-check on DSH. */
  skills?: string[]
  /** Required. The same client + key never starts a second task. */
  idempotencyKey: string
}
export type TaskStartResult = TaskInfo

export interface TaskGetParams { taskId: string }
export type TaskGetResult = TaskInfo

export interface TaskWaitParams { taskId: string; timeoutMs?: number }
export type TaskWaitResult = TaskInfo

export interface AttentionListParams extends HostRef { sessionId?: string }
export interface AttentionListResult { items: AttentionItem[] }

export interface AttentionRespondParams extends HostRef {
  attentionId: string
  sessionId: string
  answer: { optionId?: string; text?: string; approve?: boolean }
}
export interface AttentionRespondResult { accepted: true }

export interface ChangesGetParams extends HostRef { sessionId?: string; taskId?: string }
export interface ChangesGetResult { files: ChangedFile[] }

export interface PatchGetParams extends HostRef { sessionId?: string; taskId?: string; path?: string; maxBytes?: number }
export interface PatchGetResult { patch: string; truncated: boolean; untrusted: true }

export interface DeliverableReadParams extends HostRef { sessionId: string; deliverableId: string; maxBytes?: number }
export interface DeliverableReadResult { title: string; mimeType: string | null; content: string; truncated: boolean; untrusted: true }

export interface SessionUsageParams extends HostRef { sessionId: string }
export interface SessionUsageResult {
  tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; total: number | null }
  context: ContextPressure | null
  breakdown: { label: string; tokens: number }[]
}

export interface TaskSteerParams extends HostRef { taskId?: string; sessionId?: string; prompt: string; idempotencyKey: string }
export type TaskSteerResult = TaskInfo

export interface TaskCancelParams extends HostRef { taskId: string }
export interface TaskCancelResult { cancelled: boolean; how: 'removed-from-queue' | 'stopped-session' | 'already-finished' }

export interface TaskResubmitParams { taskId: string; idempotencyKey: string }
export type TaskResubmitResult = TaskInfo

export interface GoalManageParams extends HostRef {
  sessionId: string
  action: 'get' | 'set' | 'pause' | 'resume' | 'clear'
  goal?: string
}
export interface GoalManageResult { goal: { text: string; state: string } | null }

export interface JobOutputParams extends HostRef { jobId: string; tailBytes?: number }
export interface JobOutputResult { output: string; truncated: boolean; running: boolean; untrusted: true }

export interface PlacementInfo { placementId: string; path: string }
export interface WorkspaceCreateParams extends HostRef {
  /** Id of an allowed parent folder (置き場所) configured on DSH. */
  placementId: string
  /** Folder name to create under the placement. */
  name: string
  /** https Git URL to clone into the new folder. */
  gitUrl?: string
  idempotencyKey: string
}
export interface WorkspaceCreateResult { workspace: WorkspaceSummary }

export interface ModelSelectParams extends HostRef { sessionId: string; provider?: string; model: string; effort?: string }
export interface ModelSelectResult {
  model: ModelChoice
  /** DSH also stores the choice as the default for new sessions. */
  savedAsDefault: boolean
  /** Present when the requested name did not match: the choices DSH offers. */
  candidates?: ModelChoice[]
}

export interface CommandRunParams extends HostRef { sessionId: string; command: string; args?: string }
export interface CommandRunResult { accepted: boolean; output: string | null; untrusted: true }

/** Placements are needed by clients to call workspace.create; returned alongside workspaces by the host. */
export interface PlacementsListResult { placements: PlacementInfo[] }

export interface OperationParams {
  'status': StatusParams
  'hosts.list': HostsListParams
  'workspaces.list': WorkspacesListParams
  'sessions.list': SessionsListParams
  'session.get': SessionGetParams
  'session.read': SessionReadParams
  'skills.list': SkillsListParams
  'task.start': TaskStartParams
  'task.get': TaskGetParams
  'task.wait': TaskWaitParams
  'attention.list': AttentionListParams
  'attention.respond': AttentionRespondParams
  'changes.get': ChangesGetParams
  'patch.get': PatchGetParams
  'deliverable.read': DeliverableReadParams
  'session.usage': SessionUsageParams
  'task.steer': TaskSteerParams
  'task.cancel': TaskCancelParams
  'task.resubmit': TaskResubmitParams
  'goal.manage': GoalManageParams
  'job.output': JobOutputParams
  'workspace.create': WorkspaceCreateParams
  'model.select': ModelSelectParams
  'command.run': CommandRunParams
  'approval.respond': AttentionRespondParams
  'terminal.run': HostRef & { command: string; cwdWorkspaceId: string; timeoutMs?: number }
  'job.stop': HostRef & { jobId: string }
  'schedule.manage': HostRef & { action: 'list' | 'create' | 'delete'; scheduleId?: string; spec?: unknown }
}

export interface OperationResults {
  'status': StatusResult
  'hosts.list': HostsListResult
  'workspaces.list': WorkspacesListResult & PlacementsListResult
  'sessions.list': SessionsListResult
  'session.get': SessionGetResult
  'session.read': SessionReadResult
  'skills.list': SkillsListResult
  'task.start': TaskStartResult
  'task.get': TaskGetResult
  'task.wait': TaskWaitResult
  'attention.list': AttentionListResult
  'attention.respond': AttentionRespondResult
  'changes.get': ChangesGetResult
  'patch.get': PatchGetResult
  'deliverable.read': DeliverableReadResult
  'session.usage': SessionUsageResult
  'task.steer': TaskSteerResult
  'task.cancel': TaskCancelResult
  'task.resubmit': TaskResubmitResult
  'goal.manage': GoalManageResult
  'job.output': JobOutputResult
  'workspace.create': WorkspaceCreateResult
  'model.select': ModelSelectResult
  'command.run': CommandRunResult
  'approval.respond': AttentionRespondResult
  'terminal.run': { exitCode: number | null; output: string; truncated: boolean; untrusted: true }
  'job.stop': { stopped: boolean }
  'schedule.manage': { schedules: unknown[] }
}

/**
 * Operations the hub answers itself. `task.get`/`task.wait` use the hub's
 * ledger and ask the host only for the result of a finished task.
 */
export const HUB_OPERATIONS: ReadonlySet<string> = new Set(['status', 'hosts.list'])

/** Operations the hub resolves to a host through its task ledger (no hostId needed). */
export const TASK_LEDGER_OPERATIONS: ReadonlySet<string> = new Set(['task.get', 'task.wait', 'task.resubmit'])
