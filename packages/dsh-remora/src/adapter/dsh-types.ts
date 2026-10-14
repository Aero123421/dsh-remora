/**
 * Structural types for the DSH (0.2.1-alpha.2) services the adapter touches.
 *
 * DSH packages are not dependencies of the plugin, so these are hand-written
 * mirrors of the real shapes, trimmed to the fields actually read. Every
 * service is looked up with `ctx.get(name)` and may be absent; the adapter
 * then disables the operations that need it (see `features.ts`).
 *
 * Source of truth (commit d743267). On 2fbf435 (0.2.1-alpha.3), sessionController.list
 * and search filter rows with remoteAccess.allows; the fields below are the ones the adapter reads.
 * - sessionController: packages/api/session-controller/src/{index,types,commands}.ts
 * - workspaceRegistry: packages/workspace/workspace/src/{index,types}.ts
 * - userQuestions:     packages/interaction/user-questions/src/{index,types}.ts
 * - goals:             packages/goal/goal/src/{index,types}.ts
 * - commands:          packages/interaction/commands/src/{index,types}.ts
 * - jobs:              packages/jobs/jobs/src/{index,types,view}.ts
 * - workspaceChanges:  packages/deliverables/workspace-changes/src/types.ts
 * - sessionSkillCatalog / skills: session-controller/src/skill-catalog.ts, packages/skill/skill
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** `RemoteError` from @deepseek-ai/dsh-typert-protocol: an Error with a namespaced `code`. */
export interface DshRemoteErrorLike {
  name?: string
  code: string
  message: string
  details?: unknown
}

// --- sessions -----------------------------------------------------------------

export interface DshModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Known projection values (all optional: a missing key is an absent capability). */
export interface DshProjectionValues {
  title?: string | null
  agentPreset?: string | null
  modelSelection?: { lastUsed: DshModelSelection | null; next: DshModelSelection | null }
  sessionListMetadata?: { blank: boolean; lastPromptAt: number | null }
  turnOutline?: readonly { turn: number; seq: number; prompt: string; response: string }[]
  inbox?: { 'next-turn': readonly Json[]; 'next-step': readonly Json[] }
  tokenUsage?: { uncachedInputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  contextPressure?: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number }
  contextBreakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number }
  goal?: DshGoalProjection | null
  userQuestions?: { active: readonly DshPendingUserQuestion[]; settled: readonly unknown[] }
  plan?: { active: boolean; pending: boolean }
  workingDirectory?: string | null
  [key: string]: unknown
}

export interface DshSessionSummary {
  agentAvailable: boolean
  formatStatus?: 'current' | 'migration-required'
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
  projections?: { kind: 'cached' | 'sequenced'; asOfSeq: number; values: DshProjectionValues }
}

export interface DshSessionHeader {
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  isSeeded?: boolean
  origin?: 'subagent'
  agentPreset?: string
}

export interface DshSessionEvent {
  type: string
  seq: number
  time: number
  data: any
}

export interface DshSessionInspection {
  meta: DshSessionHeader
  inheritedEventCount: number
  events: readonly DshSessionEvent[]
}

export type DshProjectionsValue =
  | { kind: 'sequenced'; asOfSeq: number; values: DshProjectionValues }
  | { kind: 'migration-required'; values: DshProjectionValues }
  | null

export type DshPromptContentPart = { type: 'text'; text: string }

export interface DshAgent {
  id: string
  status: 'idle' | 'running' | string
  session: { id: string }
}

export interface DshModelCatalog {
  default: DshModelSelection
  routableProviders: readonly string[]
  groups: readonly {
    id: string
    name: string
    models: readonly {
      id: string
      name: string
      reasoning?: { efforts: readonly { id: string; name: string }[]; defaultEffort?: string }
    }[]
  }[]
  failures: readonly { id: string; name: string; message: string }[]
}

