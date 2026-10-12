/**
 * Persisted documents: settings (the DSH-side ceiling and scope), pairing
 * state, the task ledger and used confirmation ids. Each has a schema version
 * and a `parse` that rejects malformed content loudly.
 */
import { FORBIDDEN_COMMANDS, OPERATIONS, type Grant, type OperationId, type OwnerCredential, type PermissionLevel, type RemoraError, type TaskState } from '@dsh-remora/protocol'
import type { TaskRecord } from '../ops/types.ts'
import { asObject, optionalNumber, optionalString, stringArray, type DocumentSpec } from './storage.ts'

export const FULL_ACCESS_TTL_MS = 24 * 60 * 60_000

export interface SessionException {
  sessionId: string
  /** true: reachable even if its workspace is not; false: never reachable. */
  allow: boolean
}

export interface Placement {
  placementId: string
  /** realpath at the time it was added. */
  path: string
  addedAt: number
}

export interface ScopeSettings {
  /** Workspace ids reachable from outside. */
  workspaces: string[]
  /** Sessions that belong to no workspace. Off by default. */
  outsideWorkspace: boolean
  exceptions: SessionException[]
  placements: Placement[]
  /** alias -> sessionId */
  aliases: Record<string, string>
  /** Explicit allow-lists. Full remote access does not widen them; forbidden commands are dropped on parse. */
  skills: string[]
  agentPresets: string[]
  /** Slash commands with the leading slash, e.g. `/compact`. */
  commands: string[]
  /** Hosts allowed in `gitUrl`. */
  gitHosts: string[]
  /** Workspaces cloned through Remora; their skills stay off until removed from this list on DSH. */
  untrustedWorkspaces: string[]
}

export interface RemoraSettings {
  hubUrl: string | null
  /** Shown on the hub and in `hello`. */
  hostName: string
  /** The DSH-side ceiling. Only the settings tab changes it. */
  ceiling: Grant
  killSwitch: boolean
  /** Operation ids the user has seen; new ones start switched off unless the ceiling is full. */
  knownOperations: string[]
  scope: ScopeSettings
}

export const ALL_OPERATION_IDS: readonly OperationId[] = OPERATIONS.map(op => op.id)

export function defaultSettings(hostName = 'DSH'): RemoraSettings {
  return {
    hubUrl: null,
    hostName,
    ceiling: { level: 'view' },
    killSwitch: false,
    knownOperations: [...ALL_OPERATION_IDS],
    scope: {
      workspaces: [],
      outsideWorkspace: false,
      exceptions: [],
      placements: [],
      aliases: {},
      skills: [],
      agentPresets: [],
      commands: [],
      gitHosts: [],
      untrustedWorkspaces: [],
    },
  }
}

const LEVELS: readonly PermissionLevel[] = ['view', 'request', 'full']

export function parseGrant(value: unknown, what = 'grant'): Grant {
  const raw = asObject(value, what)
  if (typeof raw.level !== 'string' || !LEVELS.includes(raw.level as PermissionLevel)) throw new Error(`${what}.level is invalid`)
  const grant: Grant = { level: raw.level as PermissionLevel }
  if (raw.overrides !== undefined) {
    const overrides: Partial<Record<OperationId, boolean>> = {}
    for (const [key, flag] of Object.entries(asObject(raw.overrides, `${what}.overrides`))) {
      if (!ALL_OPERATION_IDS.includes(key as OperationId)) continue
      if (typeof flag !== 'boolean') throw new Error(`${what}.overrides.${key} must be a boolean`)
      overrides[key as OperationId] = flag
    }
    if (Object.keys(overrides).length > 0) grant.overrides = overrides
  }
  const expires = optionalNumber(raw.fullAccessExpiresAt, `${what}.fullAccessExpiresAt`)
  if (expires !== null) grant.fullAccessExpiresAt = expires
  return grant
}

