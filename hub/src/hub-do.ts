/**
 * The single hub-wide Durable Object: owner, passkeys, sessions, recovery
 * codes, paired hosts and pairing requests, OAuth clients and their grants,
 * personal tokens, device codes, rate limits, the free-tier meter and the
 * hub-level audit log. Conversation content is never stored here.
 *
 * WebAuthn ceremonies are verified in the Worker; this object stores what
 * they produce and hands out single-use challenges.
 */
import { DurableObject } from 'cloudflare:workers'
import { AUDIT_SCHEMA, appendAudit, listAudit, type AuditEntry, type AuditRow } from './audit.ts'
import { CHALLENGE_TTL_MS, DEVICE_CODE_TTL_MS, DEVICE_POLL_INTERVAL_S, FULL_ACCESS_MS, RECOVERY_CODE_COUNT, REAUTH_WINDOW_MS, SESSION_IDLE_MS, SESSION_MAX_MS } from './config.ts'
import { PUSH_TYPES, type CallContext, type ClientKind, type ClientRecord, type ClientWithGrants, type DeviceInfo, type DevicePoll, type GrantLevel, type GrantSetting, type HostRecord, type HubState, type MeterTotals, type OwnerCredential, type PairingInfo, type PasskeyRecord, type PersonalTokenRecord, type PushDevice, type PushEvent, type PushOutcome, type PushType } from './types.ts'
import { buildPushRequest, generateVapidKeys, type VapidKeys } from './webpush.ts'
import { base32, parseJson, randomBytes, randomCode, randomToken, sha256Hex, utcDay, verifyEd25519 } from './util.ts'
import {
  CONFIRMATION_REQUEST_TTL_MS, HUB_CONFIRMATION_PREFIX, PAIRING_POLL_INTERVAL_MS, PAIRING_TTL_MS, TASK_WAIT_MAX_MS, USER_CODE_ALPHABET, pairPollMessage,
  type ConfirmationState, type Grant, type PairPollResponse, type PairStartRequest,
} from './vendor/protocol/index.ts'

export const HUB_OBJECT_NAME = 'hub'

/** Devices that can receive notifications. */
export const PUSH_MAX_DEVICES = 20
/** Per device: at most this many pushes per window (seconds); more are dropped. */
export const PUSH_RATE: readonly [number, number] = [30, 600]

/** Hub maintenance requests one client may have waiting for the owner at once. */
export const APPROVALS_PENDING_PER_CLIENT = 5
/** An approved export can be fetched for this long, and at most APPROVAL_RESULT_FETCHES times; then only the outcome remains. */
export const APPROVAL_RESULT_MS = 60 * 60_000
export const APPROVAL_RESULT_FETCHES = 3

/** A hub maintenance request (audit.export, hub.export) parked for the owner. */
export interface ApprovalRecord {
  id: string
  clientId: string
  clientName: string
  operation: string
  state: ConfirmationState
  createdAt: number
  expiresAt: number
  decidedAt: number | null
}

