/**
 * The plugin core: owns storage, the host key, pairing, the hub link,
 * dispatch, the event queue and the settings the tab edits. `index.ts`
 * creates one per plugin load and disposes it on unload.
 */
import { homedir, hostname } from 'node:os'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import {
  ENDPOINTS, OPERATIONS, PROTOCOL_VERSION, canonicalJson, unpairMessage,
  type UnpairRequest,
  type Grant, type HostEvent, type OperationId, type OwnerCredential, type PermissionLevel, type RequestFrame,
} from '@dsh-remora/protocol'
import type { HostContext } from '../dsh.ts'
import { PLUGIN_VERSION } from '../dsh.ts'
import { detectFeatures, type FeatureReport } from '../features.ts'
import type { Adapter, CreateAdapter } from '../ops/types.ts'
import { AuditLog, type AuditEntry, type AuditInput } from './audit.ts'
import { readCatalog, type Catalog } from './catalog.ts'
import { HubLink, type LinkStatus, type SocketLike } from './connection.ts'
import { Dispatcher } from './dispatch.ts'
import { EventQueue, systemClock, type Clock } from './events.ts'
import { HostKeyStore, type CredentialsLike, type HostKey } from './hostkey.ts'
import { InstanceLock } from './lock.ts'
import { PairingClient, type ApprovedPairing, type FetchLike, type PairingView } from './pairing.ts'
import { ceilingAllows, fullAccessActive, wideningReasons } from './permissions.ts'
import { RpcError } from './rpc-error.ts'
import { PlacementError, SettingsScopePolicy, newPlacement, validatePlacement, type ForbiddenRoots } from './scope.ts'
import {
  ALL_OPERATION_IDS, FULL_ACCESS_TTL_MS, MAX_REMOTE_ANSWER_WAIT_MS, adoptNewOperations, confirmationsSpec, pairingSpec, settingsSpec, tasksSpec,
  type ConfirmationsDocument, type PairingState, type RemoraSettings, type ScopeSettings, type SessionException,
} from './settings.ts'
import { JsonDocument, remoraDataDir, resolveDshHome } from './storage.ts'
import { FileWorkspaceCreationStore, workspaceCreationsSpec } from './workspace-creations.ts'
import { FileTaskStore } from './tasks.ts'
import { readQuestionModes, switchToTimed, type QuestionModeReport } from './question-mode.ts'
import { checkForUpdate, downloadVerified, type UpdateCheck } from './updates.ts'

type GetFetch = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>

export interface RemoraOptions {
  dataDir?: string
  createAdapter: CreateAdapter
  createSocket?: (url: string) => SocketLike
  /** Hub requests during pairing. */
  fetch?: FetchLike
  /** GitHub Releases requests (update check and download). */
  githubFetch?: GetFetch
  clock?: Clock
  forbiddenRoots?: ForbiddenRoots
  /** Retry interval while another process holds the hub lock. */
  lockRetryMs?: number
}

export interface OperationRow {
  id: OperationId
  level: PermissionLevel
  scope: string
  phase: string
  destructive: boolean
  /** Allowed by the DSH ceiling right now. */
  allowed: boolean
  /** Implemented by this plugin build and supported by this DSH. */
  available: boolean
}

export interface ClientSummary {
  clientId: string
  clientName: string
  lastAt: number
  requests: number
  denied: number
}

export interface RemoraSnapshot {
  version: string
  protocol: number
  dshVersion: string | null
  /** Whether this browser request came from this PC (raising permissions needs it). */
  local: boolean
  now: number
  ready: boolean
  /** Set when storage could not be opened; nothing else works then. */
  fatal: string | null
  hub: {
    url: string | null
    paired: boolean
    hostId: string | null
    hubOrigin: string | null
    rpId: string | null
    pairedAt: number | null
    ownerCredentials: number
    revoked: boolean
    link: LinkStatus
    /** `held`: this process owns the hub connection. `other`: another DSH process with the same data folder does. */
    lock: 'held' | 'other' | 'none'
  }
  pairing: PairingView
  /** Result of the last unpair in this process: whether the hub also forgot the host. */
  lastUnpair: { at: number; hub: 'removed' | 'refused' | 'unreachable' | 'not-paired' } | null
  pendingCredentials: { receivedAt: number; added: string[]; removed: string[]; total: number } | null
  keyStorage: 'credentials' | 'file'
  dataDir: string
  settings: RemoraSettings
  fullAccess: { active: boolean; expiresAt: number | null }
  invalidPlacements: string[]
  operations: OperationRow[]
  features: FeatureReport
  proxy: { configured: boolean; envProxy: boolean }
  auditIntact: boolean
  update: UpdateCheck | null
  canInstallUpdate: boolean
  /** `ask_user_question` mode per agent preset: only `timed` questions can be answered remotely. */
  questionModes: QuestionModeReport
}

