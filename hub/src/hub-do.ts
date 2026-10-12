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
import type { CallContext, ClientKind, ClientRecord, ClientWithGrants, DeviceInfo, DevicePoll, GrantLevel, GrantSetting, HostRecord, HubState, MeterTotals, OwnerCredential, PairingInfo, PasskeyRecord, PersonalTokenRecord } from './types.ts'
import { base32, parseJson, randomBytes, randomCode, randomToken, sha256Hex, utcDay, verifyEd25519 } from './util.ts'
import { PAIRING_POLL_INTERVAL_MS, PAIRING_TTL_MS, USER_CODE_ALPHABET, pairPollMessage, type Grant, type PairPollResponse, type PairStartRequest } from './vendor/protocol/index.ts'

export const HUB_OBJECT_NAME = 'hub'

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

  async pairStart(request: PairStartRequest): Promise<{ pairingId: string; userCode: string; expiresAt: number }> {
    const now = Date.now()
    this.sql.exec('DELETE FROM pairings WHERE expires_at < ?', now - PAIRING_TTL_MS)
    const pending = this.count("SELECT COUNT(*) AS n FROM pairings WHERE status = 'pending' AND expires_at > ?", now)
    if (pending >= 20) throw new Error('too many pending pairings')
    const pairingId = `p_${randomToken(24)}`
    let userCode = randomCode(USER_CODE_ALPHABET, 8)
    while (this.count('SELECT COUNT(*) AS n FROM pairings WHERE user_code = ?', userCode) > 0) userCode = randomCode(USER_CODE_ALPHABET, 8)
    const expiresAt = now + PAIRING_TTL_MS
    this.sql.exec(
      "INSERT INTO pairings (pairing_id, user_code, public_key, name, plugin_version, protocol, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
      pairingId, userCode, request.publicKey, request.name, request.pluginVersion, request.protocol, now, expiresAt,
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

  async revokeHost(hostId: string): Promise<boolean> {
    const changed = this.sql.exec('UPDATE hosts SET revoked_at = ? WHERE host_id = ? AND revoked_at IS NULL', Date.now(), hostId).rowsWritten > 0
    if (changed) {
      this.sql.exec('DELETE FROM grants WHERE host_id = ?', hostId)
      await this.audit({ actor: 'owner', actorName: 'オーナー', operation: 'host.revoke', hostId, outcome: 'ok', layer: null, reason: null })
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
    this.sql.exec('UPDATE clients SET revoked_at = ? WHERE client_id = ?', Date.now(), clientId)
    if (clientId.startsWith('pat:')) this.sql.exec('UPDATE pats SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', Date.now(), clientId.slice(4))
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
  async callContext(clientId: string, rate: { max: number; windowSeconds: number }): Promise<CallContext> {
    const hosts = (await this.listHosts()).map(host => ({ hostId: host.hostId, name: host.name }))
    const client = this.sql.exec<{ revoked_at: number | null; last_used_at: number | null }>('SELECT revoked_at, last_used_at FROM clients WHERE client_id = ?', clientId).toArray()[0]
    if (client?.revoked_at) return { ok: false, error: 'revoked', hosts, grants: {} }
    if (!this.hitSync(`api:${clientId}`, rate.max, rate.windowSeconds)) return { ok: false, error: 'rate_limited', hosts, grants: {} }
    const now = Date.now()
    if (client && (client.last_used_at ?? 0) < now - 60_000) this.sql.exec('UPDATE clients SET last_used_at = ? WHERE client_id = ?', now, clientId)
    const settings = this.sql.exec<GrantRow>('SELECT * FROM grants WHERE client_id = ?', clientId).toArray().map(grantFromRow)
    const grants: Record<string, Grant | null> = {}
    for (const host of hosts) grants[host.hostId] = toProtocolGrant(settings.find(setting => setting.hostId === host.hostId))
    return { ok: true, hosts, grants }
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

  // --- audit --------------------------------------------------------------------

  async audit(entry: Omit<AuditEntry, 'at'> & { at?: number }): Promise<void> {
    await appendAudit(this.sql, { ...entry, at: entry.at ?? Date.now() })
  }

  async listAudit(limit = 200): Promise<AuditRow[]> {
    return listAudit(this.sql, limit)
  }
}
