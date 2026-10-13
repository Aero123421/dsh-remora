/**
 * The plugin core: owns storage, the host key, pairing, the hub link,
 * dispatch, the event queue and the settings the tab edits. `index.ts`
 * creates one per plugin load and disposes it on unload.
 */
import { homedir, hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { basename, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import {
  ENDPOINTS, OPERATIONS, PROTOCOL_VERSION, canonicalJson, rotateKeyMessage, unpairMessage,
  type UnpairRequest,
  type Grant, type HostEvent, type OperationId, type OwnerCredential, type PermissionLevel, type RequestFrame, type RotateKeyCommitFrame, type RotateKeyFrame,
} from '@dsh-remora/protocol'

/** Operations the hub answers itself, or that are not request frames: never advertised as served operations. */
const NOT_ADVERTISED: ReadonlySet<string> = new Set(['status', 'hosts.list', 'confirmation.get', 'audit.export', 'hub.export', 'host.rotate-key'])

// Native DSH domains are cached per process. Keep this marker across plugin
// reloads; only restarting DSH makes a secondary process's native state fresh.
const STALE_NATIVE_STATE = Symbol.for('dsh-remora:stale-native-state')
const processState = process as typeof process & { [STALE_NATIVE_STATE]?: Set<string> }
const staleNativeDirs = processState[STALE_NATIVE_STATE] ??= new Set<string>()
import type { HostContext } from '../dsh.ts'
import { PLUGIN_VERSION } from '../dsh.ts'
import { detectFeatures, type FeatureReport } from '../features.ts'
import type { Adapter, CreateAdapter } from '../ops/types.ts'
import { AuditLog, type AuditEntry, type AuditInput } from './audit.ts'
import { readCatalog, type Catalog } from './catalog.ts'
import { HubLink, type LinkStatus, type SocketLike } from './connection.ts'
import { Dispatcher } from './dispatch.ts'
import { EventQueue, systemClock, type Clock } from './events.ts'
import { HostKey, HostKeyStore, type CredentialsLike } from './hostkey.ts'
import { InstanceLock, withFileLock } from './lock.ts'
import { PairingClient, type ApprovedPairing, type FetchLike, type PairingView } from './pairing.ts'
import { ceilingAllows, fullAccessActive, wideningReasons } from './permissions.ts'
import { RpcError } from './rpc-error.ts'
import { PlacementError, SettingsScopePolicy, newPlacement, validatePlacement, type ForbiddenRoots } from './scope.ts'
import {
  ALL_OPERATION_IDS, FULL_ACCESS_TTL_MS, MAX_REMOTE_ANSWER_WAIT_MS, adoptNewOperations, confirmationsSpec, pairingSpec, settingsSpec, tasksSpec,
  type ConfirmationsDocument, type PairingState, type RemoraSettings, type SessionException,
} from './settings.ts'
import { JsonDocument, remoraDataDir, resolveDshHome } from './storage.ts'
import { FileWorkspaceCreationStore, workspaceCreationsSpec } from './workspace-creations.ts'
import { FileRemoteScheduleStore, remoteSchedulesSpec } from './remote-schedules.ts'
import { FileTaskStore } from './tasks.ts'
import { readQuestionModes, switchToTimed, type QuestionModeReport } from './question-mode.ts'
import { checkForUpdate, downloadVerified, installationResult, newInstallRequestId, updateReceiptSpec, UpdateError, type UpdateCheck, type UpdateInstallation, type UpdatePluginManager } from './updates.ts'

type GetFetch = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: RequestRedirect }) => Promise<Response>

export interface RemoraOptions {
  dataDir?: string
  createAdapter: CreateAdapter
  createSocket?: (url: string) => SocketLike
  /** Hub requests during pairing. */
  fetch?: FetchLike
  /** GitHub Releases requests (update check and download). */
  githubFetch?: GetFetch
  /** Test hook for the runtime manifest version. */
  dshVersion?: string
  clock?: Clock
  forbiddenRoots?: ForbiddenRoots
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
    lock: 'held' | 'other' | 'restart' | 'none'
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
  /** Scopes transient update attempts to this Host load, including same-version reloads. */
  updateHostInstance: string
  updateInstallation: UpdateInstallation | null
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
  /** During a key rotation: the other key, kept until one of the two got through a handshake. */
  private previousKey: HostKey | null = null
  /** A proved new key waiting for the hub's commit. */
  private pendingRotation: { nonce: string; key: HostKey } | null = null
  /** Handshakes refused since the last swap of the two keys (fast retry only once). */
  private keySwaps = 0
  /** Key store writes, one at a time. */
  private keyWrites: Promise<void> = Promise.resolve()
  private scope!: SettingsScopePolicy
  private tasks!: FileTaskStore
  private workspaceCreations!: FileWorkspaceCreationStore
  private remoteSchedules!: FileRemoteScheduleStore
  private events!: EventQueue
  private dispatcher!: Dispatcher
  private link!: HubLink
  private pairing!: PairingClient
  private pairingAttempt = 0
  private pairingGeneration = ''
  private lock!: InstanceLock
  private adapter: Adapter | null = null
  private adapterStarted = false
  private lockState: 'held' | 'other' | 'restart' | 'none' = 'none'
  private nativeCacheStale = false
  private expiryTimer: unknown = null
  private updateCheck: UpdateCheck | null = null
  private readonly updateHostInstance = randomUUID()
  private updateChecking: Promise<UpdateCheck> | null = null
  private updateInstallation: UpdateInstallation | null = null
  private readonly updateDir: string | null
  private updateReceipt!: JsonDocument<UpdateInstallation | null>
  private updateReconciling: Promise<UpdateInstallation | null> | null = null
  private updateInstalling: Promise<UpdateInstallation> | null = null
  private lastUnpair: { at: number; hub: 'removed' | 'refused' | 'unreachable' | 'not-paired' } | null = null
  private fatal: string | null = null
  private disposed = false
  private closing: Promise<void> | null = null
  private stateWatcher: FSWatcher | null = null
  private stateUpdates: Promise<void> = Promise.resolve()
  private readonly dshVersion: string | null
  readonly ready: Promise<void>