function parseScope(value: unknown): ScopeSettings {
  const raw = value === undefined ? {} : asObject(value, 'scope')
  const exceptions = Array.isArray(raw.exceptions) ? raw.exceptions.map((item, index) => {
    const entry = asObject(item, `scope.exceptions[${index}]`)
    if (typeof entry.sessionId !== 'string' || typeof entry.allow !== 'boolean') throw new Error(`scope.exceptions[${index}] is invalid`)
    return { sessionId: entry.sessionId, allow: entry.allow }
  }) : []
  const placements = Array.isArray(raw.placements) ? raw.placements.map((item, index) => {
    const entry = asObject(item, `scope.placements[${index}]`)
    if (typeof entry.placementId !== 'string' || typeof entry.path !== 'string') throw new Error(`scope.placements[${index}] is invalid`)
    return { placementId: entry.placementId, path: entry.path, addedAt: optionalNumber(entry.addedAt, 'addedAt') ?? 0 }
  }) : []
  const aliases: Record<string, string> = {}
  if (raw.aliases !== undefined) {
    for (const [alias, sessionId] of Object.entries(asObject(raw.aliases, 'scope.aliases'))) {
      if (typeof sessionId !== 'string') throw new Error(`scope.aliases.${alias} must be a string`)
      aliases[alias] = sessionId
    }
  }
  return {
    workspaces: stringArray(raw.workspaces, 'scope.workspaces'),
    outsideWorkspace: raw.outsideWorkspace === true,
    exceptions,
    placements,
    aliases,
    skills: stringArray(raw.skills, 'scope.skills'),
    agentPresets: stringArray(raw.agentPresets, 'scope.agentPresets'),
    commands: stringArray(raw.commands, 'scope.commands').map(c => c.toLowerCase()).filter(c => !FORBIDDEN_COMMANDS.has(c.startsWith('/') ? c : `/${c}`)),
    gitHosts: stringArray(raw.gitHosts, 'scope.gitHosts').map(host => host.toLowerCase()),
    untrustedWorkspaces: stringArray(raw.untrustedWorkspaces, 'scope.untrustedWorkspaces'),
  }
}

export function parseSettings(value: unknown): RemoraSettings {
  const raw = asObject(value, 'settings')
  const settings: RemoraSettings = {
    hubUrl: optionalString(raw.hubUrl, 'hubUrl'),
    hostName: typeof raw.hostName === 'string' && raw.hostName.trim() !== '' ? raw.hostName.slice(0, 100) : 'DSH',
    ceiling: parseGrant(raw.ceiling ?? { level: 'view' }, 'ceiling'),
    killSwitch: raw.killSwitch === true,
    knownOperations: stringArray(raw.knownOperations, 'knownOperations'),
    scope: parseScope(raw.scope),
  }
  return settings
}

/**
 * Operations that appeared since the user last saved are switched off,
 * unless the ceiling is full access (which turns everything on). Returns the
 * same object when nothing changed.
 */
export function adoptNewOperations(settings: RemoraSettings): RemoraSettings {
  const unknown = ALL_OPERATION_IDS.filter(id => !settings.knownOperations.includes(id))
  if (unknown.length === 0) return settings
  const overrides = { ...settings.ceiling.overrides }
  if (settings.ceiling.level !== 'full') for (const id of unknown) overrides[id] = false
  const ceiling: Grant = { ...settings.ceiling }
  if (Object.keys(overrides).length > 0) ceiling.overrides = overrides
  return { ...settings, ceiling, knownOperations: [...ALL_OPERATION_IDS] }
}

export function settingsSpec(hostName: string): DocumentSpec<RemoraSettings> {
  return { file: 'settings.json', version: 1, migrations: [], initial: () => defaultSettings(hostName), parse: parseSettings }
}

// Pairing --------------------------------------------------------------------

export interface PairedHub {
  hostId: string
  hubOrigin: string
  rpId: string
  /** Owner passkeys pinned at pairing; confirmations are verified against these only. */
  owner: OwnerCredential[]
  /** base64url raw Ed25519 public key registered with the hub. */
  publicKey: string
  pairedAt: number
}

export interface PendingCredentialChange {
  credentials: OwnerCredential[]
  receivedAt: number
}

export interface PairingState {
  paired: PairedHub | null
  /** A different credential set announced by the hub; applied only after the DSH user confirms. */
  pendingCredentials: PendingCredentialChange | null
  /** Set when the hub closed the connection with `revoked`. */
  revoked: boolean
}