export interface DshSessionController {
  list(request: { cursor?: string }, signal: AbortSignal): Promise<{ items: readonly DshSessionSummary[] }>
  inspect(sessionId: string, signal?: AbortSignal): Promise<DshSessionInspection>
  projections(request: { sessionId: string }, signal: AbortSignal): Promise<DshProjectionsValue>
  create(request: { workspaceId?: string; cwd?: string; sessionId?: string; agentPreset?: string }): Promise<{ sessionId: string; agentPreset?: string }>
  rename(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: readonly DshPromptContentPart[]
    clientTimeZone?: string
  }, signal: AbortSignal): Promise<{ accepted: true }>
  updateQueue(request: { sessionId: string; itemId: string; action: { kind: 'remove' } | { kind: 'steer' } }): Promise<{ accepted: true }>
  cancel(request: { sessionId: string }): { accepted: true } | Promise<{ accepted: true }>
  selectModel(request: { sessionId: string } & DshModelSelection): Promise<{ selected: DshModelSelection }>
  modelCatalog(): Promise<DshModelCatalog>
  resolveAgent(sessionId: string): Promise<{ agent: DshAgent } | { error: DshRemoteErrorLike }>
  /** New ordinary session from an exact event prefix (`atSeq` inclusive; default: the latest finished turn). */
  fork?(request: { sessionId: string; atSeq?: number; allowMigration?: boolean }): Promise<{ sessionId: string }>
}

// --- workspaces ---------------------------------------------------------------

export interface DshWorkspace {
  id: string
  path: string
  title: string
  createdAt: string
  updatedAt: string
  sessionIds: readonly string[]
}

export interface DshWorkspaceRegistry {
  list(): DshWorkspace[]
  get(id: string): DshWorkspace | undefined
  create(path: string): Promise<DshWorkspace>
  resolveByPath(path: string): Promise<DshWorkspace | undefined>
  /** Unregister (folder and session logs are kept). */
  delete(id: string): Promise<boolean>
  readonly archivedSessionIds: readonly string[]
  readonly pinnedSessionIds: readonly string[]
}

// --- interaction --------------------------------------------------------------

export interface DshQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

export interface DshPendingUserQuestion {
  callId: string
  questions: readonly DshQuestionItem[]
  state: 'open' | 'continued'
}

export interface DshUserQuestions {
  answer(agent: DshAgent, callId: string, answer: { answers: { id: string; selected: string[]; custom?: string }[] }): boolean
}

export interface DshGoalSnapshot {
  id: string
  revision: number
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  blockedReason?: { code: string; message: string }
  maxGoalRounds: number
}

export interface DshGoalProjection {
  goal: DshGoalSnapshot
  roundsStarted: number
  createdAt: number
  updatedAt: number
}

export interface DshGoalView extends DshGoalSnapshot {
  roundsStarted: number
  createdAt: number
  updatedAt: number
  activation: 'armed' | 'disarmed'
}

export interface DshGoals {
  get(agent: DshAgent): DshGoalView | undefined
  create(agent: DshAgent, request: { objective: string; maxGoalRounds?: number }): DshGoalView
  edit(agent: DshAgent, ref: { id: string; revision: number }, request: { objective?: string }): DshGoalView
  pause(agent: DshAgent, ref: { id: string; revision: number }): DshGoalView
  resume(agent: DshAgent, ref: { id: string; revision: number }): DshGoalView
  clear(agent: DshAgent, ref: { id: string; revision: number }): { id: string; revision: number }
}

