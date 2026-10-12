/**
 * One Durable Object per DSH host. It holds the host's outbound WebSocket
 * with the Hibernation API (the keepalive is answered by
 * `setWebSocketAutoResponse` without waking the object), relays requests
 * with deadlines, keeps the task ledger, caches the attention list and
 * writes the host's audit log.
 *
 * The plugin is the final authority on permissions; `decide()` runs here
 * only to fail early and to explain denials.
 */
import { stampHostId } from './stamp.ts'
import { DurableObject } from 'cloudflare:workers'
import { AUDIT_SCHEMA, appendAudit, listAudit, type AuditRow } from './audit.ts'
import { OWNER_CLIENT_ID, PARKED_TASK_TTL_MS, RELAY_TIMEOUT_MS } from './config.ts'
import { HUB_OBJECT_NAME } from './hub-do.ts'
import { newTaskId, parseJson, randomToken, verifyEd25519 } from './util.ts'
import {
  KEEPALIVE_PING, KEEPALIVE_PONG, TASK_WAIT_MAX_MS, TERMINAL_TASK_STATES, decide, fixFor, hostAuthMessage, isSupportedProtocol, parseHostFrame,
  type Actor, type AttentionItem, type Confirmation, type DenialLayer, type Grant, type HelloFrame, type HostEvent, type HubFrame, type RemoraError, type ResponseFrame,
  type TaskInfo, type TaskState,
} from './vendor/protocol/index.ts'

/** How long a host has to answer the challenge. */
const AUTH_WINDOW_MS = 60_000
/** Tasks and attention entries older than this are pruned. */
const RETENTION_MS = 7 * 24 * 60 * 60_000
/** Operations that create a ledger entry with a hub-assigned task id. */
const TASK_CREATING = new Set(['task.start', 'task.steer', 'task.resubmit'])
/** Error codes after which a failed task.start is forgotten, so the same key can be retried. */
const NON_STICKY_ERRORS = new Set(['denied', 'invalid_request', 'not_found', 'gone', 'conflict', 'rate_limited', 'protocol_mismatch'])

interface Attachment {
  stage: 'challenged' | 'hello' | 'ready'
  nonce: string
  issuedAt: number
  origin: string
  connectionId: string
  hello?: HelloFrame
}

export interface ExecuteCall {
  op: string
  params: Record<string, unknown>
  actor: Actor
  scopes: string[]
  grant: Grant
  /** Used as the request frame id; bound into passkey confirmations. */
  requestId?: string
  confirmation?: Confirmation
}

export type ExecuteResult = { ok: true; result: unknown } | { ok: false; error: RemoraError }

export interface HostLive {
  hostId: string
  /** The name approved at pairing. */
  name: string | null
  /** What the host calls itself in its hello, when it reported one. */
  reportedName: string | null
  online: boolean
  revoked: boolean
  lastSeenAt: number | null
  pluginVersion: string | null
  dshVersion: string | null
  operations: string[]
  ceiling: Grant | null
  killSwitch: boolean
  running: TaskInfo[]
  /** The latest finished tasks (completed, failed, cancelled), newest first. */
  recent: TaskInfo[]
  attention: AttentionItem[]
  duplicateConnections: number
  /** At least one task was ever started on this host through Remora. */
  hadTasks: boolean
}