export function parseOwnerCredentials(value: unknown, what: string): OwnerCredential[] {
  if (!Array.isArray(value)) throw new Error(`${what} must be an array`)
  return value.map((item, index) => {
    const entry = asObject(item, `${what}[${index}]`)
    if (typeof entry.credentialId !== 'string' || typeof entry.publicKey !== 'string' || typeof entry.algorithm !== 'number') {
      throw new Error(`${what}[${index}] is invalid`)
    }
    return { credentialId: entry.credentialId, publicKey: entry.publicKey, algorithm: entry.algorithm }
  })
}

export function parsePairing(value: unknown): PairingState {
  const raw = asObject(value, 'pairing')
  let paired: PairedHub | null = null
  if (raw.paired !== null && raw.paired !== undefined) {
    const p = asObject(raw.paired, 'paired')
    for (const key of ['hostId', 'hubOrigin', 'rpId', 'publicKey'] as const) {
      if (typeof p[key] !== 'string' || p[key] === '') throw new Error(`paired.${key} is invalid`)
    }
    paired = {
      hostId: p.hostId as string,
      hubOrigin: p.hubOrigin as string,
      rpId: p.rpId as string,
      publicKey: p.publicKey as string,
      owner: parseOwnerCredentials(p.owner, 'paired.owner'),
      pairedAt: optionalNumber(p.pairedAt, 'paired.pairedAt') ?? 0,
    }
  }
  let pendingCredentials: PendingCredentialChange | null = null
  if (raw.pendingCredentials !== null && raw.pendingCredentials !== undefined) {
    const pending = asObject(raw.pendingCredentials, 'pendingCredentials')
    pendingCredentials = {
      credentials: parseOwnerCredentials(pending.credentials, 'pendingCredentials.credentials'),
      receivedAt: optionalNumber(pending.receivedAt, 'pendingCredentials.receivedAt') ?? 0,
    }
  }
  return { paired, pendingCredentials, revoked: raw.revoked === true }
}

export const pairingSpec: DocumentSpec<PairingState> = {
  file: 'pairing.json',
  version: 1,
  migrations: [],
  initial: () => ({ paired: null, pendingCredentials: null, revoked: false }),
  parse: parsePairing,
}

// Tasks ----------------------------------------------------------------------

const TASK_STATES: readonly TaskState[] = ['accepted', 'running', 'needs_attention', 'completed', 'failed', 'cancelled', 'parked']

function parseTask(value: unknown, index: number): TaskRecord {
  const raw = asObject(value, `tasks[${index}]`)
  for (const key of ['taskId', 'clientId', 'requestId'] as const) {
    if (typeof raw[key] !== 'string') throw new Error(`tasks[${index}].${key} is invalid`)
  }
  if (typeof raw.state !== 'string' || !TASK_STATES.includes(raw.state as TaskState)) throw new Error(`tasks[${index}].state is invalid`)
  const record: TaskRecord = {
    taskId: raw.taskId as string,
    clientId: raw.clientId as string,
    sessionId: optionalString(raw.sessionId, 'sessionId'),
    requestId: raw.requestId as string,
    state: raw.state as TaskState,
    createdAt: optionalNumber(raw.createdAt, 'createdAt') ?? 0,
    updatedAt: optionalNumber(raw.updatedAt, 'updatedAt') ?? 0,
  }
  if (raw.error !== undefined) record.error = raw.error as RemoraError
  return record
}

export interface TasksDocument { tasks: TaskRecord[] }

export const tasksSpec: DocumentSpec<TasksDocument> = {
  file: 'tasks.json',
  version: 1,
  migrations: [],
  initial: () => ({ tasks: [] }),
  parse: value => {
    const raw = asObject(value, 'tasks')
    if (!Array.isArray(raw.tasks)) throw new Error('tasks.tasks must be an array')
    return { tasks: raw.tasks.map(parseTask) }
  },
}

// Used confirmations -----------------------------------------------------------

export interface ConfirmationsDocument {
  /** requestId -> epoch ms after which the entry may be forgotten (the TTL check rejects it anyway). */
  used: Record<string, number>
}

export const confirmationsSpec: DocumentSpec<ConfirmationsDocument> = {
  file: 'confirmations.json',
  version: 1,
  migrations: [],
  initial: () => ({ used: {} }),
  parse: value => {
    const raw = asObject(value, 'confirmations')
    const used: Record<string, number> = {}
    for (const [id, until] of Object.entries(asObject(raw.used ?? {}, 'used'))) {
      if (typeof until === 'number') used[id] = until
    }
    return { used }
  },
}