export const PAIRING_MAX_PER_SOURCE = 3
export const PAIRING_SOFT_CAP = 20
export const PAIRING_HARD_CAP = 100
export const PAIRING_IDLE_MS = 30_000

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    algorithm INTEGER NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT NOT NULL DEFAULT '[]',
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS recovery_codes (hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, used_at INTEGER);
  CREATE TABLE IF NOT EXISTS sessions (
    hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    reauth_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    challenge TEXT NOT NULL,
    data TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pairings (
    pairing_id TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    name TEXT NOT NULL,
    plugin_version TEXT NOT NULL,
    protocol INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    host_id TEXT
  );
  CREATE TABLE IF NOT EXISTS hosts (
    host_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    public_key TEXT NOT NULL,
    paired_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    domain TEXT,
    redirect_host TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS grants (
    client_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    level TEXT NOT NULL,
    overrides TEXT NOT NULL DEFAULT '{}',
    full_access_expires_at INTEGER,
    PRIMARY KEY (client_id, host_id)
  );
  CREATE TABLE IF NOT EXISTS pats (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS device_codes (
    hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    interval_s INTEGER NOT NULL,
    last_poll_at INTEGER,
    status TEXT NOT NULL,
    auth_code TEXT,
    code_verifier TEXT,
    redirect_uri TEXT
  );
  CREATE TABLE IF NOT EXISTS rate (key TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key, window_start));
  CREATE TABLE IF NOT EXISTS meter (day TEXT PRIMARY KEY, worker INTEGER NOT NULL, durable INTEGER NOT NULL, kv INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    label TEXT NOT NULL,
    types TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_sent_at INTEGER,
    last_error TEXT
  );
  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    op TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER,
    updated_at INTEGER NOT NULL,
    fetches INTEGER NOT NULL DEFAULT 0
  );
  ${AUDIT_SCHEMA}
`

type PasskeyRow = { credential_id: string; public_key: string; algorithm: number; counter: number; transports: string; label: string; created_at: number; last_used_at: number | null }
type ClientRow = { client_id: string; name: string; kind: string; domain: string | null; redirect_host: string | null; created_at: number; last_used_at: number | null; revoked_at: number | null }
type GrantRow = { client_id: string; host_id: string; level: string; overrides: string; full_access_expires_at: number | null }

const passkeyFromRow = (row: PasskeyRow): PasskeyRecord => ({
  credentialId: row.credential_id,
  publicKey: row.public_key,
  algorithm: row.algorithm,
  counter: row.counter,
  transports: parseJson<string[]>(row.transports, []),
  label: row.label,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
})

const clientFromRow = (row: ClientRow): ClientRecord => ({
  clientId: row.client_id,
  name: row.name,
  kind: row.kind as ClientKind,
  domain: row.domain,
  redirectHost: row.redirect_host,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  revokedAt: row.revoked_at,
})

const grantFromRow = (row: GrantRow): GrantSetting => ({
  clientId: row.client_id,
  hostId: row.host_id,
  level: row.level as GrantLevel,
  overrides: parseJson<Grant['overrides']>(row.overrides, {}),
  fullAccessExpiresAt: row.full_access_expires_at,
})

/** Turn the stored setting into the protocol Grant sent to the host, or null when blocked. */
export function toProtocolGrant(setting: Pick<GrantSetting, 'level' | 'overrides' | 'fullAccessExpiresAt'> | undefined): Grant | null {
  if (!setting) return { level: 'view' }
  if (setting.level === 'none') return null
  const grant: Grant = { level: setting.level }
  if (setting.overrides && Object.keys(setting.overrides).length > 0) grant.overrides = setting.overrides
  if (setting.level === 'full') grant.fullAccessExpiresAt = setting.fullAccessExpiresAt ?? 0
  return grant
}

/** Recovery codes look like `abcd-efgh-ijkl`; spaces, dashes and case are ignored on input. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z2-7]/g, '')
}

export class HubDO extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA)
      // Columns added after the first release.
      for (const statement of ['ALTER TABLE pairings ADD COLUMN source TEXT', 'ALTER TABLE pairings ADD COLUMN last_seen_at INTEGER', 'ALTER TABLE approvals ADD COLUMN fetches INTEGER NOT NULL DEFAULT 0']) {
        try {
          this.sql.exec(statement)
        } catch {
          // already there
        }
      }
    })
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value ?? null
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
  }

  private count(query: string, ...bindings: unknown[]): number {
    return this.sql.exec<{ n: number }>(query, ...bindings).one().n
  }

  // --- state ---------------------------------------------------------------

  async state(): Promise<HubState> {
    return {
      setupComplete: this.meta('setup_complete') === '1',
      passkeys: this.count('SELECT COUNT(*) AS n FROM passkeys'),
      hosts: this.count('SELECT COUNT(*) AS n FROM hosts WHERE revoked_at IS NULL'),
      allowOtherClients: this.meta('allow_other_clients') === '1',
      recoveryCodesLeft: this.count('SELECT COUNT(*) AS n FROM recovery_codes WHERE used_at IS NULL'),
      pushDevices: this.count('SELECT COUNT(*) AS n FROM push_subscriptions'),
    }
  }

  async setAllowOtherClients(allow: boolean): Promise<void> {
    this.setMeta('allow_other_clients', allow ? '1' : '0')
  }

  /** Stable WebAuthn user handle for the single owner. */
  async ownerUserId(): Promise<string> {
    let id = this.meta('owner_user_id')
    if (!id) {
      id = randomToken(16)
      this.setMeta('owner_user_id', id)
    }
    return id
  }

  // --- challenges ------------------------------------------------------------

  async putChallenge(kind: string, challenge: string, data: string | null = null): Promise<string> {
    const now = Date.now()
    this.sql.exec('DELETE FROM challenges WHERE created_at < ?', now - CHALLENGE_TTL_MS)
    const id = randomToken(18)
    this.sql.exec('INSERT INTO challenges (id, kind, challenge, data, created_at) VALUES (?, ?, ?, ?, ?)', id, kind, challenge, data, now)
    return id
  }

  /** Single use: the challenge is deleted whether or not it is still valid. */
  async takeChallenge(id: string, kind: string): Promise<{ challenge: string; data: string | null } | null> {
    const row = this.sql.exec<{ kind: string; challenge: string; data: string | null; created_at: number }>('SELECT kind, challenge, data, created_at FROM challenges WHERE id = ?', id).toArray()[0]
    this.sql.exec('DELETE FROM challenges WHERE id = ?', id)
    if (!row || row.kind !== kind || row.created_at < Date.now() - CHALLENGE_TTL_MS) return null
    return { challenge: row.challenge, data: row.data }
  }

  // --- passkeys and setup ------------------------------------------------------

  async listPasskeys(): Promise<PasskeyRecord[]> {
    return this.sql.exec<PasskeyRow>('SELECT * FROM passkeys ORDER BY created_at').toArray().map(passkeyFromRow)
  }

  async getPasskey(credentialId: string): Promise<PasskeyRecord | null> {
    const row = this.sql.exec<PasskeyRow>('SELECT * FROM passkeys WHERE credential_id = ?', credentialId).toArray()[0]
    return row ? passkeyFromRow(row) : null
  }

  /**
   * Registers the first passkey and closes setup for good. Returns the
   * recovery codes in clear text exactly once, or null when setup was
   * already completed (a race or a replay).
   */
  async completeSetup(passkey: PasskeyRecord): Promise<string[] | null> {
    if (this.meta('setup_complete') === '1' || this.count('SELECT COUNT(*) AS n FROM passkeys') > 0) return null
    this.insertPasskey(passkey)
    this.setMeta('setup_complete', '1')
    const codes = await this.replaceRecoveryCodes()
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'setup.complete', hostId: null, outcome: 'ok', layer: null, reason: null })
    return codes
  }

  private insertPasskey(passkey: PasskeyRecord): void {
    this.sql.exec(
      'INSERT INTO passkeys (credential_id, public_key, algorithm, counter, transports, label, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      passkey.credentialId, passkey.publicKey, passkey.algorithm, passkey.counter, JSON.stringify(passkey.transports), passkey.label, passkey.createdAt, passkey.lastUsedAt,
    )
  }

  async addPasskey(passkey: PasskeyRecord): Promise<boolean> {
    if (this.meta('setup_complete') !== '1') return false
    if (await this.getPasskey(passkey.credentialId)) return false
    this.insertPasskey(passkey)
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'passkey.add', hostId: null, outcome: 'ok', layer: null, reason: null })
    return true
  }

  /** The last passkey cannot be removed: the hub would be locked except for recovery codes. */
  async removePasskey(credentialId: string): Promise<boolean> {
    if (this.count('SELECT COUNT(*) AS n FROM passkeys') <= 1) return false
    this.sql.exec('DELETE FROM passkeys WHERE credential_id = ?', credentialId)
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'passkey.remove', hostId: null, outcome: 'ok', layer: null, reason: null })
    return true
  }

  async renamePasskey(credentialId: string, label: string): Promise<void> {
    this.sql.exec('UPDATE passkeys SET label = ? WHERE credential_id = ?', label, credentialId)
  }

  async recordPasskeyUse(credentialId: string, counter: number): Promise<void> {
    this.sql.exec('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?', counter, Date.now(), credentialId)
  }

  /** Owner passkeys as the COSE keys a host pins for confirmations. */
  async ownerCredentials(): Promise<OwnerCredential[]> {
    return (await this.listPasskeys()).map(passkey => ({ credentialId: passkey.credentialId, publicKey: passkey.publicKey, algorithm: passkey.algorithm }))
  }

  // --- recovery codes -------------------------------------------------------

  private async replaceRecoveryCodes(): Promise<string[]> {
    this.sql.exec('DELETE FROM recovery_codes')
    const now = Date.now()
    const codes: string[] = []
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const raw = base32(randomBytes(8)).slice(0, 12)
      codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`)
      this.sql.exec('INSERT INTO recovery_codes (hash, created_at) VALUES (?, ?)', await sha256Hex(`remora-recovery/v1\n${raw}`), now)
    }
    return codes
  }

  async regenerateRecoveryCodes(): Promise<string[]> {
    const codes = await this.replaceRecoveryCodes()
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'recovery.regenerate', hostId: null, outcome: 'ok', layer: null, reason: null })
    return codes
  }

  /** Consumes the code when it is valid and unused. */
  async useRecoveryCode(code: string): Promise<boolean> {
    const hash = await sha256Hex(`remora-recovery/v1\n${normalizeRecoveryCode(code)}`)
    const row = this.sql.exec<{ used_at: number | null }>('SELECT used_at FROM recovery_codes WHERE hash = ?', hash).toArray()[0]
    const ok = row !== undefined && row.used_at === null
    if (ok) this.sql.exec('UPDATE recovery_codes SET used_at = ? WHERE hash = ?', Date.now(), hash)
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'login.recovery-code', hostId: null, outcome: ok ? 'ok' : 'denied', layer: null, reason: ok ? null : 'invalid-code' })
    return ok
  }

  // --- sessions ---------------------------------------------------------------

  /** Creates a session for a fresh login; the login itself counts as a re-authentication. */
  async createSession(hash: string): Promise<void> {
    const now = Date.now()
    this.sql.exec('DELETE FROM sessions WHERE last_seen_at < ? OR created_at < ?', now - SESSION_IDLE_MS, now - SESSION_MAX_MS)
    this.sql.exec('INSERT INTO sessions (hash, created_at, last_seen_at, reauth_at) VALUES (?, ?, ?, ?)', hash, now, now, now)
  }

  /** Validates and refreshes a session. */
  async touchSession(hash: string): Promise<{ valid: boolean; fresh: boolean }> {
    const now = Date.now()
    const row = this.sql.exec<{ created_at: number; last_seen_at: number; reauth_at: number | null }>('SELECT created_at, last_seen_at, reauth_at FROM sessions WHERE hash = ?', hash).toArray()[0]
    if (!row || row.last_seen_at < now - SESSION_IDLE_MS || row.created_at < now - SESSION_MAX_MS) {
      if (row) this.sql.exec('DELETE FROM sessions WHERE hash = ?', hash)
      return { valid: false, fresh: false }
    }
    // Writing on every request is cheap in SQLite; skip it when nothing changes meaningfully.
    if (now - row.last_seen_at > 30_000) this.sql.exec('UPDATE sessions SET last_seen_at = ? WHERE hash = ?', now, hash)
    return { valid: true, fresh: row.reauth_at !== null && row.reauth_at >= now - REAUTH_WINDOW_MS }
  }

  async markReauth(hash: string): Promise<void> {
    this.sql.exec('UPDATE sessions SET reauth_at = ?, last_seen_at = ? WHERE hash = ?', Date.now(), Date.now(), hash)
  }

  async deleteSession(hash: string): Promise<void> {
    this.sql.exec('DELETE FROM sessions WHERE hash = ?', hash)
  }

  async deleteAllSessions(): Promise<void> {
    this.sql.exec('DELETE FROM sessions')
  }

  // --- rate limits and meter --------------------------------------------------

  /** Fixed-window counter. Returns false once `max` events happened in the current window. */
  async hit(key: string, max: number, windowSeconds: number): Promise<boolean> {
    return this.hitSync(key, max, windowSeconds)
  }

  private hitSync(key: string, max: number, windowSeconds: number): boolean {
    const now = Date.now()
    const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds
    if (Math.random() < 0.02) this.sql.exec('DELETE FROM rate WHERE window_start < ?', Math.floor(now / 1000) - 86_400)
    const row = this.sql.exec<{ count: number }>('SELECT count FROM rate WHERE key = ? AND window_start = ?', key, windowStart).toArray()[0]
    const count = (row?.count ?? 0) + 1
    if (count > max) return false
    this.sql.exec('INSERT INTO rate (key, window_start, count) VALUES (?, ?, ?) ON CONFLICT (key, window_start) DO UPDATE SET count = excluded.count', key, windowStart, count)
    return true
  }

  async meterAdd(delta: { worker: number; durable: number; kv: number }, at = Date.now()): Promise<void> {
    const day = utcDay(at)
    // The call that delivers the delta is itself a Durable Object request.
    this.sql.exec(
      'INSERT INTO meter (day, worker, durable, kv) VALUES (?, ?, ?, ?) ON CONFLICT (day) DO UPDATE SET worker = worker + excluded.worker, durable = durable + excluded.durable, kv = kv + excluded.kv',
      day, delta.worker, delta.durable + 1, delta.kv,
    )
    this.sql.exec('DELETE FROM meter WHERE day < ?', utcDay(at - 14 * 86_400_000))
  }

  async meterToday(at = Date.now()): Promise<MeterTotals> {
    const day = utcDay(at)
    const row = this.sql.exec<{ worker: number; durable: number; kv: number }>('SELECT worker, durable, kv FROM meter WHERE day = ?', day).toArray()[0]
    return { day, workerRequests: row?.worker ?? 0, durableObjectRequests: row?.durable ?? 0, kvWrites: row?.kv ?? 0 }
  }

  // --- pairing --------------------------------------------------------------

  /**
   * Start a pairing. Pending pairings are capped per source (3) and overall
   * (100). Past 20 pending, pairings whose host stopped polling for 30 s are
   * dropped first, so a burst of abandoned requests cannot block a real host
   * that keeps polling.
   */
  async pairStart(request: PairStartRequest, source = 'unknown'): Promise<{ pairingId: string; userCode: string; expiresAt: number }> {
    const now = Date.now()
    const sourceKey = (await sha256Hex(`remora-pair-source/v1\n${source}`)).slice(0, 32)
    this.sql.exec('DELETE FROM pairings WHERE expires_at < ?', now - PAIRING_TTL_MS)
    const pendingCount = () => this.count("SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending' AND expires_at > ?", now)
    if (this.count("SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending' AND expires_at > ? AND source = ?", now, sourceKey) >= PAIRING_MAX_PER_SOURCE) throw new Error('too many pending pairings from this source')
    if (pendingCount() >= PAIRING_SOFT_CAP) {
      this.sql.exec("UPDATE pairings SET expires_at = ? WHERE status = 'pending' AND COALESCE(last_seen_at, created_at) < ?", now - 1, now - PAIRING_IDLE_MS)
    }
    if (pendingCount() >= PAIRING_HARD_CAP) throw new Error('too many pending pairings')
    const pairingId = `p_${randomToken(24)}`
    let userCode = randomCode(USER_CODE_ALPHABET, 8)
    while (this.count('SELECT COUNT(*) AS n FROM pairings WHERE user_code = ?', userCode) > 0) userCode = randomCode(USER_CODE_ALPHABET, 8)
    const expiresAt = now + PAIRING_TTL_MS
    this.sql.exec(
      "INSERT INTO pairings (pairing_id, user_code, public_key, name, plugin_version, protocol, created_at, expires_at, status, source, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      pairingId, userCode, request.publicKey, request.name, request.pluginVersion, request.protocol, now, expiresAt, sourceKey, now,
    )
    return { pairingId, userCode, expiresAt }
  }

  /**
   * One poll from a pairing host. The signature over `pairPollMessage`
   * proves the poller holds the key that started the pairing, so a leaked
   * pairingId alone never yields the hostId.
   */
  async pairPoll(pairingId: string, signature: string, origin: string): Promise<PairPollResponse | { status: 'invalid' }> {
    const row = this.sql.exec<{ public_key: string; status: string; expires_at: number; host_id: string | null }>('SELECT public_key, status, expires_at, host_id FROM pairings WHERE pairing_id = ?', pairingId).toArray()[0]
    if (!row) return { status: 'expired' }
    if (!(await verifyEd25519(row.public_key, pairPollMessage(origin, pairingId), signature))) return { status: 'invalid' }
    this.sql.exec('UPDATE pairings SET last_seen_at = ? WHERE pairing_id = ?', Date.now(), pairingId)
    if (row.status === 'denied') return { status: 'denied' }
    if (row.status === 'approved' && row.host_id) return { status: 'approved', hostId: row.host_id, hubOrigin: origin, rpId: new URL(origin).hostname, owner: await this.ownerCredentials() }
    if (row.expires_at < Date.now()) return { status: 'expired' }
    return { status: 'pending' }
  }

  async pairLookup(userCode: string): Promise<PairingInfo | null> {
    const row = this.sql.exec<{ pairing_id: string; user_code: string; public_key: string; name: string; plugin_version: string; created_at: number; expires_at: number; status: string }>(
      'SELECT pairing_id, user_code, public_key, name, plugin_version, created_at, expires_at, status FROM pairings WHERE user_code = ?', userCode,
    ).toArray()[0]
    if (!row || row.expires_at < Date.now()) return null
    return {
      pairingId: row.pairing_id,
      userCode: row.user_code,
      name: row.name,
      pluginVersion: row.plugin_version,
      publicKeyFingerprint: (await sha256Hex(row.public_key)).slice(0, 16),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status: row.status as PairingInfo['status'],
    }
  }

  /** Approve or deny a pending pairing. On approval the host is created and returned. */
  async pairDecide(userCode: string, approve: boolean, hostId: string): Promise<HostRecord | null> {
    const row = this.sql.exec<{ pairing_id: string; public_key: string; name: string; status: string; expires_at: number }>(
      'SELECT pairing_id, public_key, name, status, expires_at FROM pairings WHERE user_code = ?', userCode,
    ).toArray()[0]
    if (!row || row.status !== 'pending' || row.expires_at < Date.now()) return null
    if (!approve) {
      this.sql.exec("UPDATE pairings SET status = 'denied' WHERE pairing_id = ?", row.pairing_id)
      await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'host.pair', hostId: null, outcome: 'denied', layer: null, reason: 'owner-denied' })
      return null
    }
    const host: HostRecord = { hostId, name: row.name, publicKey: row.public_key, pairedAt: Date.now(), revokedAt: null }
    this.sql.exec('INSERT INTO hosts (host_id, name, public_key, paired_at) VALUES (?, ?, ?, ?)', host.hostId, host.name, host.publicKey, host.pairedAt)
    this.sql.exec("UPDATE pairings SET status = 'approved', host_id = ?, expires_at = ? WHERE pairing_id = ?", hostId, Date.now() + PAIRING_POLL_INTERVAL_MS * 100, row.pairing_id)
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'host.pair', hostId, outcome: 'ok', layer: null, reason: null })
    return host
  }

  // --- hosts ------------------------------------------------------------------

  async listHosts(includeRevoked = false): Promise<HostRecord[]> {
    const rows = this.sql.exec<{ host_id: string; name: string; public_key: string; paired_at: number; revoked_at: number | null }>(
      includeRevoked ? 'SELECT * FROM hosts ORDER BY paired_at' : 'SELECT * FROM hosts WHERE revoked_at IS NULL ORDER BY paired_at',
    ).toArray()
    return rows.map(row => ({ hostId: row.host_id, name: row.name, publicKey: row.public_key, pairedAt: row.paired_at, revokedAt: row.revoked_at }))
  }

  async getHost(hostId: string): Promise<HostRecord | null> {
    return (await this.listHosts(true)).find(host => host.hostId === hostId) ?? null
  }

  async revokeHost(hostId: string, by: 'owner' | 'host' = 'owner'): Promise<boolean> {
    const changed = this.sql.exec('UPDATE hosts SET revoked_at = ? WHERE host_id = ? AND revoked_at IS NULL', Date.now(), hostId).rowsWritten > 0
    if (changed) {
      this.sql.exec('DELETE FROM grants WHERE host_id = ?', hostId)
      await this.audit(by === 'host'
        ? { actor: 'host', actorName: 'DSH ホスト', operation: 'host.unpair', hostId, outcome: 'ok', layer: null, reason: null }
        : { actor: 'owner', actorName: 'オーナー', operation: 'host.revoke', hostId, outcome: 'ok', layer: null, reason: null })
    }
    return changed
  }

  // --- clients and grants ---------------------------------------------------------

  async upsertClient(client: Pick<ClientRecord, 'clientId' | 'name' | 'kind' | 'domain' | 'redirectHost'>): Promise<void> {
    const now = Date.now()
    this.sql.exec(
      `INSERT INTO clients (client_id, name, kind, domain, redirect_host, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (client_id) DO UPDATE SET name = excluded.name, kind = excluded.kind, domain = excluded.domain, redirect_host = excluded.redirect_host, revoked_at = NULL`,
      client.clientId, client.name, client.kind, client.domain, client.redirectHost, now, now,
    )
    await this.audit({ actor: client.clientId, actorName: client.name, operation: 'client.authorize', hostId: null, outcome: 'ok', layer: null, reason: null })
  }

  async getClient(clientId: string): Promise<ClientRecord | null> {
    const row = this.sql.exec<ClientRow>('SELECT * FROM clients WHERE client_id = ?', clientId).toArray()[0]
    return row ? clientFromRow(row) : null
  }

  async listClients(): Promise<ClientWithGrants[]> {
    const clients = this.sql.exec<ClientRow>('SELECT * FROM clients ORDER BY revoked_at IS NOT NULL, created_at DESC').toArray().map(clientFromRow)
    const grants = this.sql.exec<GrantRow>('SELECT * FROM grants').toArray().map(grantFromRow)
    return clients.map(client => ({ ...client, grants: grants.filter(grant => grant.clientId === client.clientId) }))
  }

  async revokeClient(clientId: string): Promise<void> {
    const now = Date.now()
    this.sql.exec('UPDATE clients SET revoked_at = ? WHERE client_id = ?', now, clientId)
    if (clientId.startsWith('pat:')) this.sql.exec('UPDATE pats SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), clientId.slice(4))
    const approvals = this.sql.exec<{ id: string }>("SELECT id FROM approvals WHERE client_id = ? AND state IN ('pending', 'done')", clientId).toArray()
    this.sql.exec("UPDATE approvals SET state = 'denied', decided_at = ?, updated_at = ? WHERE client_id = ? AND state IN ('pending', 'done')", now, now, clientId)
    for (const { id } of approvals) this.wakeApproval(id)
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'client.revoke', hostId: null, outcome: 'ok', layer: null, reason: clientId })
  }

  /**
   * Set the hub-side grant of a client on a host. `ceilingLevel` is the
   * host's reported ceiling; the hub can only narrow it.
   */
  async setGrant(clientId: string, hostId: string, level: GrantLevel, ceilingLevel: 'view' | 'request' | 'full' | null): Promise<{ ok: boolean; reason?: string }> {
    const rank: Record<GrantLevel, number> = { none: -1, view: 0, request: 1, full: 2 }
    if (level !== 'none' && level !== 'view') {
      if (ceilingLevel === null) return { ok: false, reason: 'ceiling-unknown' }
      if (rank[level] > rank[ceilingLevel]) return { ok: false, reason: 'above-ceiling' }
    }
    const expires = level === 'full' ? Date.now() + FULL_ACCESS_MS : null
    this.sql.exec(
      `INSERT INTO grants (client_id, host_id, level, overrides, full_access_expires_at) VALUES (?, ?, ?, '{}', ?)
       ON CONFLICT (client_id, host_id) DO UPDATE SET level = excluded.level, full_access_expires_at = excluded.full_access_expires_at`,
      clientId, hostId, level, expires,
    )
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: `grant.set.${level}`, hostId, outcome: 'ok', layer: null, reason: clientId })
    return { ok: true }
  }

  /**
   * Everything the Worker needs before relaying a call from a client: the
   * client's status, the paired hosts and its grant on each, with the
   * per-client rate limit applied in the same round trip.
   */
  async callContext(clientId: string, rate?: { max: number; windowSeconds: number }): Promise<CallContext> {
    const hosts = (await this.listHosts()).map(host => ({ hostId: host.hostId, name: host.name }))
    const client = this.sql.exec<{ revoked_at: number | null; last_used_at: number | null }>('SELECT revoked_at, last_used_at FROM clients WHERE client_id = ?', clientId).toArray()[0]
    if (client?.revoked_at) return { ok: false, error: 'revoked', hosts, grants: {} }
    if (rate && !this.hitSync(`api:${clientId}`, rate.max, rate.windowSeconds)) return { ok: false, error: 'rate_limited', hosts, grants: {} }
    const now = Date.now()
    if (client && (client.last_used_at ?? 0) < now - 60_000) this.sql.exec('UPDATE clients SET last_used_at = ? WHERE client_id = ?', now, clientId)
    const settings = this.sql.exec<GrantRow>('SELECT * FROM grants WHERE client_id = ?', clientId).toArray().map(grantFromRow)
    const grants: Record<string, Grant | null> = {}
    for (const host of hosts) grants[host.hostId] = toProtocolGrant(settings.find(setting => setting.hostId === host.hostId))
    return { ok: true, hosts, grants }
  }

  /** A client's current standing on one host, read when a parked task is finally delivered. */
  async clientStanding(clientId: string, hostId: string): Promise<{ revoked: boolean; grant: Grant | null }> {
    const client = this.sql.exec<{ revoked_at: number | null }>('SELECT revoked_at FROM clients WHERE client_id = ?', clientId).toArray()[0]
    if (client?.revoked_at) return { revoked: true, grant: null }
    const host = this.sql.exec<{ revoked_at: number | null }>('SELECT revoked_at FROM hosts WHERE host_id = ?', hostId).toArray()[0]
    if (!host || host.revoked_at) return { revoked: false, grant: null }
    const setting = this.sql.exec<GrantRow>('SELECT * FROM grants WHERE client_id = ? AND host_id = ?', clientId, hostId).toArray().map(grantFromRow)[0]
    return { revoked: false, grant: toProtocolGrant(setting) }
  }

  // --- personal tokens ---------------------------------------------------------

  async createPersonalToken(name: string, scopes: string[], ttlMs: number): Promise<{ token: string; record: PersonalTokenRecord }> {
    const id = base32(randomBytes(8)).slice(0, 12)
    const secret = randomToken(32)
    const token = `rmr_pat_${id}_${secret}`
    const now = Date.now()
    const record: PersonalTokenRecord = { id, name, scopes, createdAt: now, expiresAt: now + ttlMs, lastUsedAt: null, revokedAt: null }
    this.sql.exec('INSERT INTO pats (id, hash, name, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', id, await sha256Hex(token), name, JSON.stringify(scopes), now, record.expiresAt)
    this.sql.exec(
      `INSERT INTO clients (client_id, name, kind, created_at) VALUES (?, ?, 'pat', ?) ON CONFLICT (client_id) DO NOTHING`,
      `pat:${id}`, `個人トークン: ${name}`, now,
    )
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'pat.create', hostId: null, outcome: 'ok', layer: null, reason: `pat:${id}` })
    return { token, record }
  }

  async validatePersonalToken(token: string): Promise<PersonalTokenRecord | null> {
    const row = this.sql.exec<{ id: string; name: string; scopes: string; created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null }>(
      'SELECT * FROM pats WHERE hash = ?', await sha256Hex(token),
    ).toArray()[0]
    if (!row || row.revoked_at !== null || row.expires_at < Date.now()) return null
    if ((row.last_used_at ?? 0) < Date.now() - 60_000) this.sql.exec('UPDATE pats SET last_used_at = ? WHERE id = ?', Date.now(), row.id)
    return { id: row.id, name: row.name, scopes: parseJson<string[]>(row.scopes, []), createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at }
  }

  async listPersonalTokens(): Promise<PersonalTokenRecord[]> {
    return this.sql.exec<{ id: string; name: string; scopes: string; created_at: number; expires_at: number; last_used_at: number | null; revoked_at: number | null }>('SELECT * FROM pats ORDER BY created_at DESC')
      .toArray()
      .map(row => ({ id: row.id, name: row.name, scopes: parseJson<string[]>(row.scopes, []), createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at }))
  }

  async revokePersonalToken(id: string): Promise<void> {
    await this.revokeClient(`pat:${id}`)
  }

  // --- device authorization (RFC 8628) -------------------------------------------

  async deviceStart(input: { clientId: string; scope: string[]; resource: string }): Promise<{ deviceCode: string; userCode: string; expiresAt: number; interval: number }> {
    const now = Date.now()
    this.sql.exec('DELETE FROM device_codes WHERE expires_at < ?', now - DEVICE_CODE_TTL_MS)
    const deviceCode = randomToken(32)
    let userCode = randomCode(USER_CODE_ALPHABET, 8)
    while (this.count('SELECT COUNT(*) AS n FROM device_codes WHERE user_code = ?', userCode) > 0) userCode = randomCode(USER_CODE_ALPHABET, 8)
    const expiresAt = now + DEVICE_CODE_TTL_MS
    this.sql.exec(
      "INSERT INTO device_codes (hash, user_code, client_id, scope, resource, created_at, expires_at, interval_s, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
      await sha256Hex(deviceCode), userCode, input.clientId, JSON.stringify(input.scope), input.resource, now, expiresAt, DEVICE_POLL_INTERVAL_S,
    )
    return { deviceCode, userCode, expiresAt, interval: DEVICE_POLL_INTERVAL_S }
  }

  async deviceLookup(userCode: string): Promise<DeviceInfo | null> {
    const row = this.sql.exec<{ user_code: string; client_id: string; scope: string; resource: string; created_at: number; expires_at: number; status: string }>(
      'SELECT user_code, client_id, scope, resource, created_at, expires_at, status FROM device_codes WHERE user_code = ?', userCode,
    ).toArray()[0]
    if (!row || row.expires_at < Date.now()) return null
    return { userCode: row.user_code, clientId: row.client_id, scope: parseJson<string[]>(row.scope, []), resource: row.resource, createdAt: row.created_at, expiresAt: row.expires_at, status: row.status as DeviceInfo['status'] }
  }

  /** Record the owner's decision. On approval the Worker has already minted an authorization code. */
  async deviceDecide(userCode: string, decision: { approve: false } | { approve: true; authCode: string; codeVerifier: string; redirectUri: string }): Promise<boolean> {
    const row = this.sql.exec<{ hash: string; status: string; expires_at: number }>('SELECT hash, status, expires_at FROM device_codes WHERE user_code = ?', userCode).toArray()[0]
    if (!row || row.status !== 'pending' || row.expires_at < Date.now()) return false
    if (decision.approve) {
      this.sql.exec("UPDATE device_codes SET status = 'approved', auth_code = ?, code_verifier = ?, redirect_uri = ? WHERE hash = ?", decision.authCode, decision.codeVerifier, decision.redirectUri, row.hash)
    } else {
      this.sql.exec("UPDATE device_codes SET status = 'denied' WHERE hash = ?", row.hash)
    }
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'device.authorize', hostId: null, outcome: decision.approve ? 'ok' : 'denied', layer: null, reason: decision.approve ? null : 'owner-denied' })
    return true
  }

  /** One poll by the device. An approved code is handed out once and then forgotten. */
  async devicePoll(deviceCode: string, clientId: string): Promise<DevicePoll> {
    const hash = await sha256Hex(deviceCode)
    const row = this.sql.exec<{ client_id: string; resource: string; expires_at: number; interval_s: number; last_poll_at: number | null; status: string; auth_code: string | null; code_verifier: string | null; redirect_uri: string | null }>(
      'SELECT client_id, resource, expires_at, interval_s, last_poll_at, status, auth_code, code_verifier, redirect_uri FROM device_codes WHERE hash = ?', hash,
    ).toArray()[0]
    if (!row || row.client_id !== clientId) return { status: 'invalid' }
    const now = Date.now()
    if (row.expires_at < now) {
      this.sql.exec('DELETE FROM device_codes WHERE hash = ?', hash)
      return { status: 'expired' }
    }
    if (row.status === 'denied') {
      this.sql.exec('DELETE FROM device_codes WHERE hash = ?', hash)
      return { status: 'denied' }
    }
    if (row.status === 'approved' && row.auth_code && row.code_verifier && row.redirect_uri) {
      this.sql.exec('DELETE FROM device_codes WHERE hash = ?', hash)
      return { status: 'approved', authCode: row.auth_code, codeVerifier: row.code_verifier, redirectUri: row.redirect_uri, resource: row.resource, clientId: row.client_id }
    }
    const tooSoon = row.last_poll_at !== null && now - row.last_poll_at < row.interval_s * 1000 - 500
    if (tooSoon) {
      this.sql.exec('UPDATE device_codes SET interval_s = interval_s + 5, last_poll_at = ? WHERE hash = ?', now, hash)
      return { status: 'slow_down' }
    }
    this.sql.exec('UPDATE device_codes SET last_poll_at = ? WHERE hash = ?', now, hash)
    return { status: 'pending' }
  }

  // --- Web Push -----------------------------------------------------------------

  private async vapidKeys(): Promise<VapidKeys> {
    const stored = parseJson<VapidKeys | null>(this.meta('vapid_keys'), null)
    if (stored) return stored
    const keys = await generateVapidKeys()
    this.setMeta('vapid_keys', JSON.stringify(keys))
    return keys
  }

  /** The applicationServerKey browsers subscribe with. Generated once. */
  async vapidPublicKey(): Promise<string> {
    return (await this.vapidKeys()).publicKey
  }

  /** Store a device's subscription (one per endpoint); re-subscribing updates its keys. */
  async pushSubscribe(input: { endpoint: string; p256dh: string; auth: string; label: string }): Promise<{ id: string } | { error: string }> {
    const existing = this.sql.exec<{ id: string }>('SELECT id FROM push_subscriptions WHERE endpoint = ?', input.endpoint).toArray()[0]
    if (existing) {
      this.sql.exec('UPDATE push_subscriptions SET p256dh = ?, auth = ?, label = ?, last_error = NULL WHERE id = ?', input.p256dh, input.auth, input.label, existing.id)
      return { id: existing.id }
    }
    if (this.count('SELECT COUNT(*) AS n FROM push_subscriptions') >= PUSH_MAX_DEVICES) return { error: 'too-many-devices' }
    const id = base32(randomBytes(10))
    this.sql.exec(
      'INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, label, types, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, input.endpoint, input.p256dh, input.auth, input.label, JSON.stringify(PUSH_TYPES), Date.now(),
    )
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'push.subscribe', hostId: null, outcome: 'ok', layer: null, reason: null })
    return { id }
  }

  async pushUnsubscribe(by: { id?: string; endpoint?: string }): Promise<boolean> {
    const removed = by.id !== undefined
      ? this.sql.exec('DELETE FROM push_subscriptions WHERE id = ?', by.id).rowsWritten
      : this.sql.exec('DELETE FROM push_subscriptions WHERE endpoint = ?', by.endpoint ?? '').rowsWritten
    if (removed > 0) await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'push.remove', hostId: null, outcome: 'ok', layer: null, reason: null })
    return removed > 0
  }

  async pushSetTypes(id: string, types: PushType[]): Promise<void> {
    const allowed = types.filter(type => PUSH_TYPES.includes(type))
    this.sql.exec('UPDATE push_subscriptions SET types = ? WHERE id = ?', JSON.stringify(allowed), id)
  }

  async listPushDevices(): Promise<PushDevice[]> {
    return this.sql.exec<{ id: string; endpoint: string; label: string; types: string; created_at: number; last_sent_at: number | null; last_error: string | null }>('SELECT id, endpoint, label, types, created_at, last_sent_at, last_error FROM push_subscriptions ORDER BY created_at')
      .toArray()
      .map(row => ({ id: row.id, endpoint: row.endpoint, label: row.label, types: parseJson<PushType[]>(row.types, []), createdAt: row.created_at, lastSentAt: row.last_sent_at, lastError: row.last_error }))
  }

  /**
   * Send one notification per device for a batch of events (one batch per
   * host frame or hub action), honouring each device's switches and a
   * per-device rate limit. Outbound only: 404/410 drop the subscription.
   */
  async notify(events: PushEvent[], origin: string | null): Promise<PushOutcome> {
    const outcome: PushOutcome = { sent: 0, dropped: 0, removed: 0, failed: 0 }
    // The call that delivered this batch is itself a Durable Object request.
    await this.meterAdd({ worker: 0, durable: 0, kv: 0 })
    if (events.length === 0) return outcome
    const rows = this.sql.exec<{ id: string; endpoint: string; p256dh: string; auth: string; types: string }>('SELECT id, endpoint, p256dh, auth, types FROM push_subscriptions').toArray()
    if (rows.length === 0) return outcome
    const keys = await this.vapidKeys()
    const subject = origin && origin.startsWith('https://') ? origin : 'mailto:remora-hub@localhost'
    const [max, window] = PUSH_RATE
    await Promise.all(rows.map(async row => {
      const types = parseJson<string[]>(row.types, [])
      const wanted = events.filter(event => event.type === 'test' || types.includes(event.type))
      if (wanted.length === 0) return
      if (!this.hitSync(`push:${row.id}`, max, window)) {
        outcome.dropped++
        return
      }
      const first = wanted[0] as PushEvent
      const payload = {
        v: 1,
        kind: first.kind,
        host: first.host,
        title: first.title,
        url: wanted.length > 1 ? (wanted.some(event => event.type === 'attention') ? '/attention' : '/') : first.url,
        count: wanted.length,
        ...(typeof first.expiresAt === 'number' ? { expiresAt: first.expiresAt } : {}),
        tag: wanted.length > 1 ? 'remora-batch' : `${first.kind}:${first.hostId ?? ''}:${first.url}`,
      }
      const urgent = wanted.some(event => event.type === 'attention')
      const ttl = urgent
        ? Math.max(60, Math.min(3600, Math.floor(((typeof first.expiresAt === 'number' ? first.expiresAt : Date.now() + 3_600_000) - Date.now()) / 1000)))
        : first.type === 'hosts' ? 3600 : 86_400
      try {
        const request = await buildPushRequest(row, payload, keys, subject, {
          ttl,
          urgency: urgent ? 'high' : 'normal',
          ...(first.type === 'hosts' && wanted.length === 1 && first.hostId ? { topic: `host${first.hostId}`.slice(0, 32) } : {}),
        })
        const response = await fetch(request, { signal: AbortSignal.timeout(10_000) })
        if (response.status === 404 || response.status === 410) {
          this.sql.exec('DELETE FROM push_subscriptions WHERE id = ?', row.id)
          outcome.removed++
          await this.audit({ actor: 'hub', actorName: 'ハブ', operation: 'push.expired', hostId: null, outcome: 'ok', layer: null, reason: String(response.status) })
        } else if (response.ok) {
          this.sql.exec('UPDATE push_subscriptions SET last_sent_at = ?, last_error = NULL WHERE id = ?', Date.now(), row.id)
          outcome.sent++
        } else {
          this.sql.exec('UPDATE push_subscriptions SET last_error = ? WHERE id = ?', `HTTP ${response.status}`, row.id)
          outcome.failed++
        }
      } catch (error) {
        this.sql.exec('UPDATE push_subscriptions SET last_error = ? WHERE id = ?', error instanceof Error ? error.message.slice(0, 120) : 'error', row.id)
        outcome.failed++
      }
    }))
    return outcome
  }

  // --- hub maintenance parked for the owner (OWNER_APPROVED_OPERATIONS) ------------

  private readonly approvalWaiters = new Map<string, Set<() => void>>()

  private approvalRow(id: string): ApprovalRecord | null {
    const row = this.sql.exec<{ id: string; client_id: string; client_name: string; op: string; state: string; created_at: number; expires_at: number; decided_at: number | null }>(
      'SELECT id, client_id, client_name, op, state, created_at, expires_at, decided_at FROM approvals WHERE id = ?', id,
    ).toArray()[0]
    return row ? { id: row.id, clientId: row.client_id, clientName: row.client_name, operation: row.op, state: row.state as ConfirmationState, createdAt: row.created_at, expiresAt: row.expires_at, decidedAt: row.decided_at } : null
  }

  /** Pending past their deadline → expired; old settled rows are dropped. */
  private settleApprovals(now = Date.now()): void {
    const overdue = this.sql.exec<{ id: string }>("SELECT id FROM approvals WHERE state = 'pending' AND expires_at <= ?", now).toArray()
    for (const { id } of overdue) {
      this.sql.exec("UPDATE approvals SET state = 'expired', updated_at = ? WHERE id = ?", now, id)
      this.wakeApproval(id)
    }
    this.sql.exec("DELETE FROM approvals WHERE state != 'pending' AND updated_at < ?", now - 7 * 24 * 60 * 60_000)
  }

  private wakeApproval(id: string): void {
    for (const wake of this.approvalWaiters.get(id) ?? []) wake()
    this.approvalWaiters.delete(id)
  }

  /** Park a client's call. Refuses when the client already has too many waiting. */
  async requestApproval(clientId: string, clientName: string, operation: string, origin: string | null): Promise<ApprovalRecord | { error: 'too_many' }> {
    const now = Date.now()
    this.settleApprovals(now)
    if (this.count("SELECT COUNT(*) AS n FROM approvals WHERE state = 'pending' AND client_id = ?", clientId) >= APPROVALS_PENDING_PER_CLIENT) return { error: 'too_many' }
    const id = `${HUB_CONFIRMATION_PREFIX}${base32(randomBytes(10))}`
    this.sql.exec(
      "INSERT INTO approvals (id, client_id, client_name, op, state, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
      id, clientId, clientName.slice(0, 200), operation, now, now + CONFIRMATION_REQUEST_TTL_MS, now,
    )
    await this.audit({ actor: clientId, actorName: clientName, operation: `${operation}.requested`, hostId: null, outcome: 'ok', layer: null, reason: null })
    const what = operation === 'audit.export' ? '監査ログの書き出し' : operation === 'hub.export' ? 'ハブ設定の書き出し' : operation
    this.ctx.waitUntil(this.notify([{ type: 'attention', kind: 'confirmation', hostId: null, host: 'ハブ', title: `${clientName.slice(0, 40)}: ${what}`, url: `/confirm/hub/${id}`, expiresAt: now + CONFIRMATION_REQUEST_TTL_MS }], origin).catch(() => undefined))
    return this.approvalRow(id) as ApprovalRecord
  }

  /** One request; with `clientId`, only that client's own. Waits up to `timeoutMs` while it is pending. */
  async approvalFor(id: string, clientId?: string, timeoutMs = 0): Promise<ApprovalRecord | null> {
    this.settleApprovals()
    const visible = (row: ApprovalRecord | null) => (row && (clientId === undefined || row.clientId === clientId) ? row : null)
    const row = visible(this.approvalRow(id))
    if (!row || row.state !== 'pending' || timeoutMs <= 0) return row
    const wait = Math.min(TASK_WAIT_MAX_MS, timeoutMs, Math.max(0, row.expiresAt - Date.now()) + 50)
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.approvalWaiters.get(id)?.delete(wake)
        resolve()
      }, wait)
      const wake = () => {
        clearTimeout(timer)
        resolve()
      }
      const set = this.approvalWaiters.get(id) ?? new Set()
      set.add(wake)
      this.approvalWaiters.set(id, set)
    })
    this.settleApprovals()
    return visible(this.approvalRow(id))
  }

  /** Count one delivery of an approved request's result. False once it is spent or too old. */
  async claimApprovalResult(id: string, clientId: string): Promise<boolean> {
    if (this.sql.exec<{ revoked_at: number | null }>('SELECT revoked_at FROM clients WHERE client_id = ?', clientId).toArray()[0]?.revoked_at != null) return false
    const row = this.sql.exec<{ state: string; decided_at: number | null; fetches: number; client_id: string }>('SELECT state, decided_at, fetches, client_id FROM approvals WHERE id = ?', id).toArray()[0]
    if (!row || row.client_id !== clientId || row.state !== 'done' || row.decided_at === null) return false
    if (Date.now() - row.decided_at >= APPROVAL_RESULT_MS || row.fetches >= APPROVAL_RESULT_FETCHES) return false
    this.sql.exec('UPDATE approvals SET fetches = fetches + 1 WHERE id = ?', id)
    return true
  }

  async pendingApprovals(): Promise<ApprovalRecord[]> {
    this.settleApprovals()
    return this.sql.exec<{ id: string }>("SELECT id FROM approvals WHERE state = 'pending' ORDER BY created_at").toArray().map(({ id }) => this.approvalRow(id) as ApprovalRecord)
  }

  /** The owner approved (after a passkey re-authentication) or refused. False when it is no longer pending. */
  async decideApproval(id: string, approve: boolean): Promise<boolean> {
    this.settleApprovals()
    const row = this.approvalRow(id)
    if (!row || row.state !== 'pending') return false
    if (approve && this.sql.exec<{ revoked_at: number | null }>('SELECT revoked_at FROM clients WHERE client_id = ?', row.clientId).toArray()[0]?.revoked_at != null) return false
    const now = Date.now()
    this.sql.exec('UPDATE approvals SET state = ?, decided_at = ?, updated_at = ? WHERE id = ?', approve ? 'done' : 'denied', now, now, id)
    await this.audit({ actor: 'owner', actorName: 'オーナー', operation: `${row.operation}.${approve ? 'approved' : 'refused'}`, hostId: null, outcome: approve ? 'ok' : 'denied', layer: null, reason: row.clientId })
    this.wakeApproval(id)
    return true
  }

  /** Settings for hub.export: everything but secrets (no token values, endpoints or keys of devices, no recovery codes). */
  async exportSettings(): Promise<{
    allowOtherClients: boolean
    hosts: { hostId: string; name: string; publicKeyFingerprint: string; pairedAt: number; revokedAt: number | null }[]
    clients: { clientId: string; name: string; kind: string; createdAt: number; lastUsedAt: number | null; revokedAt: number | null; grants: { hostId: string; level: string; overrides: Record<string, boolean>; fullAccessExpiresAt: number | null }[] }[]
    personalTokens: PersonalTokenRecord[]
    passkeys: { credentialId: string; label: string; algorithm: number; createdAt: number; lastUsedAt: number | null }[]
    pushDevices: { label: string; types: string[]; createdAt: number; lastSentAt: number | null }[]
  }> {
    const state = await this.state()
    const hosts = await Promise.all((await this.listHosts(true)).map(async host => ({ hostId: host.hostId, name: host.name, publicKeyFingerprint: (await sha256Hex(host.publicKey)).slice(0, 16), pairedAt: host.pairedAt, revokedAt: host.revokedAt })))
    const clients = (await this.listClients()).map(client => ({
      clientId: client.clientId, name: client.name, kind: client.kind, createdAt: client.createdAt, lastUsedAt: client.lastUsedAt, revokedAt: client.revokedAt,
      grants: client.grants.map(grant => ({ hostId: grant.hostId, level: grant.level, overrides: { ...(grant.overrides ?? {}) } as Record<string, boolean>, fullAccessExpiresAt: grant.fullAccessExpiresAt })),
    }))
    const passkeys = (await this.listPasskeys()).map(passkey => ({ credentialId: passkey.credentialId, label: passkey.label, algorithm: passkey.algorithm, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt }))
    const pushDevices = (await this.listPushDevices()).map(device => ({ label: device.label, types: [...device.types], createdAt: device.createdAt, lastSentAt: device.lastSentAt }))
    return { allowOtherClients: state.allowOtherClients, hosts, clients, personalTokens: await this.listPersonalTokens(), passkeys, pushDevices }
  }

  /** A host proved a new key (host.rotate-key) and authenticated with it: it replaces the paired key. */
  async replaceHostKey(hostId: string, publicKey: string): Promise<boolean> {
    const row = this.sql.exec<{ revoked_at: number | null }>('SELECT revoked_at FROM hosts WHERE host_id = ?', hostId).toArray()[0]
    if (!row || row.revoked_at !== null) return false
    this.sql.exec('UPDATE hosts SET public_key = ? WHERE host_id = ?', publicKey, hostId)
    await this.audit({ actor: 'host', actorName: 'ホスト', operation: 'host.key-rotated', hostId, outcome: 'ok', layer: null, reason: (await sha256Hex(publicKey)).slice(0, 16) })
    return true
  }

  // --- audit --------------------------------------------------------------------

  async audit(entry: Omit<AuditEntry, 'at'> & { at?: number }): Promise<void> {
    await appendAudit(this.sql, { ...entry, at: entry.at ?? Date.now() })
  }

  async listAudit(limit = 200): Promise<AuditRow[]> {
    return listAudit(this.sql, limit)
  }
}