type TaskRow = {
  task_id: string; client_id: string; idempotency_key: string; op: string; state: string; session_id: string | null; params: string | null;
  frame: string | null; delivered: number; delivery_id: string; created_at: number; updated_at: number; expires_at: number | null; error: string | null
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS info (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    op TEXT NOT NULL,
    state TEXT NOT NULL,
    session_id TEXT,
    params TEXT,
    frame TEXT,
    delivered INTEGER NOT NULL DEFAULT 0,
    delivery_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER,
    error TEXT,
    UNIQUE (client_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS tasks_delivery ON tasks (delivery_id);
  CREATE TABLE IF NOT EXISTS attention (session_id TEXT PRIMARY KEY, items TEXT NOT NULL, updated_at INTEGER NOT NULL);
  ${AUDIT_SCHEMA}
`

const send = (ws: WebSocket, frame: HubFrame) => {
  try {
    ws.send(JSON.stringify(frame))
  } catch {
    // The socket is already closing.
  }
}

const err = (code: RemoraError['code'], message: string, extra: Partial<RemoraError> = {}): RemoraError => ({ code, message, ...extra })

export class HostDO extends DurableObject<Env> {
  private readonly sql: SqlStorage
  private readonly pending = new Map<string, (frame: ResponseFrame | null) => void>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private messagesSinceFlush = 0
  /** Parked deliveries this instance has sent and not yet seen answered. */
  private readonly inFlight = new Set<string>()
  /**
   * The schema is created on provision(), not in the constructor, so a stub
   * for an id that was never paired leaves no storage behind.
   */
  private schemaReady = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG))
    ctx.blockConcurrencyWhile(async () => {
      this.schemaReady = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'info'").one().n > 0
      if (this.schemaReady) this.sql.exec(SCHEMA)
    })
  }

  private ensureSchema(): void {
    if (this.schemaReady) return
    this.sql.exec(SCHEMA)
    this.schemaReady = true
  }

  // --- small storage helpers ----------------------------------------------------

  private info(key: string): string | null {
    if (!this.schemaReady) return null
    return this.sql.exec<{ value: string }>('SELECT value FROM info WHERE key = ?', key).toArray()[0]?.value ?? null
  }

  private setInfo(key: string, value: string | null): void {
    this.ensureSchema()
    if (value === null) this.sql.exec('DELETE FROM info WHERE key = ?', key)
    else this.sql.exec('INSERT INTO info (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
  }

  private get hostId(): string | null {
    return this.info('host_id')
  }

  private ceiling(): Grant | null {
    return parseJson<Grant | null>(this.info('ceiling'), null)
  }

  private operations(): string[] | null {
    return parseJson<string[] | null>(this.info('operations'), null)
  }

  private hub() {
    return this.env.HUB.get(this.env.HUB.idFromName(HUB_OBJECT_NAME))
  }

  private readySockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter(ws => (ws.deserializeAttachment() as Attachment | null)?.stage === 'ready')
  }

  private async audit(actor: Actor | 'host', operation: string, outcome: 'ok' | 'denied' | 'error', detail: { layer?: DenialLayer | null; reason?: string | null } = {}): Promise<void> {
    await appendAudit(this.sql, {
      at: Date.now(),
      actor: actor === 'host' ? 'host' : actor.clientId,
      actorName: actor === 'host' ? 'DSH ホスト' : actor.clientName,
      operation,
      hostId: this.hostId,
      outcome,
      layer: detail.layer ?? null,
      reason: detail.reason ?? null,
    })
  }

  // --- provisioning (called by the Worker) ---------------------------------------------

  async provision(hostId: string, publicKey: string, name: string): Promise<void> {
    if (this.info('revoked') === '1') throw new Error('host was revoked')
    this.setInfo('host_id', hostId)
    this.setInfo('public_key', publicKey)
    this.setInfo('name', name)
  }

  async revoke(): Promise<void> {
    this.ensureSchema()
    this.setInfo('revoked', '1')
    this.setInfo('public_key', null)
    for (const ws of this.ctx.getWebSockets()) {
      send(ws, { t: 'close', reason: 'revoked' })
      ws.close(4003, 'revoked')
    }
    const now = Date.now()
    this.sql.exec(
      "UPDATE tasks SET state = 'failed', params = NULL, frame = NULL, error = ?, updated_at = ? WHERE state IN ('parked', 'accepted', 'running', 'needs_attention')",
      JSON.stringify(err('gone', 'The host was unpaired from the hub.')), now,
    )
    for (const [taskId] of this.waiters) this.notify(taskId)
    await this.audit('host', 'host.revoked', 'ok')
  }

  // --- WebSocket handshake ---------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 })
    const hostId = this.hostId
    if (!hostId || this.info('revoked') === '1' || !this.info('public_key')) return new Response('unknown host', { status: 404 })
    const origin = request.headers.get('x-remora-origin') ?? new URL(request.url).origin
    // Drop connections that never finished the handshake.
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment && attachment.stage !== 'ready' && attachment.issuedAt < now - AUTH_WINDOW_MS) ws.close(4001, 'handshake timed out')
    }
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    const attachment: Attachment = { stage: 'challenged', nonce: randomToken(24), issuedAt: now, origin, connectionId: `c_${randomToken(12)}` }
    server.serializeAttachment(attachment)
    send(server, { t: 'challenge', nonce: attachment.nonce, issuedAt: attachment.issuedAt, origin })
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.countMessage()
    if (typeof message !== 'string') { ws.close(1003, 'text frames only'); return }
    let frame
    try { frame = parseHostFrame(message) } catch { ws.close(1007, 'invalid frame'); return }
    const attachment = ws.deserializeAttachment() as Attachment
    switch (frame.t) {
      case 'hello': {
        if (!isSupportedProtocol(frame.protocol)) {
          send(ws, { t: 'close', reason: 'protocol_mismatch' })
          ws.close(4000, 'protocol mismatch')
          return
        }
        if (attachment.stage !== 'challenged' || frame.hostId !== this.hostId) {
          send(ws, { t: 'close', reason: 'auth_failed' })
          ws.close(4001, 'unexpected hello')
          return
        }
        ws.serializeAttachment({ ...attachment, stage: 'hello', hello: frame } satisfies Attachment)
        return
      }
      case 'auth': {
        const hostId = this.hostId
        const publicKey = this.info('public_key')
        const fresh = Date.now() - attachment.issuedAt <= AUTH_WINDOW_MS
        const ok = attachment.stage === 'hello' && hostId !== null && publicKey !== null && fresh && frame.nonce === attachment.nonce
          && (await verifyEd25519(publicKey, hostAuthMessage(attachment.origin, hostId, attachment.nonce, attachment.issuedAt), frame.signature))
        if (!ok || !attachment.hello) {
          send(ws, { t: 'close', reason: 'auth_failed' })
          ws.close(4001, fresh ? 'authentication failed' : 'challenge expired')
          await this.audit('host', 'host.connect', 'denied', { reason: fresh ? 'auth-failed' : 'stale-challenge' })
          return
        }
        await this.onAuthenticated(ws, attachment, attachment.hello)
        return
      }
      case 'response':
        if (attachment.stage !== 'ready') { ws.close(4001, 'not authenticated'); return }
        await this.onResponse(frame)
        return
      case 'event':
        if (attachment.stage !== 'ready') { ws.close(4001, 'not authenticated'); return }
        this.setInfo('last_seen_at', String(Date.now()))
        for (const event of frame.events as HostEvent[]) await this.onEvent(event)
        return
    }
  }

  private async onAuthenticated(ws: WebSocket, attachment: Attachment, hello: HelloFrame): Promise<void> {
    // One live connection per host: the newest wins and the older is told why.
    for (const other of this.readySockets()) {
      if (other === ws) continue
      send(other, { t: 'close', reason: 'duplicate_connection' })
      other.close(4002, 'duplicate connection')
      this.setInfo('duplicate_connections', String(Number(this.info('duplicate_connections') ?? '0') + 1))
      await this.audit('host', 'host.duplicate-connection', 'denied', { reason: 'older-connection-closed' })
    }
    ws.serializeAttachment({ ...attachment, stage: 'ready', hello: undefined } satisfies Attachment)
    const now = Date.now()
    // The approved name stays the display name; what the host calls itself is shown beside it.
    this.setInfo('reported_name', hello.name ? hello.name.slice(0, 80) : null)
    this.setInfo('plugin_version', hello.plugin?.version ?? '')
    this.setInfo('dsh_version', hello.dsh?.version ?? '')
    this.setInfo('operations', JSON.stringify(hello.operations))
    this.setInfo('ceiling', JSON.stringify(hello.ceiling))
    this.setInfo('kill_switch', hello.killSwitch ? '1' : '0')
    this.setInfo('protocol', String(hello.protocol))
    this.setInfo('last_seen_at', String(now))
    send(ws, { t: 'ready', connectionId: attachment.connectionId })
    try {
      send(ws, { t: 'owner-credentials', credentials: await this.hub().ownerCredentials() })
    } catch {
      // The plugin keeps its pinned credentials; it asks again on the next connection.
    }
    await this.audit('host', 'host.connect', 'ok')
    await this.deliverUndelivered(ws)
    await this.scheduleAlarm()
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closing')
    } catch {
      // already closed
    }
    if (this.readySockets().filter(other => other !== ws).length === 0) this.setInfo('last_seen_at', String(Date.now()))
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'error')
    } catch {
      // already closed
    }
  }

  private countMessage(): void {
    // Incoming WebSocket messages are billed at 20 per Durable Object request.
    this.messagesSinceFlush++
    if (this.messagesSinceFlush >= 200) {
      const durable = Math.round(this.messagesSinceFlush / 20)
      this.messagesSinceFlush = 0
      this.ctx.waitUntil(this.hub().meterAdd({ worker: 0, durable, kv: 0 }).catch(() => undefined))
    }
  }

  // --- events from the host ---------------------------------------------------------------

  private async onEvent(event: HostEvent): Promise<void> {
    switch (event.kind) {
      case 'task': {
        const now = Date.now()
        const changed = this.sql.exec(
          'UPDATE tasks SET state = ?, session_id = COALESCE(?, session_id), updated_at = ?, error = ?, delivered = 1, params = NULL, frame = NULL, expires_at = NULL WHERE task_id = ?',
          event.state, event.sessionId ?? null, Math.min(event.updatedAt || now, now), event.error ? JSON.stringify(event.error) : null, event.taskId,
        ).rowsWritten
        if (changed > 0) this.notify(event.taskId)
        return
      }
      case 'attention': {
        const items = stampHostId(Array.isArray(event.items) ? event.items : [], this.hostId ?? '')
        if (items.length === 0) this.sql.exec('DELETE FROM attention WHERE session_id = ?', event.sessionId)
        else this.sql.exec('INSERT INTO attention (session_id, items, updated_at) VALUES (?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at', event.sessionId, JSON.stringify(items), Date.now())
        return
      }
      case 'host-status':
        this.setInfo('ceiling', JSON.stringify(event.ceiling))
        this.setInfo('kill_switch', event.killSwitch ? '1' : '0')
        this.setInfo('operations', JSON.stringify(event.operations))
        return
    }
  }

  private notify(taskId: string): void {
    const set = this.waiters.get(taskId)
    if (!set) return
    this.waiters.delete(taskId)
    for (const wake of set) wake()
  }

  private async onResponse(frame: ResponseFrame): Promise<void> {
    const waiter = this.pending.get(frame.id)
    if (waiter) {
      this.pending.delete(frame.id)
      waiter(frame)
      return
    }
    // A delivery made while no request was waiting (reconnect or retry).
    this.inFlight.delete(frame.id)
    const row = this.sql.exec<TaskRow>('SELECT * FROM tasks WHERE delivery_id = ?', frame.id).toArray()[0]
    if (row) this.applyDelivery(row, frame)
  }

  /** Record the host's answer to a task delivery. Returns false when the task was forgotten. */
  private applyDelivery(row: TaskRow, frame: ResponseFrame): boolean {
    const now = Date.now()
    if (frame.ok) {
      const info = (frame.result ?? {}) as Partial<TaskInfo>
      const state: TaskState = info.state && info.state !== 'parked' ? info.state : 'accepted'
      this.sql.exec(
        'UPDATE tasks SET state = ?, session_id = COALESCE(?, session_id), delivered = 1, params = NULL, frame = NULL, expires_at = NULL, updated_at = ?, error = NULL WHERE task_id = ?',
        state, info.sessionId ?? null, now, row.task_id,
      )
      this.notify(row.task_id)
      return true
    }
    const error = frame.error ?? err('internal', 'The host refused the task without a reason.')
    if (row.op === 'task.start' && row.delivered === 0 && NON_STICKY_ERRORS.has(error.code) && row.state === 'parked' && row.expires_at === null) {
      this.sql.exec('DELETE FROM tasks WHERE task_id = ?', row.task_id)
      this.notify(row.task_id)
      return false
    }
    this.sql.exec(
      "UPDATE tasks SET state = 'failed', delivered = 1, params = NULL, frame = NULL, expires_at = NULL, updated_at = ?, error = ? WHERE task_id = ?",
      now, JSON.stringify(error), row.task_id,
    )
    this.notify(row.task_id)
    return true
  }

  // --- relaying -------------------------------------------------------------------------------

  private sendRequest(ws: WebSocket, id: string, call: ExecuteCall, timeoutMs: number, taskId?: string, idempotencyKey?: string): void {
    send(ws, {
      t: 'request',
      id,
      op: call.op,
      params: call.params,
      actor: call.actor,
      scopes: call.scopes,
      grant: call.grant,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(taskId ? { taskId } : {}),
      ...(call.confirmation ? { confirmation: call.confirmation } : {}),
      deadline: Date.now() + timeoutMs,
    })
  }

  /** Send a request and wait for its response. Null on timeout. */
  private relay(ws: WebSocket, id: string, call: ExecuteCall, timeoutMs: number, taskId?: string, idempotencyKey?: string): Promise<ResponseFrame | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, timeoutMs)
      this.pending.set(id, frame => {
        clearTimeout(timer)
        resolve(frame)
      })
      this.sendRequest(ws, id, call, timeoutMs, taskId, idempotencyKey)
    })
  }

  private async deliverUndelivered(ws: WebSocket): Promise<void> {
    const rows = this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE delivered = 0 AND params IS NOT NULL AND state = 'parked' ORDER BY created_at").toArray()
    for (const row of rows) {
      // A delivery already in flight from createTask() (it awaits its response in `pending`)
      // or from an earlier redelivery must not be sent twice.
      if (this.pending.has(row.delivery_id) || this.inFlight.has(row.delivery_id)) continue
      this.inFlight.add(row.delivery_id)
      setTimeout(() => this.inFlight.delete(row.delivery_id), RELAY_TIMEOUT_MS)
      // The grant may have changed while the task was parked: use the current one.
      const call = await this.revalidate(row)
      if (!call || this.pending.has(row.delivery_id)) continue
      this.sendRequest(ws, row.delivery_id, { ...call, params: parseJson(row.params, {}) }, RELAY_TIMEOUT_MS, row.task_id, row.idempotency_key)
    }
  }

  /**
   * Re-check a parked task against the client's current standing: revoked
   * clients, narrowed hub grants and lowered DSH ceilings fail the task.
   * Returns the call to deliver with the fresh grant, or null when it failed.
   */
  private async revalidate(row: TaskRow): Promise<ExecuteCall | null> {
    const stored = parseJson<ExecuteCall | null>(row.frame, null)
    if (!stored) return null
    let grant: Grant | null = stored.grant
    let refusal: RemoraError | null = null
    if (stored.actor.clientId === OWNER_CLIENT_ID) {
      grant = { level: 'full', fullAccessExpiresAt: Date.now() + 60_000 }
    } else {
      const standing = await this.hub().clientStanding(stored.actor.clientId, this.hostId ?? '')
      if (standing.revoked) refusal = { ...denied('hub', 'switched-off', row.op), message: `${row.op} was not delivered: this client was disconnected on the hub while the task was parked.` }
      else if (!standing.grant) refusal = { ...denied('hub', 'switched-off', row.op), message: `${row.op} was not delivered: this client is blocked on this host.` }
      else grant = standing.grant
    }
    if (!refusal && grant) {
      const ceiling = this.ceiling()
      const decision = ceiling ? decide({ operation: row.op, ceiling, hubGrant: grant, tokenScopes: stored.scopes, now: Date.now() }) : { allowed: true as const }
      if (!decision.allowed) refusal = denied(decision.layer, decision.reason, row.op)
    }
    const current = this.taskRow(row.task_id)
    if (!current || current.state !== 'parked' || current.delivered !== 0) return null
    if (refusal) {
      this.sql.exec("UPDATE tasks SET state = 'failed', params = NULL, frame = NULL, expires_at = NULL, updated_at = ?, error = ? WHERE task_id = ?", Date.now(), JSON.stringify(refusal), row.task_id)
      this.notify(row.task_id)
      await this.audit(stored.actor, `${row.op}.deliver`, 'denied', { layer: refusal.denial?.layer, reason: refusal.denial?.reason ?? null })
      return null
    }
    const fresh: ExecuteCall = { ...stored, grant: grant as Grant }
    this.sql.exec('UPDATE tasks SET frame = ? WHERE task_id = ?', JSON.stringify(fresh), row.task_id)
    return fresh
  }

  /** Called by the Worker after a client was revoked or its grant on this host changed. */
  async refreshParked(clientId: string): Promise<number> {
    if (!this.schemaReady) return 0
    const rows = this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE client_id = ? AND delivered = 0 AND state = 'parked'", clientId).toArray()
    let failed = 0
    for (const row of rows) if (!(await this.revalidate(row))) failed++
    return failed
  }

  // --- the operation entry point ------------------------------------------------------------------

  /**
   * Run one operation from a client. Pre-checks the permission with the
   * host's reported ceiling, then relays it, or answers from the ledger.
   * Every call is audited without its content.
   */
  async execute(call: ExecuteCall): Promise<ExecuteResult> {
    if (!this.schemaReady) return { ok: false, error: err('gone', 'This host is not paired with the hub.', { fix: 'hub:/' }) }
    const result = await this.executeInner(call)
    const denial = result.ok ? null : result.error.denial
    await this.audit(call.actor, call.op, result.ok ? 'ok' : result.error.code === 'denied' ? 'denied' : 'error', {
      layer: denial?.layer,
      reason: result.ok ? null : denial?.reason ?? result.error.code,
    })
    return result
  }

  private async executeInner(call: ExecuteCall): Promise<ExecuteResult> {
    if (this.info('revoked') === '1' || !this.hostId) return { ok: false, error: err('gone', 'This host is no longer paired with the hub.', { fix: 'hub:/' }) }
    const ceiling = this.ceiling()
    if (!ceiling) return { ok: false, error: err('host_offline', 'This host has not connected to the hub yet.', { fix: 'dsh:settings/remora#connection' }) }
    const decision = decide({ operation: call.op, ceiling, hubGrant: call.grant, tokenScopes: call.scopes, now: Date.now() })
    if (!decision.allowed) return { ok: false, error: denied(decision.layer, decision.reason, call.op) }
    if (this.info('kill_switch') === '1') {
      return { ok: false, error: err('denied', 'Remote access is stopped with the emergency switch on the DSH host.', { denial: { layer: 'dsh', reason: 'kill-switch' }, fix: 'dsh:settings/remora#kill-switch' }) }
    }
    // The ledger is per client: a client only sees and acts on its own tasks (the owner sees all).
    if (call.actor.clientId !== OWNER_CLIENT_ID && typeof call.params.taskId === 'string') {
      const owned = this.taskRow(call.params.taskId)
      if (!owned || owned.client_id !== call.actor.clientId) return { ok: false, error: err('not_found', 'No task with this id is known to the hub for this client.') }
    }
    if (call.op === 'task.get' || call.op === 'task.wait') return this.taskQuery(call)
    const operations = this.operations()
    if (operations && !operations.includes(call.op)) {
      return { ok: false, error: err('unavailable', `This DSH host cannot serve ${call.op} (not supported by its DSH or plugin version).`, { fix: 'dsh:settings/remora#compatibility' }) }
    }
    if (TASK_CREATING.has(call.op)) return this.createTask(call)
    const ws = this.readySockets()[0]
    if (!ws) return { ok: false, error: err('host_offline', 'The DSH host is offline. Start DSH Web on that machine and try again.') }
    const frame = await this.relay(ws, call.requestId ?? `r_${randomToken(12)}`, call, RELAY_TIMEOUT_MS)
    if (!frame) return { ok: false, error: err('unavailable', 'The DSH host did not answer in time.') }
    return frame.ok ? { ok: true, result: stampHostId(frame.result ?? null, this.hostId ?? "") } : { ok: false, error: frame.error ?? err('internal', 'The host returned an error without details.') }
  }

  // --- task ledger ------------------------------------------------------------------------------

  private taskFromRow(row: TaskRow): TaskInfo {
    const info: TaskInfo = {
      taskId: row.task_id,
      hostId: this.hostId ?? '',
      sessionId: row.session_id,
      state: row.state as TaskState,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    const error = parseJson<RemoraError | null>(row.error, null)
    if (error) info.error = error
    if (row.state === 'needs_attention' && row.session_id) info.attention = this.attentionFor(row.session_id)
    return info
  }

  private attentionFor(sessionId: string): AttentionItem[] {
    const row = this.sql.exec<{ items: string }>('SELECT items FROM attention WHERE session_id = ?', sessionId).toArray()[0]
    return parseJson<AttentionItem[]>(row?.items, [])
  }

  private async createTask(call: ExecuteCall): Promise<ExecuteResult> {
    const hostId = this.hostId as string
    const idempotencyKey = typeof call.params.idempotencyKey === 'string' ? call.params.idempotencyKey : null
    if (!idempotencyKey) return { ok: false, error: err('invalid_request', 'idempotencyKey is required.') }
    const existing = this.sql.exec<TaskRow>('SELECT * FROM tasks WHERE client_id = ? AND idempotency_key = ?', call.actor.clientId, idempotencyKey).toArray()[0]
    if (existing) return { ok: true, result: this.taskFromRow(existing) }

    const ws = this.readySockets()[0]
    if (!ws && call.op !== 'task.start') return { ok: false, error: err('host_offline', 'The DSH host is offline. Start DSH Web on that machine and try again.') }

    const now = Date.now()
    const taskId = newTaskId(hostId)
    const deliveryId = call.requestId ?? `d_${randomToken(12)}`
    const stored: ExecuteCall = { op: call.op, params: {}, actor: call.actor, scopes: call.scopes, grant: call.grant }
    this.sql.exec(
      "INSERT INTO tasks (task_id, client_id, idempotency_key, op, state, params, frame, delivered, delivery_id, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, 'parked', ?, ?, 0, ?, ?, ?, ?)",
      taskId, call.actor.clientId, idempotencyKey, call.op, JSON.stringify(call.params), JSON.stringify(stored), deliveryId, now, now, ws ? null : now + PARKED_TASK_TTL_MS,
    )
    if (!ws) {
      await this.scheduleAlarm()
      return { ok: true, result: this.taskFromRow(this.taskRow(taskId) as TaskRow) }
    }
    const frame = await this.relay(ws, deliveryId, call, RELAY_TIMEOUT_MS, taskId, idempotencyKey)
    const row = this.taskRow(taskId)
    if (!row) return { ok: false, error: err('internal', 'The task disappeared from the ledger.') }
    if (!frame) {
      // Unknown whether it arrived; the host dedupes on the request id, so redelivering is safe.
      this.sql.exec('UPDATE tasks SET expires_at = ? WHERE task_id = ?', now + PARKED_TASK_TTL_MS, taskId)
      await this.scheduleAlarm(60_000)
      return { ok: true, result: this.taskFromRow(this.taskRow(taskId) as TaskRow) }
    }
    this.applyDelivery(row, frame)
    if (!frame.ok) return { ok: false, error: frame.error ?? err('internal', 'The host refused the task without a reason.') }
    const info = this.taskFromRow(this.taskRow(taskId) as TaskRow)
    const reported = frame.result as Partial<TaskInfo> | undefined
    if (reported?.hasLiveClient !== undefined) info.hasLiveClient = reported.hasLiveClient
    return { ok: true, result: info }
  }

  private taskRow(taskId: string): TaskRow | undefined {
    return this.sql.exec<TaskRow>('SELECT * FROM tasks WHERE task_id = ?', taskId).toArray()[0]
  }

  private async taskQuery(call: ExecuteCall): Promise<ExecuteResult> {
    const taskId = String(call.params.taskId ?? '')
    let row = this.taskRow(taskId)
    if (!row) return { ok: false, error: err('not_found', 'No task with this id is known to the hub.') }
    if (call.op === 'task.wait') {
      const requested = typeof call.params.timeoutMs === 'number' ? call.params.timeoutMs : TASK_WAIT_MAX_MS
      const timeout = Math.max(0, Math.min(TASK_WAIT_MAX_MS, requested))
      if (!settled(row.state as TaskState) && timeout > 0) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            this.waiters.get(taskId)?.delete(wake)
            resolve()
          }, timeout)
          const wake = () => {
            clearTimeout(timer)
            resolve()
          }
          const set = this.waiters.get(taskId) ?? new Set()
          set.add(wake)
          this.waiters.set(taskId, set)
        })
        row = this.taskRow(taskId)
        if (!row) return { ok: false, error: err('not_found', 'The task was removed while waiting.') }
      }
    }
    const info = this.taskFromRow(row)
    const ws = this.readySockets()[0]
    if (ws && row.delivered === 1 && settled(info.state)) {
      // The hub keeps no content; the final reply and changes come from the host.
      const frame = await this.relay(ws, `r_${randomToken(12)}`, { ...call, op: 'task.get', params: { taskId } }, RELAY_TIMEOUT_MS, taskId)
      if (frame?.ok && frame.result && typeof frame.result === 'object') {
        const fromHost = frame.result as Partial<TaskInfo>
        if (fromHost.result) info.result = fromHost.result
        if (fromHost.attention) info.attention = stampHostId(fromHost.attention, this.hostId ?? '')
        if (fromHost.hasLiveClient !== undefined) info.hasLiveClient = fromHost.hasLiveClient
        if (fromHost.error && !info.error) info.error = fromHost.error
      }
    }
    return { ok: true, result: info }
  }

  // --- alarms -------------------------------------------------------------------------------------

  private async scheduleAlarm(retryInMs?: number): Promise<void> {
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(expires_at) AS at FROM tasks WHERE state = 'parked' AND expires_at IS NOT NULL").one().at
    const candidates = [next, retryInMs !== undefined ? Date.now() + retryInMs : null, Date.now() + 24 * 60 * 60_000].filter((value): value is number => value !== null)
    const at = Math.min(...candidates)
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(at)
  }

  override async alarm(): Promise<void> {
    if (!this.schemaReady) return
    const now = Date.now()
    const expired = this.sql.exec<{ task_id: string }>("SELECT task_id FROM tasks WHERE state = 'parked' AND expires_at IS NOT NULL AND expires_at <= ?", now).toArray()
    for (const { task_id } of expired) {
      this.sql.exec(
        "UPDATE tasks SET state = 'failed', params = NULL, frame = NULL, updated_at = ?, error = ? WHERE task_id = ?",
        now, JSON.stringify(err('host_offline', 'The DSH host stayed offline, so the task was never delivered.')), task_id,
      )
      this.notify(task_id)
    }
    const ws = this.readySockets()[0]
    if (ws) await this.deliverUndelivered(ws)
    this.sql.exec('DELETE FROM tasks WHERE updated_at < ? AND state IN (\'completed\', \'failed\', \'cancelled\')', now - RETENTION_MS)
    this.sql.exec('DELETE FROM attention WHERE updated_at < ?', now - RETENTION_MS)
    const pendingDelivery = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE state = 'parked' AND delivered = 0").one().n
    await this.scheduleAlarm(pendingDelivery > 0 && ws ? 60_000 : undefined)
  }

  // --- views for the hub ------------------------------------------------------------------------------

  /** Live view. With `clientId`, running and recent tasks are that client's only. */
  async summary(clientId?: string): Promise<HostLive> {
    if (!this.schemaReady) {
      return { hostId: '', name: null, reportedName: null, online: false, revoked: false, lastSeenAt: null, pluginVersion: null, dshVersion: null, operations: [], ceiling: null, killSwitch: false, running: [], recent: [], attention: [], duplicateConnections: 0, hadTasks: false }
    }
    const ready = this.readySockets()
    let lastSeen = Number(this.info('last_seen_at') ?? '0') || null
    for (const ws of ready) {
      const ping = this.ctx.getWebSocketAutoResponseTimestamp(ws)
      if (ping && (lastSeen === null || ping.getTime() > lastSeen)) lastSeen = ping.getTime()
    }
    const mine = clientId === undefined ? '' : ' AND client_id = ?'
    const bind = clientId === undefined ? [] : [clientId]
    const running = this.sql.exec<TaskRow>(`SELECT * FROM tasks WHERE state IN ('parked', 'accepted', 'running', 'needs_attention')${mine} ORDER BY created_at DESC LIMIT 50`, ...bind).toArray().map(row => this.taskFromRow(row))
    const recent = this.sql.exec<TaskRow>(`SELECT * FROM tasks WHERE state IN ('completed', 'failed', 'cancelled')${mine} ORDER BY updated_at DESC LIMIT 10`, ...bind).toArray().map(row => this.taskFromRow(row))
    const attention = this.sql.exec<{ items: string }>('SELECT items FROM attention ORDER BY updated_at DESC').toArray().flatMap(row => parseJson<AttentionItem[]>(row.items, []))
    return {
      hostId: this.hostId ?? '',
      name: this.info('name'),
      reportedName: this.info('reported_name'),
      online: ready.length > 0,
      revoked: this.info('revoked') === '1',
      lastSeenAt: lastSeen,
      pluginVersion: this.info('plugin_version') || null,
      dshVersion: this.info('dsh_version') || null,
      operations: this.operations() ?? [],
      ceiling: this.ceiling(),
      killSwitch: this.info('kill_switch') === '1',
      running,
      recent,
      attention,
      duplicateConnections: Number(this.info('duplicate_connections') ?? '0'),
      hadTasks: running.length > 0 || recent.length > 0 || this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tasks').one().n > 0,
    }
  }

  async recentTasks(limit = 50): Promise<TaskInfo[]> {
    if (!this.schemaReady) return []
    return this.sql.exec<TaskRow>('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?', limit).toArray().map(row => this.taskFromRow(row))
  }

  async listAudit(limit = 200): Promise<AuditRow[]> {
    if (!this.schemaReady) return []
    return listAudit(this.sql, limit)
  }
}

function settled(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.has(state) || state === 'needs_attention'
}

const DENIAL_TEXT: Record<string, string> = {
  'forbidden-remotely': 'is never allowed remotely',
  'level-too-low': 'needs a higher permission level',
  'switched-off': 'is switched off',
  'kill-switch': 'is stopped by the kill switch on the DSH host',
  'confirmation-failed': 'needs a valid passkey confirmation',
  'out-of-scope': 'is outside the workspaces allowed on the DSH host',
  'full-access-expired': 'needs remote full access, which has expired',
  'missing-scope': 'is outside the scopes granted to this token',
  'unknown-operation': 'is not a known operation',
}

const LAYER_TEXT: Record<string, string> = {
  dsh: 'by the DSH host (its Remora settings tab sets the ceiling)',
  hub: "by the hub (this client's grant on the Connections page)",
  token: "by this client's OAuth token (reconnect the client and approve the scope)",
}

export function denied(layer: 'dsh' | 'hub' | 'token', reason: string, operation: string): RemoraError {
  return {
    code: 'denied',
    message: `${operation} ${DENIAL_TEXT[reason] ?? 'was refused'}, refused ${LAYER_TEXT[layer] ?? ''}.`,
    denial: { layer, reason: reason as NonNullable<RemoraError['denial']>['reason'] },
    fix: fixFor(layer),
  }
}
