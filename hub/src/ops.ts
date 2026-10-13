/**
 * The operation pipeline shared by MCP, the HTTP API and the owner UI:
 * validate, resolve the host, attach the caller's grant, pre-check, relay to
 * the host Durable Object (or answer hub operations here).
 */
import { stampAnswerUrls } from './attention.ts'
import { AUDIT_MAX_ROWS, FREE_TIER, OWNER_CLIENT_ID, RATE_LIMITS, dcrEnabled } from './config.ts'
import type { ConfirmationView, ExecuteResult, HostLive } from './host-do.ts'
import { denied } from './host-do.ts'
import { APPROVAL_RESULT_MS, type ApprovalRecord } from './hub-do.ts'
import { HUB_VERSION } from './version.ts'
import { hostStub, hubStub } from './meter.ts'
import type { CallContext } from './types.ts'
import { hostIdOfTask } from './util.ts'
import {
  CONFIRMATION_LEDGER_OPERATIONS, HUB_CONFIRMATION_PREFIX, HUB_MAINTENANCE_OPERATIONS, HUB_OPERATIONS, INPUT_SCHEMAS, TASK_LEDGER_OPERATIONS, decide, findOperation, validateParams,
  type AuditExportResult, type Confirmation, type ConfirmationInfo, type Grant, type HostSummary, type HubExportResult, type OperationId, type RemoraError, type StatusResult,
} from './vendor/protocol/index.ts'

export interface Caller {
  clientId: string
  clientName: string
  scopes: string[]
  /** `owner` is the hub UI: no hub-side narrowing, the DSH ceiling still applies. */
  kind: 'client' | 'owner'
}

export interface RunOptions {
  confirmation?: Confirmation
  requestId?: string
  /**
   * The hub origin. When set, every attention item in the result gets its
   * `answerUrl`, and approval refusals carry the link to the hub page.
   */
  origin?: string
}

const err = (code: RemoraError['code'], message: string, extra: Partial<RemoraError> = {}): ExecuteResult => ({ ok: false, error: { code, message, ...extra } })

/** The owner's own grant: everything the DSH ceiling allows, briefly. */
export function ownerGrant(): Grant {
  return { level: 'full', fullAccessExpiresAt: Date.now() + 60_000 }
}

async function contextFor(env: Env, caller: Caller): Promise<CallContext> {
  if (caller.kind === 'owner') {
    const hosts = (await hubStub(env).listHosts()).map(host => ({ hostId: host.hostId, name: host.name }))
    return { ok: true, hosts, grants: Object.fromEntries(hosts.map(host => [host.hostId, ownerGrant()])) }
  }
  const [max, windowSeconds] = RATE_LIMITS.apiPerClient
  return hubStub(env).callContext(caller.clientId, { max, windowSeconds })
}

/**
 * The params exactly as the host receives them in the request frame: `hostId`
 * is filled in for operations whose schema has it. Passkey confirmations are
 * computed over this object (see vendor/protocol/confirmation.ts).
 */
export function finalParams(op: string, params: Record<string, unknown>, hostId: string): Record<string, unknown> {
  const spec = findOperation(op)
  return spec && 'hostId' in INPUT_SCHEMAS[spec.id as OperationId].properties ? { ...params, hostId } : params
}

export async function runOperation(env: Env, caller: Caller, op: string, rawParams: unknown, options: RunOptions = {}): Promise<ExecuteResult> {
  const boundary: { hostId?: string; visibleHostIds?: string[] } = {}
  const outcome = await runOperationInner(env, caller, op, rawParams, options, boundary)
  if (outcome.ok && caller.kind === 'client') {
    // A relay, task wait or export can outlive a revoke or grant change. Read
    // current policy after assembling the result, without charging another call.
    const current = await hubStub(env).callContext(caller.clientId)
    if (!current.ok || boundary.visibleHostIds?.some(id => !current.grants[id])) {
      return err('denied', 'This client or one of its hosts was disconnected while the request was running.', { denial: { layer: 'hub', reason: 'switched-off' }, fix: 'hub:/connections' })
    }
    if (boundary.hostId) {
      const grant = current.grants[boundary.hostId]
      if (!grant) return { ok: false, error: denied('hub', 'switched-off', op) }
      const decision = decide({ operation: op, ceiling: { level: 'full' }, hubGrant: grant, tokenScopes: caller.scopes, now: Date.now() })
      if (!decision.allowed) return { ok: false, error: denied(decision.layer, decision.reason, op) }
    }
  }
  return options.origin ? withAnswerLinks(outcome, options.origin) : outcome
}