  constructor(ctx: HostContext, options: RemoraOptions) {
    this.ctx = ctx
    this.options = options
    this.clock = options.clock ?? systemClock
    this.dshVersion = options.dshVersion ?? dshVersion()
    const profile = ctx.get('profileContext')
    const profileDir = profile && typeof profile === 'object' && 'dir' in profile && typeof profile.dir === 'string' ? profile.dir : null
    this.updateDir = profileDir ? join(profileDir, '.dsh-remora-updates') : null
    const homePath = ctx.get('dshHomePath')
    this.dataDir = options.dataDir ?? remoraDataDir(typeof homePath === 'function' ? homePath as (...segments: string[]) => string : undefined)
    this.nativeCacheStale = staleNativeDirs.has(this.dataDir)
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
    this.remoteSchedules = new FileRemoteScheduleStore(await JsonDocument.open(dir, remoteSchedulesSpec))
    this.auditLog = await AuditLog.open(dir, { now: () => this.clock.now() })
    if (this.updateDir) {
      this.updateReceipt = await JsonDocument.open(this.updateDir, updateReceiptSpec)
      this.updateInstallation = this.updateReceipt.value
      // The manager may be waiting for this replacement Host to mount: do not await its own installation here.
      if (this.updateInstallation && ['installing', 'unknown'].includes(this.updateInstallation.phase)) {
        void this.reconcileUpdate().catch(error => this.ctx.logger.warn('Remora: update reconciliation failed', error))
      } else {
        await this.reconcileUpdate().catch(error => this.ctx.logger.warn('Remora: update reconciliation failed', error))
      }
    }
    await this.settingsDoc.update(adoptNewOperations)
    const credentials = this.ctx.get('credentials') as CredentialsLike | undefined
    this.keyStore = new HostKeyStore(dir, credentials && typeof credentials.readRecord === 'function' ? credentials : undefined)
    if (this.pairingDoc.value.paired) {
      try {
        this.hostKey = await this.keyStore.load()
        this.previousKey = await this.keyStore.load('previous')
      } catch (error) {
        this.ctx.logger.warn('Remora: could not read the host key', error)
      }
      const pinned = this.pairingDoc.value.paired.publicKey
      if (this.hostKey && this.hostKey.publicKey !== pinned && this.previousKey?.publicKey === pinned) {
        // Stopped in the middle of a rotation, after the new key was stored: go on with it.
        const current = this.hostKey
        await this.pairingDoc.update(state => (state.paired ? { ...state, paired: { ...state.paired, publicKey: current.publicKey } } : state))
      } else if (this.hostKey && this.hostKey.publicKey !== pinned && !this.previousKey) {
        this.ctx.logger.warn('Remora: the stored host key does not match the pairing; pair again')
        this.hostKey = null
      }
      // Two stored keys and neither pinned: keep both; the first handshake that gets through decides.
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
      onRotateKey: frame => this.onRotateKey(frame),
      onRotateKeyCommit: frame => { void this.onRotateKeyCommit(frame) },
      onAuthFailed: () => this.onAuthFailed(),
      onFatal: reason => { void this.onFatal(reason).catch(error => this.ctx.logger.warn('Remora: host shutdown failed', error)) },
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
      onApproved: (approved, key, signal) => this.onPaired(approved, key, signal, this.pairingGeneration),
    })
    this.lock = new InstanceLock(dir)
    this.adapter = this.options.createAdapter(this.ctx, {
      scope: this.scope,
      tasks: this.tasks,
      workspaceCreations: this.workspaceCreations,
      remoteSchedules: this.remoteSchedules,
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
    this.stateWatcher = watch(dir, { persistent: false }, (_event, file) => {
      if (file === null || file.toString() === 'settings.json' || file.toString() === 'pairing.json') {
        void this.syncState().catch(error => this.ctx.logger.warn('Remora: shared state update failed', error))
      }
    })
    this.stateWatcher.on('error', error => {
      this.ctx.logger.warn('Remora: shared state watcher failed', error)
      void this.stopLink('stopped', 'storage-failed')
    })
    if (!this.canConnect()) await this.cleanStoppedSchedules('stopped-on-startup')
    await this.startLink()
  }

  dispose(): Promise<void> {
    return this.closing ??= this.close()
  }

  private async close(): Promise<void> {
    this.disposed = true
    this.pairingAttempt++
    this.pairing?.cancel('idle')
    this.stateWatcher?.close()
    await this.ready
    if (this.fatal !== null && !this.link) return
    this.clock.clearTimeout(this.expiryTimer)
    this.pairing?.cancel('idle')
    this.dispatcher?.abortAll('unloading')
    this.link?.stop('idle')
    this.events?.dispose()
    await this.stateUpdates
    await this.adapter?.stopClones?.()
    try { await this.adapter?.dispose() } catch (error) { this.ctx.logger.warn('Remora: adapter dispose failed', error) }
    await this.keyWrites
    await this.lock?.release()
    await this.auditLog?.flush()
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
    if (this.nativeCacheStale) {
      this.lockState = 'restart'
      this.link.stop('stopped', 'restart-required')
      return
    }
    if (!this.canConnect()) return
    if (!(await this.lock.acquire())) {
      this.nativeCacheStale = true
      staleNativeDirs.add(this.dataDir)
      this.lockState = 'other'
      return
    }
    this.lockState = 'held'
    if (this.disposed || !this.canConnect()) { await this.lock.release(); this.lockState = 'none'; return }
    try {
      await this.tasks.refresh()
      await this.workspaceCreations.refresh()
      await this.remoteSchedules.refresh()
      await this.confirmationsDoc.refresh()
      await this.adapter?.prepare?.()
      const previous = this.settingsDoc.value
      const saved = await this.settingsDoc.refresh()
      await this.pairingDoc.refresh()
      await this.applySettings(previous, saved)
      if (!this.canConnect()) {
        await this.stopLink('stopped', saved.killSwitch ? 'kill-switch' : 'unpaired', 'stopped-before-connect')
        return
      }
      this.link.start()
    } catch (error) {
      await this.lock.release()
      this.lockState = 'none'
      throw error
    }
  }

  private async stopLink(state: 'idle' | 'stopped', error: string | null, removeSchedules?: string): Promise<void> {
    this.dispatcher.abortAll('link stopped')
    this.link.stop(state, error)
    try {
      await this.adapter?.stopClones?.()
      await this.keyWrites
      this.link.stop(state, error)
      if (removeSchedules && this.lock.held) await this.removeRemoteSchedules(removeSchedules)
    } finally {
      await this.lock.release()
      this.lockState = this.nativeCacheStale ? 'restart' : 'none'
    }
  }

  private onLinkReady(): void {
    this.audit({ kind: 'connection', action: 'connected', outcome: 'ok' })
    this.keySwaps = 0
    const working = this.hostKey
    if (this.previousKey && working) {
      // The key in use got through: store it as the current key, then forget the other one.
      // Swaps only happen in memory, so until here both keys stay on disk.
      this.previousKey = null
      this.writeKeys(async () => {
        const stored = await this.keyStore.load()
        if (stored?.publicKey !== working.publicKey) await this.keyStore.save(working)
        await this.keyStore.delete('previous')
        await this.pairingDoc.update(state => (state.paired ? { ...state, paired: { ...state.paired, publicKey: working.publicKey } } : state))
      })
      this.audit({ kind: 'connection', action: 'rotate-key-finished', outcome: 'ok' })
    }
    if (!this.adapterStarted && this.adapter) {
      this.adapterStarted = true
      try { this.adapter.start() } catch (error) { this.ctx.logger.warn('Remora: adapter start failed', error) }
    }
    this.events.flush()
  }

  private async onRequest(frame: RequestFrame): Promise<void> {
    try {
      // File notifications are advisory; every request checks durable permissions
      // before dispatch, including a stop made by another DSH process.
      await this.syncState()
      if (!this.link.connected) return
      await this.dispatcher.handle(frame)
    } catch (error) {
      this.dispatcher.abortAll('storage failed')
      await this.stopLink('stopped', 'storage-failed')
      this.ctx.logger.warn('Remora: could not check shared state', error)
    }
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

  // --- host key rotation (host.rotate-key, approved by the owner on the hub) -------------------

  /** Make a new key and prove it with the current one and itself. Nothing is stored until the hub commits. */
  private onRotateKey(frame: RotateKeyFrame): void {
    const paired = this.pairingDoc.value.paired
    const key = this.hostKey
    // One rotation at a time: a kept previous key means the last one has not finished.
    if (!paired || !key || this.previousKey) return
    const next = HostKey.generate(this.clock.now())
    const message = rotateKeyMessage(paired.hubOrigin, paired.hostId, frame.nonce, frame.issuedAt, next.publicKey)
    this.pendingRotation = { nonce: frame.nonce, key: next }
    this.link.send({ t: 'rotate-key-proof', nonce: frame.nonce, publicKey: next.publicKey, signature: key.sign(message), newSignature: next.sign(message) })
    this.audit({ kind: 'connection', action: 'rotate-key-proposed', outcome: 'ok' })
  }

  /** The hub accepted the new key: store both keys (old one first), then reconnect with the new one. */
  private async onRotateKeyCommit(frame: RotateKeyCommitFrame): Promise<void> {
    const pending = this.pendingRotation
    const old = this.hostKey
    if (!pending || !old || pending.nonce !== frame.nonce || pending.key.publicKey !== frame.publicKey) return
    this.pendingRotation = null
    try {
      // The old key first: whatever happens next, the key the hub accepts stays on disk.
      await this.writeKeys(async () => {
        await this.keyStore.save(old, 'previous')
        await this.keyStore.save(pending.key)
        await this.pairingDoc.update(state => (state.paired ? { ...state, paired: { ...state.paired, publicKey: pending.key.publicKey } } : state))
      }, true)
    } catch (error) {
      this.ctx.logger.warn('Remora: could not store the new host key; keeping the old one', error)
      await this.keyStore.save(old).catch(() => undefined)
      await this.pairingDoc.update(state => (state.paired ? { ...state, paired: { ...state.paired, publicKey: old.publicKey } } : state)).catch(() => undefined)
      this.audit({ kind: 'connection', action: 'rotate-key-committed', outcome: 'error' })
      return
    }
    this.previousKey = old
    this.hostKey = pending.key
    this.audit({ kind: 'connection', action: 'rotate-key-committed', outcome: 'ok' })
    if (!this.disposed && this.canConnect() && this.lock.held) this.link.reconnect()
  }

  /**
   * The hub refused the handshake. With two keys (a rotation in flight), try
   * the other one: the hub may have dropped the new key, or already the old.
   */
  private onAuthFailed(): boolean {
    const other = this.previousKey
    const current = this.hostKey
    if (!other || !current) return false
    // In memory only: both keys stay on disk until one gets through (onLinkReady).
    this.hostKey = other
    this.previousKey = current
    this.keySwaps++
    this.audit({ kind: 'connection', action: 'rotate-key-swapped', outcome: 'error', reason: 'auth-failed' })
    return this.keySwaps <= 1
  }

  private async removeRemoteSchedules(reason: string): Promise<void> {
    await this.remoteSchedules.refresh()
    if (this.remoteSchedules.list().length === 0 || !this.adapter?.removeRemoteSchedules) return
    try {
      const removed = await this.adapter.removeRemoteSchedules()
      await this.remoteSchedules.refresh()
      if (this.remoteSchedules.list().length > 0) throw new RpcError('schedule-cleanup-pending')
      this.audit({ kind: 'settings', action: 'remote-schedules-removed', outcome: 'ok', reason: `${reason}:${removed}` })
    } catch (error) {
      this.ctx.logger.warn('Remora: could not remove the schedules created through Remora', error)
      this.audit({ kind: 'settings', action: 'remote-schedules-removed', outcome: 'error', reason })
      throw error
    }
  }

  /** Run key store writes one at a time. With `rethrow`, the caller sees a failure; otherwise it is logged. */
  private writeKeys(write: () => Promise<void>, rethrow = false): Promise<void> {
    const run = this.keyWrites.then(write)
    this.keyWrites = run.catch(error => { if (!rethrow) this.ctx.logger.warn('Remora: could not store the host keys', error) })
    return rethrow ? run : this.keyWrites
  }

  private onFatal(reason: string): Promise<void> {
    this.dispatcher.abortAll(reason)
    return this.updateState(async () => {
      this.audit({ kind: 'connection', action: reason, outcome: 'error' })
      if (reason === 'revoked') {
        await this.pairingDoc.update(current => ({ ...current, revoked: true }))
        await this.stopLink('stopped', 'revoked', 'revoked')
      } else {
        await this.stopLink('stopped', reason)
      }
    })
  }

  /** Retry tracked cleanup on startup, without deleting another process's schedules through stale DSH state. */
  private async cleanStoppedSchedules(reason: string): Promise<void> {
    if (this.nativeCacheStale) {
      await this.remoteSchedules.refresh()
      if (this.remoteSchedules.list().length > 0) throw new RpcError('restart-required')
      return
    }
    if (!(await this.lock.acquire())) {
      this.nativeCacheStale = true
      staleNativeDirs.add(this.dataDir)
      this.lockState = 'other'
      return
    }
    try {
      await this.workspaceCreations.refresh()
      await this.adapter?.prepare?.()
      await this.removeRemoteSchedules(reason)
    } finally { await this.lock.release() }
  }

  private emit(event: HostEvent): void {
    this.events?.emit(event)
  }

  private sendHostStatus(): void {
    const settings = this.settingsDoc.value
    this.emit({ kind: 'host-status', ceiling: settings.ceiling, killSwitch: settings.killSwitch, operations: this.operationIds() })
  }

  // --- pairing ------------------------------------------------------------------

  private onPaired(approved: ApprovedPairing, key: HostKey, signal: AbortSignal, generation: string): Promise<void> {
    // Approval can overlap cancellation, another attempt, or unpairing while
    // the credential store is writing. Keep commit and rollback inside the
    // state queue so unpair/dispose finish after all of those writes.
    return this.updateState(async () => {
      const check = (): void => {
        if (this.disposed || signal.aborted) throw new Error('pairing cancelled')
      }
      check()
      // Release native ownership before waiting for the pairing lock: another
      // process may be unpairing and waiting for this owner to stop.
      await this.stopLink('idle', null)
      let restore: (() => Promise<void>) | undefined
      let restored = false
      try {
        await withFileLock(this.dataDir, 'pairing-mutation.lock', async () => {
          check()
          const previousPairing = await this.pairingDoc.refresh()
          if (previousPairing.generation !== generation) {
            // refresh() already adopted the newer document, so syncState cannot
            // detect this key change later by comparing its cached document.
            this.hostKey = previousPairing.paired ? await this.keyStore.load() : null
            this.previousKey = previousPairing.paired ? await this.keyStore.load('previous') : null
            this.pendingRotation = null
            throw new Error('pairing superseded')
          }
          const previousHubUrl = this.settingsDoc.value.hubUrl
          const storedKey = await this.keyStore.load()
          const storedPreviousKey = await this.keyStore.load('previous')
          let keysChanged = false
          let pairingChanged = false
          let hubUrlChanged = false
          // Called only under the mutation lock. A stop/new attempt in another
          // process owns a different generation and must never be rolled back.
          restore = async () => {
            const current = await this.pairingDoc.refresh()
            if (current.generation === generation) {
              if (keysChanged) {
                if (storedKey) await this.keyStore.save(storedKey)
                else await this.keyStore.delete('current')
                if (storedPreviousKey) await this.keyStore.save(storedPreviousKey, 'previous')
                else await this.keyStore.delete('previous')
              }
              if (pairingChanged) await this.pairingDoc.update(latest => latest.paired?.publicKey === key.publicKey ? previousPairing : latest)
              if (hubUrlChanged) await this.settingsDoc.update(latest => latest.hubUrl === approved.hubOrigin ? { ...latest, hubUrl: previousHubUrl } : latest)
            }
            // Reload the actual slots rather than restoring another process's
            // potentially stale in-memory key snapshot.
            this.hostKey = this.pairingDoc.value.paired ? await this.keyStore.load() : null
            this.previousKey = this.pairingDoc.value.paired ? await this.keyStore.load('previous') : null
            restored = true
          }
          try {
            check()
            keysChanged = true
            await this.keyStore.save(key)
            check()
            await this.keyStore.delete('previous')
            check()
            pairingChanged = true
            await this.pairingDoc.update(current => {
              check()
              if (current.generation !== generation) throw new Error('pairing superseded')
              return {
                generation,
                paired: { ...approved, publicKey: key.publicKey, pairedAt: this.clock.now() },
                pendingCredentials: null,
                revoked: false,
              }
            })
            check()
            hubUrlChanged = true
            await this.settingsDoc.update(current => {
              check()
              return { ...current, hubUrl: approved.hubOrigin }
            })
            check()
            this.hostKey = key
            this.previousKey = null
            this.pendingRotation = null
          } catch (error) {
            await restore()
            throw error
          }
        })
        check()
        await this.startLink()
        check()
        if (this.pairingDoc.value.generation !== generation || this.pairingDoc.value.paired?.publicKey !== key.publicKey) throw new Error('pairing superseded')
        this.lastUnpair = null
        this.audit({ kind: 'settings', action: 'paired', outcome: 'ok', local: true })
      } catch (error) {
        this.link.stop('idle')
        if (restore && !restored) await withFileLock(this.dataDir, 'pairing-mutation.lock', restore)
        // A cancelled re-pair must leave the established pairing usable.
        // Unpair/dispose use idle and are about to remove or stop that pairing.
        if (!this.disposed && this.pairing.view.phase !== 'idle') await this.startLink()
        else { await this.lock.release(); this.lockState = 'none' }
        throw error
      }
    })
  }

  async startPairing(hubUrl: string, local: boolean): Promise<PairingView> {
    this.requireLocal(local, ['pairing'])
    if (this.disposed) throw new RpcError('unavailable')
    if (this.nativeCacheStale) throw new RpcError('restart-required')
    const attempt = ++this.pairingAttempt
    this.pairing.cancel('cancelled')
    await this.updateState(() => withFileLock(this.dataDir, 'pairing-mutation.lock', async () => {
      if (this.disposed || attempt !== this.pairingAttempt) return
      const generation = randomUUID()
      await this.pairingDoc.update(current => ({ ...current, generation }))
      this.pairingGeneration = generation
    }))
    if (this.disposed || attempt !== this.pairingAttempt) return this.pairing.view
    const name = this.settingsDoc.value.hostName
    const view = await this.pairing.start(hubUrl, name, PLUGIN_VERSION)
    await this.updateState(async () => {
      if (this.disposed || attempt !== this.pairingAttempt || view !== this.pairing.view || !view.hubOrigin) return
      await this.settingsDoc.update(current => this.disposed || attempt !== this.pairingAttempt
        ? current : { ...current, hubUrl: view.hubOrigin ?? current.hubUrl })
    })
    return this.pairing.view
  }

  async cancelPairing(): Promise<void> {
    this.pairingAttempt++
    this.pairing.cancel('cancelled')
    await this.stateUpdates
  }

  /** Forget the pairing and the key. The host should also be removed on the hub. */
  async unpair(local: boolean): Promise<void> {
    this.pairingAttempt++
    this.pairing.reset()
    await this.updateState(async () => {
      const generation = randomUUID()
      await withFileLock(this.dataDir, 'pairing-mutation.lock', async () => {
        const latest = await this.pairingDoc.refresh()
        this.lastUnpair = { at: this.clock.now(), hub: await this.unpairAtHub(latest.paired, await this.keyStore.load()) }
        // Keep a durable generation even when already unpaired. It invalidates
        // approvals that began before this stop but have not committed yet.
        await this.pairingDoc.update(() => ({ ...pairingSpec.initial(), generation }))
      })
      await this.stopLink('idle', null, 'unpaired')
      await this.waitForOwnerStop()
      await this.cleanStoppedSchedules('unpaired')
      await withFileLock(this.dataDir, 'pairing-mutation.lock', async () => {
        // A newly authorized attempt in another process may already be using
        // these slots; do not erase its key after finishing native cleanup.
        if ((await this.pairingDoc.refresh()).generation !== generation) return
        await this.keyStore.delete()
        this.hostKey = null
        this.previousKey = null
        this.pendingRotation = null
      })
      this.adapterStarted = false
      this.audit({ kind: 'settings', action: 'unpaired', outcome: this.lastUnpair!.hub === 'removed' ? 'ok' : 'error', reason: `hub:${this.lastUnpair!.hub}`, local })
    })
  }

  /**
   * Ask the hub to forget this host (`POST /pair/unpair`, signed with the
   * host key). Local state is cleared whatever the answer; a failure only
   * means the user must also remove the host on the hub.
   */
  private async unpairAtHub(paired = this.pairingDoc.value.paired, key = this.hostKey): Promise<'removed' | 'refused' | 'unreachable' | 'not-paired'> {
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

  async reconnect(): Promise<void> {
    if (this.nativeCacheStale) throw new RpcError('restart-required')
    if (this.link.status.state === 'idle' || this.link.status.state === 'stopped') await this.startLink()
    else this.link.reconnect()
  }

  // --- settings -----------------------------------------------------------------

  private requireLocal(local: boolean, reasons: string[]): void {
    if (!local && reasons.length > 0) throw new RpcError('local-only', reasons.join(','))
  }

  private updateState<T>(run: () => Promise<T>): Promise<T> {
    const pending = this.stateUpdates.then(run)
    this.stateUpdates = pending.then(() => undefined, () => undefined)
    return pending
  }

  /** Refresh settings and pairing changed by another process sharing this DSH home. */
  async syncState(): Promise<void> {
    await this.ready
    if (this.disposed || !this.settingsDoc || !this.pairingDoc) return
    await this.updateState(async () => {
      const previous = this.settingsDoc.value
      const previousPairing = this.pairingDoc.value
      const saved = await this.settingsDoc.refresh()
      const paired = await this.pairingDoc.refresh()
      await this.applySettings(previous, saved)
      if (canonicalJson(previousPairing) !== canonicalJson(paired)) {
        if (paired.revoked || !paired.paired) {
          this.pairing.cancel('idle')
          await this.stopLink(paired.revoked ? 'stopped' : 'idle', paired.revoked ? 'revoked' : null, paired.revoked ? 'revoked' : 'unpaired')
        } else if (previousPairing.paired?.publicKey !== paired.paired.publicKey || previousPairing.paired?.hubOrigin !== paired.paired.hubOrigin) {
          await this.stopLink('idle', null)
          this.hostKey = await this.keyStore.load()
          this.previousKey = await this.keyStore.load('previous')
          await this.startLink()
        }
      }
      if (this.nativeCacheStale && !(await this.lock.occupied())) this.lockState = 'restart'
    })
  }

  private saveSettings(change: (current: RemoraSettings) => RemoraSettings, local: boolean, action: string | ((previous: RemoraSettings, saved: RemoraSettings) => string)): Promise<RemoraSettings> {
    return this.updateState(async () => {
      const observed = this.settingsDoc.value
      let previous = this.settingsDoc.value
      const saved = await this.settingsDoc.update(current => {
        previous = current
        const next = change(current)
        this.requireLocal(local, wideningReasons(current, next, this.clock.now()))
        return next
      })
      if (previous !== saved) await this.audit({ kind: 'settings', action: typeof action === 'string' ? action : action(previous, saved), outcome: 'ok', local })
      await this.applySettings(observed, saved)
      return saved
    })
  }

  private async applySettings(previous: RemoraSettings, saved: RemoraSettings): Promise<void> {
    if (canonicalJson(previous.ceiling) !== canonicalJson(saved.ceiling) || previous.killSwitch !== saved.killSwitch) this.sendHostStatus()
    this.scheduleExpiry()
    if (canonicalJson(previous.scope.placements) !== canonicalJson(saved.scope.placements)) await this.scope.revalidatePlacements(this.roots())
    if (canonicalJson(previous) !== canonicalJson(saved)) this.settingsChanged()
    if (saved.killSwitch) {
      this.events.flush()
      await this.stopLink('stopped', 'kill-switch', 'kill-switch')
    } else if (previous.killSwitch) {
      await this.startLink()
    } else if (previous.hostName !== saved.hostName && this.link.connected) this.link.reconnect()
  }

  private settingsChanged(): void {
    try { this.adapter?.settingsChanged?.() } catch (error) { this.ctx.logger.warn('Remora: adapter settings update failed', error) }
  }

  async setPermission(input: { level: PermissionLevel; overrides?: Partial<Record<OperationId, boolean>>; confirmFull?: boolean }, local: boolean): Promise<void> {
    await this.saveSettings(previous => {
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
      return { ...previous, ceiling, knownOperations: [...ALL_OPERATION_IDS] }
    }, local, `permission:${input.level}${input.overrides ? '+custom' : ''}`)
  }

  async extendFullAccess(local: boolean): Promise<void> {
    await this.saveSettings(previous => {
      if (!fullAccessActive(previous.ceiling, this.clock.now())) throw new RpcError('full-access-inactive')
      return { ...previous, ceiling: { ...previous.ceiling, fullAccessExpiresAt: this.clock.now() + FULL_ACCESS_TTL_MS } }
    }, local, 'full-access-extended')
  }

  async setKillSwitch(on: boolean, local: boolean): Promise<void> {
    if (on) this.dispatcher.abortAll('kill switch')
    await this.saveSettings(previous => previous.killSwitch === on ? previous : { ...previous, killSwitch: on }, local, `kill-switch:${on ? 'on' : 'off'}`)
    if (on) {
      // A secondary tab must not report success before the connection owner has
      // stopped its link, background clones, and scheduled prompts.
      await this.waitForOwnerStop()
      await this.cleanStoppedSchedules('kill-switch')
    }
  }

  private async waitForOwnerStop(): Promise<void> {
    const deadline = Date.now() + 10_000
    while (await this.lock.occupied()) {
      if (Date.now() >= deadline) throw new RpcError('stop-pending')
      await delay(10)
    }
  }

  /** Apply edits to the host name and scope lists. Placements have their own methods. */
  async updateSettings(patch: unknown, local: boolean): Promise<void> {
    if (typeof patch !== 'object' || patch === null) throw new RpcError('invalid-payload')
    const input = patch as { hostName?: unknown; scope?: Record<string, unknown> }
    await this.saveSettings(previous => {
      const next: RemoraSettings = { ...previous, scope: { ...previous.scope } }
      if (input.hostName !== undefined) {
        if (typeof input.hostName !== 'string' || input.hostName.trim() === '' || input.hostName.length > 100) throw new RpcError('invalid-payload', 'hostName')
        next.hostName = input.hostName.trim()
      }
      const scope = input.scope
      if (scope !== undefined) {
        if (typeof scope !== 'object' || scope === null) throw new RpcError('invalid-payload', 'scope')
        const list = (key: 'workspaces' | 'skills' | 'agentPresets' | 'commands' | 'gitHosts' | 'untrustedWorkspaces', check: (item: string) => boolean, map: (item: string) => string = item => item) => {
          const value = scope[key]
          if (value === undefined) return
          if (!Array.isArray(value) || value.length > 500 || !value.every(item => typeof item === 'string' && check(map(item)))) throw new RpcError('invalid-payload', key)
          next.scope[key] = [...new Set(value.map(item => map(item as string)))]
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
      return next
    }, local, 'settings')
  }

  /**
   * Answers from outside: how long Remora holds questions, plan reviews and
   * approvals (minutes, 0 = off), and whether approvals may be answered from
   * MCP and CLI without the owner's passkey. Turning either on needs this PC.
   */
  async setAnswers(patch: unknown, local: boolean): Promise<void> {
    if (typeof patch !== 'object' || patch === null) throw new RpcError('invalid-payload')
    const input = patch as { waitMinutes?: unknown; approvalsFromRemote?: unknown }
    await this.saveSettings(previous => {
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
      return actions.length === 0 ? previous : next
    }, local, (previous, saved) => [
      ...(previous.remoteAnswerWaitMs !== saved.remoteAnswerWaitMs ? [`answer-wait:${saved.remoteAnswerWaitMs / 60_000}m`] : []),
      ...(previous.approvalsFromRemote !== saved.approvalsFromRemote ? [`approvals-from-remote:${saved.approvalsFromRemote ? 'on' : 'off'}`] : []),
    ].join(','))
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
    await this.saveSettings(previous => previous.scope.placements.some(p => p.path === real)
      ? previous
      : { ...previous, scope: { ...previous.scope, placements: [...previous.scope.placements, newPlacement(real, this.clock.now())] } }, local, 'placement-added')
  }

  async removePlacement(placementId: unknown, local: boolean): Promise<void> {
    if (typeof placementId !== 'string') throw new RpcError('invalid-payload', 'placementId')
    await this.saveSettings(previous => ({ ...previous, scope: { ...previous.scope, placements: previous.scope.placements.filter(p => p.placementId !== placementId) } }), local, 'placement-removed')
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
    if (this.disposed) return
    await this.saveSettings(current => {
      if (current.ceiling.level !== 'full' || current.ceiling.fullAccessExpiresAt === undefined || current.ceiling.fullAccessExpiresAt > this.clock.now()) return current
      const { fullAccessExpiresAt: _expired, ...rest } = current.ceiling
      return { ...current, ceiling: { ...rest, level: 'request' } }
    }, false, 'full-access-expired')
  }

  // --- reads ----------------------------------------------------------------------

  private operationIds(): string[] {
    const served = this.features().available.filter(id => !NOT_ADVERTISED.has(id))
    // Served by the connection itself (rotate-key frames), whatever DSH offers.
    return this.hostKey ? [...served, 'host.rotate-key'] : served
  }

  private features(): FeatureReport {
    const adapter = this.adapter
    if (!adapter) return { available: [], missing: [] }
    return detectFeatures(service => adapter.has(service), new Set(Object.keys(adapter.handlers) as OperationId[]))
  }

  private audit(entry: AuditInput): Promise<void> {
    if (!this.auditLog) return Promise.resolve()
    return this.auditLog.append(entry).then(() => undefined, error => this.ctx.logger.warn('Remora: audit write failed', error))
  }

  async auditEntries(limit = 200): Promise<AuditEntry[]> {
    await this.auditLog?.flush()
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
    if (this.disposed) throw new RpcError('unloading')
    const now = this.clock.now()
    if (this.updateChecking) return this.updateChecking
    if (!force && this.updateCheck && now - this.updateCheck.checkedAt < 60 * 60_000) return this.updateCheck
    const pending = checkForUpdate(PLUGIN_VERSION, this.httpFetch(), now, this.dshVersion).then(async check => {
      const manager = this.pluginManager()
      if (!manager) check.installUnavailable = 'manager-unavailable'
      else {
        try {
          const bundle = (await manager.listBundles()).find(item => item.name === 'dsh-remora')
          if (!bundle?.installed || bundle.readOnlyReason) check.installUnavailable = bundle?.readOnlyReason ?? 'read-only'
          else if (!await this.isReleaseSource(bundle.source, bundle.version)) check.installUnavailable = 'manual-source'
        } catch { check.installUnavailable = 'manager-unavailable' }
      }
      if (this.disposed) throw new RpcError('unloading')
      this.updateCheck = check
      return check
    })
    this.updateChecking = pending
    try { return await pending } finally { this.updateChecking = null }
  }

  /** The fetch used for GitHub requests (tests inject one). */
  private httpFetch(): GetFetch {
    return this.options.githubFetch ?? ((input, init) => fetch(input, init))
  }

  private pluginManager(): UpdatePluginManager | null {
    const manager = this.ctx.get('pluginManager') as Partial<UpdatePluginManager> | undefined
    return this.updateDir && manager && typeof manager.installBundle === 'function' && typeof manager.listBundles === 'function' ? manager as UpdatePluginManager : null
  }

  private async isReleaseSource(source: string | undefined, version: string | undefined): Promise<boolean> {
    if (!source || !version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return false
    const name = `dsh-remora-${version}.tgz`
    try {
      if (source.startsWith('https:')) {
        const url = new URL(source)
        return url.hostname === 'github.com' && !url.username && !url.password && !url.search && !url.hash &&
          url.pathname === `/Aero123421/dsh-remora/releases/download/v${version}/${name}`
      }
      const path = source.startsWith('file:') ? fileURLToPath(source) : source
      if ((path.includes('\\') ? win32.basename(path) : basename(path)) !== name) return false
      const stat = await lstat(path)
      return stat.isFile() && !stat.isSymbolicLink()
    } catch { return false }
  }

  /** Reconnects observe the original operation; they never submit a second install. */
  reconcileUpdate(): Promise<UpdateInstallation | null> {
    if (this.updateReconciling) return this.updateReconciling
    const pending = this.readUpdateReceipt()
    this.updateReconciling = pending
    void pending.finally(() => { if (this.updateReconciling === pending) this.updateReconciling = null }).catch(() => {})
    return pending
  }

  private async readUpdateReceipt(): Promise<UpdateInstallation | null> {
    if (!this.updateDir) return null
    const operation = await this.updateReceipt.refresh()
    if (!operation || this.updateInstalling) return this.updateInstallation
    const manager = this.pluginManager()
    let next = operation
    if (operation.phase === 'downloading') next = { ...operation, phase: 'failed', error: 'interrupted-before-install' }
    if (operation.phase === 'installing' || operation.phase === 'unknown') {
      const result = operation.requestId && manager?.waitForInstall ? await manager.waitForInstall(operation.requestId) : null
      next = result ? installationResult(result, operation) : { ...operation, phase: 'unknown' }
    }
    const bundle = manager ? (await manager.listBundles()).find(item => item.name === 'dsh-remora') : undefined
    // A lost result alone is never success. Confirm with both installed and executing versions.
    if (bundle?.installed && bundle.version === operation.version && PLUGIN_VERSION === operation.version &&
        ['applied', 'restart-required', 'unknown'].includes(next.phase)) next = { ...next, phase: 'confirmed', installedVersion: bundle.version }
    if (this.updateInstalling) return this.updateInstallation
    this.updateInstallation = await this.updateReceipt.update(current => {
      if (!current || current.requestId !== operation.requestId || current.phase === 'confirmed') return current
      // The old Host can save its completion while this Host waits for the manager.
      if (current && !['downloading', 'installing', 'unknown'].includes(current.phase) && next.phase === 'unknown') return current
      return next
    })
    return this.updateInstallation
  }

  async installUpdate(local: boolean, expectedVersion: unknown): Promise<UpdateInstallation> {
    this.requireLocal(local, ['plugin-update'])
    if (this.disposed) throw new RpcError('unloading')
    const check = this.updateCheck
    if (!check?.latest || !check.newer) throw new RpcError('no-update')
    if (expectedVersion !== check.latest.version) throw new RpcError('update-candidate-changed')
    if (this.updateInstalling) {
      if (this.updateInstallation?.version !== expectedVersion) throw new RpcError('update-in-progress')
      return this.updateInstalling
    }
    if (this.updateInstallation?.version === check.latest.version && ['applied', 'restart-required', 'confirmed', 'unknown', 'installing'].includes(this.updateInstallation.phase)) {
      return this.updateInstallation
    }
    const manager = this.pluginManager()
    if (!manager) throw new RpcError('install-unavailable')
    const release = check.latest
    this.updateInstallation = { attempt: (this.updateInstallation?.attempt ?? 0) + 1, version: release.version, requestId: newInstallRequestId(), phase: 'downloading' }
    const pending = (async (): Promise<UpdateInstallation> => {
      let managerStarted = false
      try {
        await this.updateReceipt.update(() => this.updateInstallation)
        // Read the current selection immediately before installation, not at check time.
        const bundle = (await manager.listBundles()).find(item => item.name === 'dsh-remora')
        if (this.disposed) throw new RpcError('unloading')
        if (!bundle || typeof bundle.enabled !== 'boolean') throw new UpdateError('unknown-bundle', 'cannot read the current bundle selection')
        if (!bundle.installed || bundle.readOnlyReason) throw new UpdateError('read-only', 'bundle is not writable')
        const source = bundle.source
        if (!await this.isReleaseSource(source, bundle.version)) {
          throw new UpdateError('manual-source', 'update this installation from its original source')
        }
        const fresh = await checkForUpdate(PLUGIN_VERSION, this.httpFetch(), this.clock.now(), this.dshVersion)
        if (fresh.installUnavailable) throw new UpdateError(fresh.installUnavailable, 'candidate compatibility is unavailable')
        if (fresh.error) throw new UpdateError(fresh.error, 'release recheck failed')
        if (fresh.latest?.id !== release.id || fresh.latest.version !== release.version || fresh.latest.tarball?.url !== release.tarball?.url || fresh.latest.sums !== release.sums) {
          throw new UpdateError('candidate-changed', 'release changed since the check')
        }
        const path = await downloadVerified(release, this.dataDir, this.httpFetch(), this.dshVersion)
        if (this.disposed) throw new RpcError('unloading')
        // Downloads can take time: preserve the latest selection and reject a newly read-only bundle.
        const before = (await manager.listBundles()).find(item => item.name === 'dsh-remora')
        if (!before?.installed || before.readOnlyReason || before.source !== source) throw new UpdateError('read-only', 'bundle changed during download')
        if (this.disposed) throw new RpcError('unloading')
        this.updateInstallation = { ...this.updateInstallation!, phase: 'installing' }
        await this.updateReceipt.update(() => this.updateInstallation)
        if (this.disposed) throw new RpcError('unloading')
        managerStarted = true
        const result = await manager.installBundle(path, { enabled: before.enabled, requestId: this.updateInstallation.requestId! })
        this.updateInstallation = installationResult(result, this.updateInstallation)
      } catch (error) {
        this.updateInstallation = {
          ...this.updateInstallation!, phase: managerStarted ? 'unknown' : 'failed',
          error: error instanceof UpdateError || error instanceof RpcError ? error.code : 'install-failed',
        }
        this.ctx.logger.warn('Remora: plugin update failed', error)
      }
      const result = this.updateInstallation!
      await this.updateReceipt.update(current => {
        if (!current || current.requestId !== result.requestId || current.phase === 'confirmed') return current
        if (result.phase === 'unknown' && !['downloading', 'installing', 'unknown'].includes(current.phase)) return current
        return result
      })
      await this.auditLog.append({
        kind: 'settings', action: `update:${release.version}`,
        outcome: result.phase === 'applied' || result.phase === 'restart-required' ? 'ok' : 'error',
        reason: [result.phase, result.stage, result.error].filter(Boolean).join(':'), local,
      })
      return result
    })()
    this.updateInstalling = pending
    try { return await pending } finally { this.updateInstalling = null }
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
      updateHostInstance: this.updateHostInstance,
      updateInstallation: this.updateInstallation,
      canInstallUpdate: this.pluginManager() !== null,
      questionModes: readQuestionModes(service => this.ctx.get(service)),
    }
  }

  // --- for tests ------------------------------------------------------------------

  /** @internal */
  get internals() {
    return {
      link: this.link, events: this.events, dispatcher: this.dispatcher, tasks: this.tasks, scope: this.scope, settings: () => this.settingsDoc.value, pairing: () => this.pairingDoc.value,
      keys: () => ({ current: this.hostKey?.publicKey ?? null, previous: this.previousKey?.publicKey ?? null }),
    }
  }
}