const ALIAS_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const HOST_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
const COMMAND_PATTERN = /^\/[a-z0-9][a-z0-9-]*$/

function dshVersion(): string | null {
  try {
    const require = createRequire(import.meta.url)
    const manifest = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

function credentialSet(list: readonly OwnerCredential[]): string {
  return canonicalJson([...list].sort((a, b) => (a.credentialId < b.credentialId ? -1 : 1)))
}

export class RemoraCore {
  private readonly ctx: HostContext
  private readonly options: RemoraOptions
  private readonly clock: Clock
  readonly dataDir: string
  private settingsDoc!: JsonDocument<RemoraSettings>
  private pairingDoc!: JsonDocument<PairingState>
  private confirmationsDoc!: JsonDocument<ConfirmationsDocument>
  private auditLog!: AuditLog
  private keyStore!: HostKeyStore
  private hostKey: HostKey | null = null
  private scope!: SettingsScopePolicy
  private tasks!: FileTaskStore
  private workspaceCreations!: FileWorkspaceCreationStore
  private events!: EventQueue
  private dispatcher!: Dispatcher
  private link!: HubLink
  private pairing!: PairingClient
  private lock!: InstanceLock
  private adapter: Adapter | null = null
  private adapterStarted = false
  private lockState: 'held' | 'other' | 'none' = 'none'
  private lockTimer: unknown = null
  private expiryTimer: unknown = null
  private updateCheck: UpdateCheck | null = null
  private lastUnpair: { at: number; hub: 'removed' | 'refused' | 'unreachable' | 'not-paired' } | null = null
  private fatal: string | null = null
  private disposed = false
  private readonly dshVersion = dshVersion()
  readonly ready: Promise<void>

  constructor(ctx: HostContext, options: RemoraOptions) {
    this.ctx = ctx
    this.options = options
    this.clock = options.clock ?? systemClock
    const homePath = ctx.get('dshHomePath')
    this.dataDir = options.dataDir ?? remoraDataDir(typeof homePath === 'function' ? homePath as (...segments: string[]) => string : undefined)
    this.ready = this.init().catch(error => {
      this.fatal = (error as Error).message
      ctx.logger.warn('Remora: could not start', error)
    })
  }

  // --- lifecycle --------------------------------------------------------------

  private async init(): Promise<void> {
    const dir = this.dataDir
    const defaultName = hostname().slice(0, 100) || 'DSH'
    this.settingsDoc = await JsonDocument.open(dir, settingsSpec(defaultName))
    this.pairingDoc = await JsonDocument.open(dir, pairingSpec)
    this.confirmationsDoc = await JsonDocument.open(dir, confirmationsSpec)
    const tasksDoc = await JsonDocument.open(dir, tasksSpec)
    const creationsDoc = await JsonDocument.open(dir, workspaceCreationsSpec)
    this.auditLog = await AuditLog.open(dir, { now: () => this.clock.now() })
    const adopted = adoptNewOperations(this.settingsDoc.value)
    if (adopted !== this.settingsDoc.value) await this.settingsDoc.update(() => adopted)
    const credentials = this.ctx.get('credentials') as CredentialsLike | undefined
    this.keyStore = new HostKeyStore(dir, credentials && typeof credentials.readRecord === 'function' ? credentials : undefined)
    if (this.pairingDoc.value.paired) {
      try {
        this.hostKey = await this.keyStore.load()
      } catch (error) {
        this.ctx.logger.warn('Remora: could not read the host key', error)
      }
      if (this.hostKey && this.hostKey.publicKey !== this.pairingDoc.value.paired.publicKey) {
        this.ctx.logger.warn('Remora: the stored host key does not match the pairing; pair again')
        this.hostKey = null
      }
    }
    this.scope = new SettingsScopePolicy({
      settings: () => this.settingsDoc.value,
      markUntrusted: async workspaceId => {
        await this.settingsDoc.update(current => current.scope.untrustedWorkspaces.includes(workspaceId)
          ? current
          : { ...current, scope: { ...current.scope, untrustedWorkspaces: [...current.scope.untrustedWorkspaces, workspaceId] } })
      },
      now: () => this.clock.now(),
    })
    await this.scope.revalidatePlacements(this.roots())
    this.tasks = new FileTaskStore(tasksDoc, () => this.clock.now())
    this.workspaceCreations = new FileWorkspaceCreationStore(creationsDoc, () => this.clock.now())
    this.link = new HubLink({
      paired: () => this.pairingDoc.value.paired,
      key: () => this.hostKey,
      hello: () => {
        const settings = this.settingsDoc.value
        return { name: settings.hostName, plugin: { version: PLUGIN_VERSION }, dsh: { version: this.dshVersion }, operations: this.operationIds(), ceiling: settings.ceiling, killSwitch: settings.killSwitch }
      },
      onReady: () => this.onLinkReady(),
      onRequest: frame => { void this.onRequest(frame) },
      onOwnerCredentials: list => { void this.onOwnerCredentials(list) },
      onFatal: reason => { void this.onFatal(reason) },
      ...(this.options.createSocket ? { createSocket: this.options.createSocket } : {}),
      clock: this.clock,
      log: message => this.ctx.logger.warn(message),
    })
    this.events = new EventQueue(events => this.link.send({ t: 'event', events }), this.clock)
    this.dispatcher = new Dispatcher({
      handlers: () => this.adapter?.handlers ?? {},
      ceiling: () => this.settingsDoc.value.ceiling,
      killSwitch: () => this.settingsDoc.value.killSwitch,
      allowsWithoutConfirmation: op => op === 'approval.respond' && this.settingsDoc.value.approvalsFromRemote,
      pinned: () => this.pairingDoc.value.paired,
      confirmations: {
        isUsed: id => Object.hasOwn(this.confirmationsDoc.value.used, id),
        markUsed: async (id, until) => {
          const now = this.clock.now()
          await this.confirmationsDoc.update(current => {
            const used: Record<string, number> = {}
            for (const [key, expires] of Object.entries(current.used)) if (expires > now) used[key] = expires
            used[id] = until
            return { used }
          })
        },
      },
      audit: entry => this.audit(entry),
      respond: frame => { this.link.send(frame) },
      now: () => this.clock.now(),
      log: (message, error) => this.ctx.logger.warn(message, error),
    })
    this.pairing = new PairingClient({
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      now: () => this.clock.now(),
      onApproved: (approved, key) => this.onPaired(approved, key),
    })
    this.lock = new InstanceLock(dir)
    this.adapter = this.options.createAdapter(this.ctx, {
      scope: this.scope,
      tasks: this.tasks,
      workspaceCreations: this.workspaceCreations,
      answers: {
        waitMs: () => this.settingsDoc.value.remoteAnswerWaitMs,
        approvalsFromRemote: () => this.settingsDoc.value.approvalsFromRemote,
        allows: op => !this.settingsDoc.value.killSwitch && ceilingAllows(this.settingsDoc.value.ceiling, this.clock.now()).has(op),
        linked: () => this.link.connected,
      },
      emit: event => this.emit(event),
      logger: this.ctx.logger,
    })
    this.scheduleExpiry()
    if (this.disposed) return
    await this.startLink()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.ready
    if (this.fatal !== null && !this.link) return
    this.clock.clearTimeout(this.lockTimer)
    this.clock.clearTimeout(this.expiryTimer)
    this.pairing?.cancel('idle')
    this.dispatcher?.abortAll('unloading')
    this.link?.stop('idle')
    this.events?.dispose()
    try { this.adapter?.dispose() } catch (error) { this.ctx.logger.warn('Remora: adapter dispose failed', error) }
    await this.lock?.release()
  }

  private roots(): ForbiddenRoots {
    if (this.options.forbiddenRoots) return this.options.forbiddenRoots
    const homePath = this.ctx.get('dshHomePath')
    const dshHome = typeof homePath === 'function' ? (homePath as () => string)() : resolveDshHome()
    return { home: homedir(), dshHome }
  }

  // --- hub link -----------------------------------------------------------------

  private canConnect(): boolean {
    return !this.disposed && this.pairingDoc.value.paired !== null && this.hostKey !== null && !this.settingsDoc.value.killSwitch && !this.pairingDoc.value.revoked
  }

  private async startLink(): Promise<void> {
    if (!this.canConnect()) return
    if (!(await this.lock.acquire())) {
      this.lockState = 'other'
      this.clock.clearTimeout(this.lockTimer)
      this.lockTimer = this.clock.setTimeout(() => { void this.startLink() }, this.options.lockRetryMs ?? 60_000)
      return
    }
    this.lockState = 'held'
    if (this.disposed || !this.canConnect()) return
    this.link.start()
  }

  private async stopLink(state: 'idle' | 'stopped', error: string | null): Promise<void> {
    this.clock.clearTimeout(this.lockTimer)
    this.dispatcher.abortAll('link stopped')
    this.link.stop(state, error)
    await this.lock.release()
    this.lockState = 'none'
  }

  private onLinkReady(): void {
    this.audit({ kind: 'connection', action: 'connected', outcome: 'ok' })
    if (!this.adapterStarted && this.adapter) {
      this.adapterStarted = true
      try { this.adapter.start() } catch (error) { this.ctx.logger.warn('Remora: adapter start failed', error) }
    }
    this.events.flush()
  }

  private async onRequest(frame: RequestFrame): Promise<void> {
    await this.dispatcher.handle(frame)
  }

  private async onOwnerCredentials(list: OwnerCredential[]): Promise<void> {
    const paired = this.pairingDoc.value.paired
    if (!paired) return
    const same = credentialSet(list) === credentialSet(paired.owner)
    const pending = this.pairingDoc.value.pendingCredentials
    if (same) {
      if (pending) await this.pairingDoc.update(current => ({ ...current, pendingCredentials: null }))
      return
    }
    if (pending && credentialSet(pending.credentials) === credentialSet(list)) return
    await this.pairingDoc.update(current => ({ ...current, pendingCredentials: { credentials: list, receivedAt: this.clock.now() } }))
    this.audit({ kind: 'connection', action: 'owner-credentials-changed', outcome: 'ok' })
  }

  private async onFatal(reason: string): Promise<void> {
    this.audit({ kind: 'connection', action: reason, outcome: 'error' })
    if (reason === 'revoked') await this.pairingDoc.update(current => ({ ...current, revoked: true }))
    await this.lock.release()
    this.lockState = 'none'
  }

  private emit(event: HostEvent): void {
    this.events?.emit(event)
  }

  private sendHostStatus(): void {
    const settings = this.settingsDoc.value
    this.emit({ kind: 'host-status', ceiling: settings.ceiling, killSwitch: settings.killSwitch, operations: this.operationIds() })
  }

  // --- pairing ------------------------------------------------------------------

  private async onPaired(approved: ApprovedPairing, key: HostKey): Promise<void> {
    await this.stopLink('idle', null)
    this.lastUnpair = null
    await this.keyStore.save(key)
    this.hostKey = key
    await this.pairingDoc.update(() => ({
      paired: { ...approved, publicKey: key.publicKey, pairedAt: this.clock.now() },
      pendingCredentials: null,
      revoked: false,
    }))
    await this.settingsDoc.update(current => ({ ...current, hubUrl: approved.hubOrigin }))
    this.audit({ kind: 'settings', action: 'paired', outcome: 'ok', local: true })
    await this.startLink()
  }

  async startPairing(hubUrl: string, local: boolean): Promise<PairingView> {
    this.requireLocal(local, ['pairing'])
    const name = this.settingsDoc.value.hostName
    const view = await this.pairing.start(hubUrl, name, PLUGIN_VERSION)
    if (view.hubOrigin) await this.settingsDoc.update(current => ({ ...current, hubUrl: view.hubOrigin ?? current.hubUrl }))
    return view
  }

  cancelPairing(): void {
    this.pairing.cancel('cancelled')
  }

  /** Forget the pairing and the key. The host should also be removed on the hub. */
  async unpair(local: boolean): Promise<void> {
    this.pairing.reset()
    this.lastUnpair = { at: this.clock.now(), hub: await this.unpairAtHub() }
    await this.stopLink('idle', null)
    await this.keyStore.delete()
    this.hostKey = null
    this.adapterStarted = false
    await this.pairingDoc.reset()
    this.audit({ kind: 'settings', action: 'unpaired', outcome: this.lastUnpair.hub === 'removed' ? 'ok' : 'error', reason: `hub:${this.lastUnpair.hub}`, local })
  }

  /**
   * Ask the hub to forget this host (`POST /pair/unpair`, signed with the
   * host key). Local state is cleared whatever the answer; a failure only
   * means the user must also remove the host on the hub.
   */
  private async unpairAtHub(): Promise<'removed' | 'refused' | 'unreachable' | 'not-paired'> {
    const paired = this.pairingDoc.value.paired
    const key = this.hostKey
    if (!paired || !key) return 'not-paired'
    const issuedAt = this.clock.now()
    const body: UnpairRequest = { hostId: paired.hostId, issuedAt, signature: key.sign(unpairMessage(paired.hubOrigin, paired.hostId, issuedAt)) }
    const fetchImpl: FetchLike = this.options.fetch ?? ((input, init) => fetch(input, init))
    try {
      const response = await fetchImpl(`${paired.hubOrigin}${ENDPOINTS.hostUnpair}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
      return response.ok ? 'removed' : 'refused'
    } catch {
      return 'unreachable'
    }
  }

  async resolveCredentialChange(accept: boolean, local: boolean): Promise<void> {
    const pending = this.pairingDoc.value.pendingCredentials
    if (!pending) throw new RpcError('nothing-pending')
    if (accept) {
      this.requireLocal(local, ['owner-credentials'])
      await this.pairingDoc.update(current => current.paired
        ? { ...current, paired: { ...current.paired, owner: pending.credentials }, pendingCredentials: null }
        : current)
    } else {
      await this.pairingDoc.update(current => ({ ...current, pendingCredentials: null }))
    }
    this.audit({ kind: 'settings', action: accept ? 'owner-credentials-accepted' : 'owner-credentials-rejected', outcome: 'ok', local })
  }

  /** Switch every legacy preset to timed questions so they can be answered from outside. */
  async switchQuestionMode(local: boolean): Promise<string[]> {
    this.requireLocal(local, ['question-mode'])
    let changed: string[]
    try {
      changed = await switchToTimed(service => this.ctx.get(service))
    } catch (error) {
      this.audit({ kind: 'settings', action: 'question-mode:timed', outcome: 'error', local })
      throw new RpcError('question-mode-failed', (error as Error).message.slice(0, 300))
    }
    this.audit({ kind: 'settings', action: 'question-mode:timed', outcome: 'ok', local })
    return changed
  }

  reconnect(): void {
    if (this.link.status.state === 'idle' || this.link.status.state === 'stopped') void this.startLink()
    else this.link.reconnect()
  }

  // --- settings -----------------------------------------------------------------

  private requireLocal(local: boolean, reasons: string[]): void {
    if (!local && reasons.length > 0) throw new RpcError('local-only', reasons.join(','))
  }

  private async saveSettings(next: RemoraSettings, local: boolean, action: string): Promise<RemoraSettings> {
    const previous = this.settingsDoc.value
    this.requireLocal(local, wideningReasons(previous, next, this.clock.now()))
    const saved = await this.settingsDoc.update(() => next)
    this.audit({ kind: 'settings', action, outcome: 'ok', local })
    if (canonicalJson(previous.ceiling) !== canonicalJson(saved.ceiling) || previous.killSwitch !== saved.killSwitch) this.sendHostStatus()
    this.scheduleExpiry()
    if (previous.hostName !== saved.hostName && this.link.connected) this.link.reconnect()
    this.settingsChanged()
    return saved
  }

  private settingsChanged(): void {
    try { this.adapter?.settingsChanged?.() } catch (error) { this.ctx.logger.warn('Remora: adapter settings update failed', error) }
  }

  async setPermission(input: { level: PermissionLevel; overrides?: Partial<Record<OperationId, boolean>>; confirmFull?: boolean }, local: boolean): Promise<void> {
    const previous = this.settingsDoc.value
    const now = this.clock.now()
    const ceiling: Grant = { level: input.level }
    if (input.overrides) {
      const overrides: Partial<Record<OperationId, boolean>> = {}
      for (const [id, flag] of Object.entries(input.overrides)) {
        if (ALL_OPERATION_IDS.includes(id as OperationId) && typeof flag === 'boolean') overrides[id as OperationId] = flag
      }
      if (Object.keys(overrides).length > 0) ceiling.overrides = overrides
    }
    if (input.level === 'full') {
      if (fullAccessActive(previous.ceiling, now) && previous.ceiling.fullAccessExpiresAt !== undefined) {
        ceiling.fullAccessExpiresAt = previous.ceiling.fullAccessExpiresAt
      } else {
        if (input.confirmFull !== true) throw new RpcError('full-confirmation-required')
        ceiling.fullAccessExpiresAt = now + FULL_ACCESS_TTL_MS
      }
    }
    await this.saveSettings({ ...previous, ceiling, knownOperations: [...ALL_OPERATION_IDS] }, local, `permission:${input.level}${ceiling.overrides ? '+custom' : ''}`)
  }

  async extendFullAccess(local: boolean): Promise<void> {
    const previous = this.settingsDoc.value
    if (!fullAccessActive(previous.ceiling, this.clock.now())) throw new RpcError('full-access-inactive')
    await this.saveSettings({ ...previous, ceiling: { ...previous.ceiling, fullAccessExpiresAt: this.clock.now() + FULL_ACCESS_TTL_MS } }, local, 'full-access-extended')
  }

  async setKillSwitch(on: boolean, local: boolean): Promise<void> {
    const previous = this.settingsDoc.value
    if (previous.killSwitch === on) return
    if (on) {
      this.dispatcher.abortAll('kill switch')
      await this.saveSettings({ ...previous, killSwitch: true }, local, 'kill-switch:on')
      this.events.flush()
      await this.stopLink('stopped', 'kill-switch')
    } else {
      await this.saveSettings({ ...previous, killSwitch: false }, local, 'kill-switch:off')
      await this.startLink()
    }
  }

  /** Apply edits to the host name and scope lists. Placements have their own methods. */
  async updateSettings(patch: unknown, local: boolean): Promise<void> {
    if (typeof patch !== 'object' || patch === null) throw new RpcError('invalid-payload')
    const input = patch as { hostName?: unknown; scope?: Record<string, unknown> }
    const previous = this.settingsDoc.value
    const next: RemoraSettings = { ...previous, scope: { ...previous.scope } }
    if (input.hostName !== undefined) {
      if (typeof input.hostName !== 'string' || input.hostName.trim() === '' || input.hostName.length > 100) throw new RpcError('invalid-payload', 'hostName')
      next.hostName = input.hostName.trim()
    }
    const scope = input.scope
    if (scope !== undefined) {
      if (typeof scope !== 'object' || scope === null) throw new RpcError('invalid-payload', 'scope')
      const list = (key: keyof ScopeSettings, check: (item: string) => boolean, map: (item: string) => string = item => item) => {
        const value = scope[key]
        if (value === undefined) return
        if (!Array.isArray(value) || value.length > 500 || !value.every(item => typeof item === 'string' && check(map(item)))) throw new RpcError('invalid-payload', key)
        ;(next.scope as unknown as Record<string, unknown>)[key] = [...new Set(value.map(item => map(item as string)))]
      }
      const id = (item: string) => item.length > 0 && item.length <= 200
      list('workspaces', id)
      list('skills', item => /^[A-Za-z0-9._:-]{1,100}$/.test(item))
      list('agentPresets', id)
      list('commands', item => COMMAND_PATTERN.test(item), item => (item.startsWith('/') ? item : `/${item}`).toLowerCase())
      list('gitHosts', item => HOST_PATTERN.test(item), item => item.trim().toLowerCase())
      list('untrustedWorkspaces', id)
      if (scope.outsideWorkspace !== undefined) {
        if (typeof scope.outsideWorkspace !== 'boolean') throw new RpcError('invalid-payload', 'outsideWorkspace')
        next.scope.outsideWorkspace = scope.outsideWorkspace
      }
      if (scope.exceptions !== undefined) {
        if (!Array.isArray(scope.exceptions) || scope.exceptions.length > 500) throw new RpcError('invalid-payload', 'exceptions')
        const exceptions: SessionException[] = []
        for (const item of scope.exceptions as unknown[]) {
          const entry = item as { sessionId?: unknown; allow?: unknown }
          if (typeof entry?.sessionId !== 'string' || !id(entry.sessionId) || typeof entry.allow !== 'boolean') throw new RpcError('invalid-payload', 'exceptions')
          if (!exceptions.some(e => e.sessionId === entry.sessionId)) exceptions.push({ sessionId: entry.sessionId, allow: entry.allow })
        }
        next.scope.exceptions = exceptions
      }
      if (scope.aliases !== undefined) {
        if (typeof scope.aliases !== 'object' || scope.aliases === null || Array.isArray(scope.aliases)) throw new RpcError('invalid-payload', 'aliases')
        const aliases: Record<string, string> = {}
        for (const [alias, sessionId] of Object.entries(scope.aliases as Record<string, unknown>)) {
          if (!ALIAS_PATTERN.test(alias) || typeof sessionId !== 'string' || !id(sessionId)) throw new RpcError('invalid-payload', 'aliases')
          aliases[alias] = sessionId
        }
        next.scope.aliases = aliases
      }
    }
    await this.saveSettings(next, local, 'settings')
  }

  /**
   * Answers from outside: how long Remora holds questions, plan reviews and
   * approvals (minutes, 0 = off), and whether approvals may be answered from
   * MCP and CLI without the owner's passkey. Turning either on needs this PC.
   */
  async setAnswers(patch: unknown, local: boolean): Promise<void> {
    if (typeof patch !== 'object' || patch === null) throw new RpcError('invalid-payload')
    const input = patch as { waitMinutes?: unknown; approvalsFromRemote?: unknown }
    const previous = this.settingsDoc.value
    const next: RemoraSettings = { ...previous }
    const actions: string[] = []
    if (input.waitMinutes !== undefined) {
      const minutes = input.waitMinutes
      if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes * 60_000 > MAX_REMOTE_ANSWER_WAIT_MS) throw new RpcError('invalid-payload', 'waitMinutes')
      next.remoteAnswerWaitMs = minutes * 60_000
      if (next.remoteAnswerWaitMs !== previous.remoteAnswerWaitMs) actions.push(`answer-wait:${minutes}m`)
    }
    if (input.approvalsFromRemote !== undefined) {
      if (typeof input.approvalsFromRemote !== 'boolean') throw new RpcError('invalid-payload', 'approvalsFromRemote')
      next.approvalsFromRemote = input.approvalsFromRemote
      if (next.approvalsFromRemote !== previous.approvalsFromRemote) actions.push(`approvals-from-remote:${next.approvalsFromRemote ? 'on' : 'off'}`)
    }
    if (actions.length === 0) return
    await this.saveSettings(next, local, actions.join(','))
  }

  async addPlacement(path: unknown, local: boolean): Promise<void> {
    if (typeof path !== 'string' || path.length > 4096) throw new RpcError('invalid-payload', 'path')
    let real: string
    try {
      real = await validatePlacement(path, this.roots())
    } catch (error) {
      if (error instanceof PlacementError) throw new RpcError(`placement-${error.code}`)
      throw error
    }
    const previous = this.settingsDoc.value
    if (previous.scope.placements.some(p => p.path === real)) return
    await this.saveSettings({ ...previous, scope: { ...previous.scope, placements: [...previous.scope.placements, newPlacement(real, this.clock.now())] } }, local, 'placement-added')
    await this.scope.revalidatePlacements(this.roots())
  }

  async removePlacement(placementId: unknown, local: boolean): Promise<void> {
    if (typeof placementId !== 'string') throw new RpcError('invalid-payload', 'placementId')
    const previous = this.settingsDoc.value
    await this.saveSettings({ ...previous, scope: { ...previous.scope, placements: previous.scope.placements.filter(p => p.placementId !== placementId) } }, local, 'placement-removed')
  }

  /** Full access lapses into 依頼できる after its expiry. */
  private scheduleExpiry(): void {
    this.clock.clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    const ceiling = this.settingsDoc.value.ceiling
    if (ceiling.level !== 'full' || ceiling.fullAccessExpiresAt === undefined) return
    const delay = Math.max(0, ceiling.fullAccessExpiresAt - this.clock.now())
    this.expiryTimer = this.clock.setTimeout(() => { void this.expireFullAccess() }, Math.min(delay, 2 ** 31 - 1))
  }

  private async expireFullAccess(): Promise<void> {
    const current = this.settingsDoc.value
    if (current.ceiling.level !== 'full' || current.ceiling.fullAccessExpiresAt === undefined) return
    if (current.ceiling.fullAccessExpiresAt > this.clock.now()) { this.scheduleExpiry(); return }
    const { fullAccessExpiresAt: _expired, ...rest } = current.ceiling
    await this.settingsDoc.update(value => ({ ...value, ceiling: { ...rest, level: 'request' } }))
    this.audit({ kind: 'settings', action: 'full-access-expired', outcome: 'ok' })
    this.sendHostStatus()
    this.settingsChanged()
  }

  // --- reads ----------------------------------------------------------------------

  private operationIds(): string[] {
    return this.features().available.filter(id => id !== 'status' && id !== 'hosts.list')
  }

  private features(): FeatureReport {
    const adapter = this.adapter
    if (!adapter) return { available: [], missing: [] }
    return detectFeatures(service => adapter.has(service), new Set(Object.keys(adapter.handlers) as OperationId[]))
  }

  private audit(entry: AuditInput): void {
    if (!this.auditLog) return
    this.auditLog.append(entry).catch(error => this.ctx.logger.warn('Remora: audit write failed', error))
  }

  auditEntries(limit = 200): AuditEntry[] {
    return this.auditLog ? this.auditLog.entries().slice(-limit).reverse() : []
  }

  clients(): ClientSummary[] {
    const map = new Map<string, ClientSummary>()
    for (const entry of this.auditLog?.entries() ?? []) {
      if (entry.kind !== 'request' || !entry.clientId) continue
      const row = map.get(entry.clientId) ?? { clientId: entry.clientId, clientName: entry.clientName ?? entry.clientId, lastAt: 0, requests: 0, denied: 0 }
      row.requests++
      if (entry.outcome === 'denied') row.denied++
      if (entry.at >= row.lastAt) { row.lastAt = entry.at; row.clientName = entry.clientName ?? row.clientName }
      map.set(entry.clientId, row)
    }
    return [...map.values()].sort((a, b) => b.lastAt - a.lastAt)
  }

  catalog(): Promise<Catalog> {
    return readCatalog(service => this.ctx.get(service))
  }

  async checkUpdate(force: boolean): Promise<UpdateCheck> {
    const now = this.clock.now()
    if (!force && this.updateCheck && now - this.updateCheck.checkedAt < 60 * 60_000) return this.updateCheck
    this.updateCheck = await checkForUpdate(PLUGIN_VERSION, this.httpFetch(), now)
    return this.updateCheck
  }

  /** The fetch used for GitHub requests (tests inject one). */
  private httpFetch(): GetFetch {
    return this.options.githubFetch ?? ((input, init) => fetch(input, init))
  }

  private pluginManager(): { installBundle(spec: string): Promise<unknown> } | null {
    const manager = this.ctx.get('pluginManager') as { installBundle?: unknown } | undefined
    return manager && typeof manager.installBundle === 'function' ? manager as { installBundle(spec: string): Promise<unknown> } : null
  }

  async installUpdate(local: boolean): Promise<{ path: string }> {
    this.requireLocal(local, ['plugin-update'])
    const check = this.updateCheck
    if (!check?.latest || !check.newer) throw new RpcError('no-update')
    const manager = this.pluginManager()
    if (!manager) throw new RpcError('install-unavailable')
    const path = await downloadVerified(check.latest, this.dataDir, this.httpFetch())
    this.audit({ kind: 'settings', action: `update:${check.latest.version}`, outcome: 'ok', local })
    // DSH reloads the plugin after installing; this instance is disposed during or after the call.
    void manager.installBundle(path).catch(error => this.ctx.logger.warn('Remora: plugin update failed', error))
    return { path }
  }

  snapshot(local: boolean): RemoraSnapshot {
    const now = this.clock.now()
    const env = process.env
    const proxy = { configured: Boolean(env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy), envProxy: env.NODE_USE_ENV_PROXY === '1' }
    if (this.fatal !== null && !this.settingsDoc) {
      throw new RpcError('storage-failed', this.fatal)
    }
    const settings = this.settingsDoc.value
    const pairing = this.pairingDoc.value
    const allowed = ceilingAllows(settings.ceiling, now)
    const available = new Set(this.features().available)
    const pending = pairing.pendingCredentials
    const pinnedIds = pairing.paired?.owner.map(c => c.credentialId) ?? []
    return {
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      dshVersion: this.dshVersion,
      local,
      now,
      ready: true,
      fatal: this.fatal,
      hub: {
        url: settings.hubUrl,
        paired: pairing.paired !== null && this.hostKey !== null,
        hostId: pairing.paired?.hostId ?? null,
        hubOrigin: pairing.paired?.hubOrigin ?? null,
        rpId: pairing.paired?.rpId ?? null,
        pairedAt: pairing.paired?.pairedAt ?? null,
        ownerCredentials: pairing.paired?.owner.length ?? 0,
        revoked: pairing.revoked,
        link: this.link.status,
        lock: this.lockState,
      },
      pairing: this.pairing.view,
      lastUnpair: this.lastUnpair,
      pendingCredentials: pending ? {
        receivedAt: pending.receivedAt,
        added: pending.credentials.map(c => c.credentialId).filter(id => !pinnedIds.includes(id)),
        removed: pinnedIds.filter(id => !pending.credentials.some(c => c.credentialId === id)),
        total: pending.credentials.length,
      } : null,
      keyStorage: this.keyStore.location,
      dataDir: this.dataDir,
      settings,
      fullAccess: { active: fullAccessActive(settings.ceiling, now), expiresAt: settings.ceiling.fullAccessExpiresAt ?? null },
      invalidPlacements: settings.scope.placements.filter(p => !this.scope.isPlacementValid(p.placementId)).map(p => p.placementId),
      operations: OPERATIONS.map(op => ({
        id: op.id, level: op.level, scope: op.scope, phase: op.phase, destructive: op.destructive,
        allowed: allowed.has(op.id), available: available.has(op.id),
      })),
      features: this.features(),
      proxy,
      auditIntact: this.auditLog.intact,
      update: this.updateCheck,
      canInstallUpdate: this.pluginManager() !== null,
      questionModes: readQuestionModes(service => this.ctx.get(service)),
    }
  }

  // --- for tests ------------------------------------------------------------------

  /** @internal */
  get internals() {
    return { link: this.link, events: this.events, dispatcher: this.dispatcher, tasks: this.tasks, scope: this.scope, settings: () => this.settingsDoc.value, pairing: () => this.pairingDoc.value }
  }
}