export interface DshCommands {
  execute(agent: DshAgent, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<{
    commandId: string
    result: { kind: 'success'; text?: string } | { kind: 'error'; text: string }
  } | undefined>
}

// --- jobs ---------------------------------------------------------------------

export interface DshJobView {
  id: string
  kind: string
  label: string
  owner?: string
  status: string
  output: { total: number; earliest: number }
}

export interface DshJobs {
  get(id: string, caller?: string): DshJobView
  readAt(id: string, from: number, caller?: string): { chunks: readonly { at: number; text: string }[]; next: number; lossy: boolean }
  /** Caller-owned and unowned jobs in registration order. */
  list(caller?: string): DshJobView[]
  /** Request cancellation; `already-finished` for settled work. */
  kill(id: string, caller?: string, reason?: string): 'requested' | 'already-finished'
}

// --- schedules (packages/schedule/schedule/src/{index,types}.ts) -------------------

export type DshScheduleRecord =
  | { id: string; kind: 'after'; title: string; prompt: string; afterSeconds: number; scheduledAt: string }
  | { id: string; kind: 'at'; title: string; prompt: string; scheduledAt: string }
  | { id: string; kind: 'every'; title: string; prompt: string; everySeconds: number; scheduledAt: string }
  | { id: string; kind: 'daily'; title: string; prompt: string; time: string; timeZone: string; scheduledAt: string }
  | { id: string; kind: 'weekly'; title: string; prompt: string; time: string; timeZone: string; weekdays: number[]; scheduledAt: string }
  | { id: string; kind: 'cron'; title: string; prompt: string; expression: string; timeZone: string; scheduledAt: string }

export type DshScheduleCatalogEntry = DshScheduleRecord & {
  sessionId: string
  status: 'active' | 'inactive'
  lastDelivery?: { scheduledAt: string; deliveredAt: string; messageId: string }
}

export interface DshScheduleCreateRequest {
  prompt: string
  title: string
  after_seconds?: number
  at?: string
  every_seconds?: number
  daily?: { time: string; time_zone: string }
  weekly?: { time: string; time_zone: string; weekdays: number[] }
  cron?: { expression: string; time_zone: string }
}

export interface DshSchedule {
  create(sessionId: string, request: DshScheduleCreateRequest, signal?: AbortSignal): Promise<DshScheduleRecord>
  catalog(): Promise<DshScheduleCatalogEntry[]>
  delete(request: { sessionId: string; id: string }, signal?: AbortSignal): Promise<{ id: string; deleted: true } | { id: string; deleted: false; code: string }>
}

// --- subprocess (packages/process/subprocess/src/{index,types}.ts) -----------------

export interface DshSubprocessReader {
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
}

export interface DshSubprocessHandle {
  readonly collected: { stdout?: DshSubprocessReader; stderr?: DshSubprocessReader }
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
  terminate(): void
}

export interface DshSubprocess {
  terminalEnvironment(signal?: AbortSignal): Promise<{ platform: 'posix' | 'windows'; defaultShell?: string }>
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number
    signal?: AbortSignal
    env?: Record<string, string | undefined>
  }): DshSubprocessHandle
}

// --- deliverables -------------------------------------------------------------

export interface DshChangedFile {
  path: string
  display: string
  added: number
  deleted: number
  binary?: true
  oversized?: true
}

export interface DshChangesSummary {
  turn: number
  cwd: string
  files: DshChangedFile[]
  total: number
  added: number
  deleted: number
}

export type DshFileDiff =
  | { kind: 'text'; path: string; display: string; before: boolean; after: boolean; hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]; coarse: boolean }
  | { kind: 'binary'; path: string; display: string }
  | { kind: 'oversized'; path: string; display: string }

export interface DshWorkspaceChanges {
  summary(sessionId: string, seq: number): DshChangesSummary | undefined
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<DshFileDiff | undefined>
}

// --- skills -------------------------------------------------------------------

export interface DshSkillEntry {
  path?: string
  name: string
  description: string
}

export interface DshSessionSkillCatalog {
  list(request: { sessionId: string }, signal: AbortSignal): Promise<{ skills: readonly DshSkillEntry[] }>
}

export interface DshSkills {
  list(request: { cwd: string; scope?: unknown }): Promise<readonly (DshSkillEntry & { invocation?: { userInvocable?: boolean } })[]>
}

// --- host context -------------------------------------------------------------

export type Disposer = () => void

/**
 * The Cordis context members the adapter uses beyond `HostContext`
 * (`src/dsh.ts`): event subscription and the activity waterfall. Read
 * defensively; a context without them disables watching.
 */
export interface EventfulContext {
  on?(name: string, listener: (...args: any[]) => unknown, options?: { global?: boolean; prepend?: boolean }): Disposer
  waterfall?(name: string, ...args: unknown[]): Promise<unknown>
}

/** Cordis service keys used by the adapter. */
export const SERVICES = {
  sessionController: 'sessionController',
  workspaceRegistry: 'workspaceRegistry',
  agents: 'agents',
  userQuestions: 'userQuestions',
  goals: 'goals',
  commands: 'commands',
  jobs: 'jobs',
  workspaceChanges: 'workspaceChanges',
  sessionSkillCatalog: 'sessionSkillCatalog',
  skills: 'skills',
  schedule: 'schedule',
  subprocess: 'subprocess',
} as const

export interface DshAgents {
  get(sessionId: string): DshAgent | undefined
}
