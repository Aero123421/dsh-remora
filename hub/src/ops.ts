/**
 * The operation pipeline shared by MCP, the HTTP API and the owner UI:
 * validate, resolve the host, attach the caller's grant, pre-check, relay to
 * the host Durable Object (or answer hub operations here).
 */
import { FREE_TIER, RATE_LIMITS } from './config.ts'
import type { ExecuteResult, HostLive } from './host-do.ts'
import { denied } from './host-do.ts'
import { hostStub, hubStub } from './meter.ts'
import type { CallContext } from './types.ts'
import { hostIdOfTask } from './util.ts'
import {
  HUB_OPERATIONS, INPUT_SCHEMAS, TASK_LEDGER_OPERATIONS, decide, findOperation, validateParams,
  type Confirmation, type Grant, type HostSummary, type OperationId, type RemoraError, type StatusResult,
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

  if (HUB_OPERATIONS.has(op)) {
    // Hub operations still honour the token scope.
    const decision = decide({ operation: op, ceiling: { level: 'full' }, hubGrant: { level: 'view' }, tokenScopes: caller.scopes, now: Date.now() })
    if (!decision.allowed) return { ok: false, error: denied(decision.layer, decision.reason, op) }
    const result = await hubOperation(env, context, op, caller.kind === 'owner' ? undefined : caller.clientId)
    if (caller.kind === 'client') await hubStub(env).audit({ actor: caller.clientId, actorName: caller.clientName, operation: op, hostId: null, outcome: 'ok', layer: null, reason: null })
    return { ok: true, result }
  }

  let hostId: string | null
  if (TASK_LEDGER_OPERATIONS.has(op)) {
    hostId = typeof params.taskId === 'string' ? hostIdOfTask(params.taskId) : null
    if (!hostId || !context.hosts.some(host => host.hostId === hostId)) return err('not_found', 'No task with this id is known to the hub.')
  } else {
    const resolved = resolveHost(context, params)
    if (!resolved.ok) return resolved.result
    hostId = resolved.hostId
  }

  const grant = context.grants[hostId]
  if (!grant) return { ok: false, error: { ...denied('hub', 'switched-off', op), message: `${op} was refused by the hub: this client is blocked on this host (Connections page).` } }
  const forwarded = finalParams(op, params, hostId)
  return hostStub(env, hostId).execute({
    op,
    params: forwarded,
    actor: { clientId: caller.clientId, clientName: caller.clientName },
    scopes: caller.scopes,
    grant,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.confirmation ? { confirmation: options.confirmation } : {}),
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