/**
 * Attention items leave the hub with the URL of the hub page that answers
 * them (approval refusals get theirs in HostDO, which knows the host id).
 */
function withAnswerLinks(outcome: ExecuteResult, origin: string): ExecuteResult {
  return outcome.ok ? { ok: true, result: stampAnswerUrls(outcome.result, origin) } : outcome
}

async function runOperationInner(env: Env, caller: Caller, op: string, rawParams: unknown, options: RunOptions, boundary: { hostId?: string; visibleHostIds?: string[] }): Promise<ExecuteResult> {
  if (caller.kind === 'client' && caller.clientId === OWNER_CLIENT_ID) return err('denied', 'This client id is reserved for the signed-in owner.')
  const spec = findOperation(op)
  if (!spec) return err('not_found', `Unknown operation: ${op}`)
  const params = (rawParams ?? {}) as Record<string, unknown>
  const issues = validateParams(op as OperationId, params)
  if (issues.length > 0) return err('invalid_request', `Invalid parameters: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)

  const context = await contextFor(env, caller)
  if (!context.ok) {
    if (context.error === 'rate_limited') return err('rate_limited', 'Too many calls from this client; slow down and retry in a minute.')
    return err('denied', 'This client was disconnected on the hub.', { denial: { layer: 'hub', reason: 'switched-off' }, fix: 'hub:/connections' })
  }

  if (HUB_MAINTENANCE_OPERATIONS.has(op)) {
    // Parked until the owner approves it on the hub page; then confirmation.get carries the result.
    const decision = decide({ operation: op, ceiling: { level: 'full' }, hubGrant: { level: 'view' }, tokenScopes: caller.scopes, now: Date.now() })
    if (!decision.allowed) return { ok: false, error: denied(decision.layer, decision.reason, op) }
    const parked = await hubStub(env).requestApproval(caller.clientId, caller.clientName, op, options.origin ?? null)
    if ('error' in parked) return err('rate_limited', 'This client already has 5 requests waiting for the owner; wait until the owner answers them or they expire (10 minutes).')
    return { ok: true, result: await approvalInfo(env, parked, options.origin) }
  }

  if (CONFIRMATION_LEDGER_OPERATIONS.has(op) && typeof params.confirmationId === 'string' && params.confirmationId.startsWith(HUB_CONFIRMATION_PREFIX)) {
    const decision = decide({ operation: op, ceiling: { level: 'full' }, hubGrant: { level: 'view' }, tokenScopes: caller.scopes, now: Date.now() })
    if (!decision.allowed) return { ok: false, error: denied(decision.layer, decision.reason, op) }
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 0
    const row = await hubStub(env).approvalFor(params.confirmationId, caller.kind === 'owner' ? undefined : caller.clientId, timeoutMs)
    if (!row) return err('not_found', 'No confirmation with this id is known to the hub for this client.')
    return { ok: true, result: await approvalInfo(env, row, options.origin) }
  }

  if (HUB_OPERATIONS.has(op)) {
    boundary.visibleHostIds = context.hosts.filter(host => context.grants[host.hostId] !== null).map(host => host.hostId)
    // Hub operations still honour the token scope.
    const decision = decide({ operation: op, ceiling: { level: 'full' }, hubGrant: { level: 'view' }, tokenScopes: caller.scopes, now: Date.now() })
    if (!decision.allowed) return { ok: false, error: denied(decision.layer, decision.reason, op) }
    const result = await hubOperation(env, context, op, caller.kind === 'owner' ? undefined : caller.clientId)
    if (caller.kind === 'client') await hubStub(env).audit({ actor: caller.clientId, actorName: caller.clientName, operation: op, hostId: null, outcome: 'ok', layer: null, reason: null })
    return { ok: true, result }
  }

  let hostId: string | null
  // Cancel/steer also accept an explicit host or (for steer) a session. When
  // only a task id was supplied, it already identifies the owning host.
  const taskIdTarget = (op === 'task.cancel' || op === 'task.steer') && typeof params.taskId === 'string' && params.hostId === undefined
  if (TASK_LEDGER_OPERATIONS.has(op) || taskIdTarget) {
    hostId = typeof params.taskId === 'string' ? hostIdOfTask(params.taskId) : null
    if (!hostId || !context.hosts.some(host => host.hostId === hostId)) return err('not_found', 'No task with this id is known to the hub.')
  } else if (CONFIRMATION_LEDGER_OPERATIONS.has(op)) {
    hostId = typeof params.confirmationId === 'string' ? hostIdOfTask(params.confirmationId) : null
    if (!hostId || !context.hosts.some(host => host.hostId === hostId)) return err('not_found', 'No confirmation with this id is known to the hub.')
  } else {
    const resolved = resolveHost(context, params)
    if (!resolved.ok) return resolved.result
    hostId = resolved.hostId
  }

  const grant = context.grants[hostId]
  if (!grant) return { ok: false, error: { ...denied('hub', 'switched-off', op), message: `${op} was refused by the hub: this client is blocked on this host (Connections page).` } }
  const forwarded = finalParams(op, params, hostId)
  boundary.hostId = hostId
  return hostStub(env, hostId).execute({
    op,
    params: forwarded,
    actor: { clientId: caller.clientId, clientName: caller.clientName },
    scopes: caller.scopes,
    grant,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.confirmation ? { confirmation: options.confirmation } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
  })
}

function resolveHost(context: CallContext, params: Record<string, unknown>): { ok: true; hostId: string } | { ok: false; result: ExecuteResult } {
  const visible = context.hosts.filter(host => context.grants[host.hostId] !== null)
  if (typeof params.hostId === 'string') {
    if (!context.hosts.some(host => host.hostId === params.hostId)) return { ok: false, result: err('not_found', `Unknown hostId. Paired hosts: ${describeHosts(visible)}`) }
    return { ok: true, hostId: params.hostId }
  }
  if (visible.length === 1 && visible[0]) return { ok: true, hostId: visible[0].hostId }
  if (visible.length === 0) return { ok: false, result: err('not_found', 'No DSH host is paired with this hub yet.', { fix: 'hub:/' }) }
  return { ok: false, result: err('invalid_request', `Several DSH hosts are paired; pass hostId. Hosts: ${describeHosts(visible)}`) }
}

function describeHosts(hosts: { hostId: string; name: string }[]): string {
  return hosts.length === 0 ? '(none)' : hosts.map(host => `${host.hostId} (${host.name})`).join(', ')
}

/** Live view of every host the caller may see, one Durable Object call per host. */
/** Live view of every host the caller may see. With `clientId`, task lists are that client's only. */
export async function liveHosts(env: Env, context: CallContext, clientId?: string): Promise<{ summary: HostSummary; live: HostLive }[]> {
  const visible = context.hosts.filter(host => context.grants[host.hostId] !== null)
  return Promise.all(visible.map(async host => {
    const live = await hostStub(env, host.hostId).summary(clientId)
    const summary: HostSummary = {
      hostId: host.hostId,
      // The name the owner approved at pairing; a host cannot rename itself.
      name: host.name,
      online: live.online,
      lastSeenAt: live.lastSeenAt,
      pluginVersion: live.pluginVersion,
      dshVersion: live.dshVersion,
      operations: live.operations,
      ceiling: live.ceiling,
      grant: context.grants[host.hostId] ?? null,
      killSwitch: live.killSwitch,
    }
    return { summary, live }
  }))
}

export async function freeTierUsage(env: Env): Promise<StatusResult['freeTier']> {
  const meter = await hubStub(env).meterToday()
  const ratio = (value: number, limit: number) => Math.round((value / limit) * 1000) / 1000
  return {
    workerRequests: ratio(meter.workerRequests, FREE_TIER.workerRequests),
    durableObjectRequests: ratio(meter.durableObjectRequests, FREE_TIER.durableObjectRequests),
    kvWrites: ratio(meter.kvWrites, FREE_TIER.kvWrites),
  }
}

async function hubOperation(env: Env, context: CallContext, op: string, clientId: string | undefined): Promise<unknown> {
  const hosts = await liveHosts(env, context, clientId)
  if (op === 'hosts.list') return { hosts: hosts.map(entry => entry.summary) }
  const result: StatusResult = {
    hosts: hosts.map(entry => entry.summary),
    running: hosts.flatMap(entry => entry.live.running),
    attention: hosts.flatMap(entry => entry.live.attention),
    freeTier: await freeTierUsage(env),
  }
  return result
}

/**
 * Passkey confirmations parked on one host. Workers RPC stubs drop fields
 * typed `unknown` (a result, the stored params) from their return types, so
 * these calls restate what HostDO actually returns.
 */
export function confirmations(env: Env, hostId: string) {
  const host = hostStub(env, hostId)
  return {
    view: (id: string, origin?: string) => host.confirmationView(id, origin) as unknown as Promise<ConfirmationView | null>,
    pending: (origin?: string) => host.pendingConfirmations(origin) as unknown as Promise<ConfirmationView[]>,
    run: (id: string, input: { requestId: string; confirmation: Confirmation; grant: Grant | null; origin?: string }) =>
      host.confirmRun(id, input) as unknown as Promise<ExecuteResult>,
    deny: (id: string) => host.denyConfirmation(id) as Promise<boolean>,
  }
}

/** A parked hub maintenance request as clients see it; an approved export carries its result for an hour. */
async function approvalInfo(env: Env, row: ApprovalRecord, origin: string | undefined): Promise<ConfirmationInfo> {
  const info: ConfirmationInfo = { confirmationId: row.id, hostId: '', operation: row.operation, state: row.state, createdAt: row.createdAt, expiresAt: row.expiresAt }
  if (origin) info.confirmUrl = `${origin}/confirm/hub/${row.id}`
  // Built when collected, at most a few times within the hour (each build reads every log).
  if (row.state === 'done' && row.decidedAt !== null && Date.now() - row.decidedAt < APPROVAL_RESULT_MS && (await hubStub(env).claimApprovalResult(row.id, row.clientId))) {
    info.result = await maintenanceResult(env, row.operation, origin ?? '')
  }
  return info
}

/** Built when asked for, never stored: the hub's audit chains, or its settings without secrets. */
export async function maintenanceResult(env: Env, op: string, origin: string): Promise<AuditExportResult | HubExportResult> {
  const hub = hubStub(env)
  if (op === 'hub.export') {
    const settings = await hub.exportSettings()
    return {
      format: 'remora-hub-export/v1',
      exportedAt: Date.now(),
      hubOrigin: origin,
      hubVersion: HUB_VERSION,
      settings: { allowOtherClients: settings.allowOtherClients, dynamicClientRegistration: dcrEnabled(env) },
      hosts: settings.hosts,
      clients: settings.clients,
      personalTokens: settings.personalTokens,
      passkeys: settings.passkeys,
      pushDevices: settings.pushDevices,
    }
  }
  // Every kept row: pruning runs every 50 appends, so a log can hold a few more than the cap.
  const limit = AUDIT_MAX_ROWS + 100
  const hosts = await hub.listHosts(true)
  const [hubRows, ...hostRows] = await Promise.all([hub.listAudit(limit), ...hosts.map(host => hostStub(env, host.hostId).listAudit(limit))])
  return {
    exportedAt: Date.now(),
    hubOrigin: origin,
    logs: [
      { log: 'hub', name: 'hub', records: [...(hubRows ?? [])].reverse() },
      ...hosts.map((host, index) => ({ log: host.hostId, name: host.name, records: [...(hostRows[index] ?? [])].reverse() })),
    ],
  }
}

/** Unpair a host: mark it revoked on the hub, then close its socket and fail its open tasks. */
export async function revokeHostEverywhere(env: Env, hostId: string, by: 'owner' | 'host'): Promise<boolean> {
  const changed = await hubStub(env).revokeHost(hostId, by)
  if (changed) await hostStub(env, hostId).revoke()
  return changed
}

/** After a client was revoked or narrowed: fail its parked tasks that are no longer allowed. */
export async function refreshParked(env: Env, clientId: string, hostIds?: string[]): Promise<void> {
  const ids = hostIds ?? (await hubStub(env).listHosts()).map(host => host.hostId)
  await Promise.all(ids.map(hostId => hostStub(env, hostId).refreshParked(clientId)))
}

const pairedCache = new Map<string, { paired: boolean; until: number }>()

/**
 * Whether a host id belongs to a paired, unrevoked host. Checked before an
 * unauthenticated WebSocket upgrade reaches a host Durable Object, so stray
 * ids never create one. Cached for a minute per isolate (the host object
 * re-checks revocation itself).
 */
export async function isPairedHost(env: Env, hostId: string): Promise<boolean> {
  const now = Date.now()
  const cached = pairedCache.get(hostId)
  if (cached && cached.until > now) return cached.paired
  const host = await hubStub(env).getHost(hostId)
  const paired = host !== null && host.revokedAt === null
  if (pairedCache.size > 1000) pairedCache.clear()
  pairedCache.set(hostId, { paired, until: now + 60_000 })
  return paired
}
