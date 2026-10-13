/**
 * Handles every `request` frame from the hub:
 *
 *   1. the operation exists and this host serves it
 *   2. params match the operation's input schema
 *   3. the kill switch is off
 *   4. decide(DSH ceiling, hub grant, token scopes) allows it
 *   5. for REQUIRES_CONFIRMATION, and for CONFIRMATION_UNLESS_ALLOWED unless
 *      the settings tab allows it without one (approvals from MCP and CLI):
 *      the owner's passkey assertion verifies against the pinned
 *      credentials, and its requestId is recorded as used
 *   6. the adapter handler runs with a timeout before `frame.deadline`
 *
 * `OperationError` becomes a structured error; anything else becomes
 * `internal` without details (the cause is logged locally only). Every
 * request is written to the local audit log.
 */
import {
  CONFIRMATION_TTL_MS, CONFIRMATION_UNLESS_ALLOWED, OPERATIONS, REQUIRES_CONFIRMATION, decide, fixFor, validateParams,
  type DenialLayer, type DenialReason, type Grant, type OperationId, type RemoraError, type RequestFrame, type ResponseFrame,
} from '@dsh-remora/protocol'
import { OperationError, type HostOperationId, type OperationContext, type OperationHandler, type OperationHandlers } from '../ops/types.ts'
import type { AuditInput } from './audit.ts'
import { verifyConfirmation } from './confirmation.ts'
import { fullAccessActive } from './permissions.ts'
import type { PairedHub } from './settings.ts'

export interface ConfirmationLedger {
  isUsed(requestId: string): boolean
  /** Durable before it resolves. */
  markUsed(requestId: string, forgetAfter: number): Promise<void>
}

export interface DispatchDeps {
  handlers: () => OperationHandlers
  ceiling: () => Grant
  killSwitch: () => boolean
  /** For CONFIRMATION_UNLESS_ALLOWED operations: whether the DSH tab lets them run without the owner's passkey. */
  allowsWithoutConfirmation?: (operation: OperationId) => boolean
  pinned: () => PairedHub | null
  confirmations: ConfirmationLedger
  audit: (entry: AuditInput) => void
  respond: (frame: ResponseFrame) => void
  now?: () => number
  /** Time kept back before the hub's deadline for the response to travel. */
  marginMs?: number
  log?: (message: string, error?: unknown) => void
}

const HUB_ONLY: ReadonlySet<string> = new Set(['status', 'hosts.list', 'confirmation.get', 'audit.export', 'hub.export', 'host.rotate-key'])

const DENIAL_MESSAGES: Readonly<Record<DenialLayer, string>> = {
  dsh: 'Refused by the permission ceiling set on the DSH host (Remora settings tab).',
  hub: 'Refused by the access this client was granted on the hub.',
  token: 'The access token does not carry the scope this operation needs.',
}

export function denialError(layer: DenialLayer, reason: DenialReason, message = DENIAL_MESSAGES[layer]): RemoraError {
  return { code: 'denied', message, denial: { layer, reason }, fix: fixFor(layer) }
}

/** An approval sent without the owner's passkey while the DSH tab requires one. */
export function passkeyRequiredError(): RemoraError {
  return {
    code: 'denied',
    message: 'This DSH host accepts approvals from MCP and CLI only when "Allow approvals from MCP and CLI" is on in its Remora tab; until then the owner allows or rejects each approval on the hub with a passkey.',
    denial: { layer: 'dsh', reason: 'confirmation-failed' },
    fix: 'hub:/attention',
  }
}

export function killSwitchError(): RemoraError {
  return { code: 'denied', message: 'Remote access is stopped on this DSH host (kill switch).', denial: { layer: 'dsh', reason: 'kill-switch' }, fix: 'dsh:settings/remora#kill-switch' }
}

function sanitize(error: OperationError): RemoraError {
  const out: RemoraError = { code: error.code, message: error.message.slice(0, 2000) }
  if (error.details.denial) out.denial = error.details.denial
  if (typeof error.details.fix === 'string') out.fix = error.details.fix
  return out
}

class DeadlineError extends OperationError {
  constructor() { super('unavailable', 'The operation did not finish before the deadline.') }
}

/** Full access for this caller: ceiling ∩ hub grant, both `full` and unexpired. */
export function effectiveFullAccess(ceiling: Grant, grant: Grant | undefined, now: number): boolean {
  return fullAccessActive(ceiling, now) && grant !== undefined && typeof grant === 'object' && fullAccessActive(grant, now)
}

export class Dispatcher {
  private readonly deps: DispatchDeps
  private readonly inflight = new Map<string, AbortController>()

  constructor(deps: DispatchDeps) {
    this.deps = deps
  }

  get pending(): number {
    return this.inflight.size
  }

  /** Abort every running handler (link lost, kill switch, unload). */
  abortAll(reason = 'aborted'): void {
    for (const controller of this.inflight.values()) controller.abort(new OperationError('unavailable', `Remote operation stopped: ${reason}`))
  }

  async handle(frame: RequestFrame): Promise<void> {
    if (this.inflight.has(frame.id)) return
    const controller = new AbortController()
    this.inflight.set(frame.id, controller)
    const now = this.deps.now ?? Date.now
    const started = now()
    const actor = frame.actor && typeof frame.actor === 'object' ? frame.actor : { clientId: 'unknown', clientName: 'unknown' }
    const audit: AuditInput = { kind: 'request', action: frame.op, outcome: 'ok', clientId: String(actor.clientId), clientName: String(actor.clientName).slice(0, 200), requestId: frame.id }
    let response: ResponseFrame
    try {
      const completed = await this.run(frame, controller, now)
      completed.assertAuthorized()
      response = { t: 'response', id: frame.id, ok: true, result: completed.value }
    } catch (error) {
      const remora = this.toError(error, frame)
      response = { t: 'response', id: frame.id, ok: false, error: remora }
      audit.outcome = remora.code === 'denied' ? 'denied' : 'error'
      audit.code = remora.code
      if (remora.denial) { audit.layer = remora.denial.layer; audit.reason = remora.denial.reason }
      else if (error instanceof ConfirmationDenied) audit.reason = `confirmation:${error.failure}`
    } finally {
      this.inflight.delete(frame.id)
    }
    audit.durationMs = now() - started
    this.deps.respond(response)
    this.deps.audit(audit)
  }

  private async run(frame: RequestFrame, controller: AbortController, now: () => number): Promise<{ value: unknown; assertAuthorized: () => void }> {
    const spec = OPERATIONS.find(op => op.id === frame.op)
    const handler = spec && !HUB_ONLY.has(spec.id) ? (this.deps.handlers()[spec.id as HostOperationId] as OperationHandler<HostOperationId> | undefined) : undefined
    if (!spec || !handler) throw new OperationError('not_found', `operation ${String(frame.op).slice(0, 64)} is not available on this host`)
    const op = spec.id as HostOperationId
    const issues = validateParams(op as OperationId, frame.params)
    if (issues.length > 0) throw new OperationError('invalid_request', issues.slice(0, 5).map(issue => `${issue.path} ${issue.message}`).join('; '))
    const optional = CONFIRMATION_UNLESS_ALLOWED.has(op)
    let confirmedWith: PairedHub | undefined
    const refuse = (error: RemoraError): never => { throw new OperationError(error.code, error.message, error) }
    const assertAuthorized = (): void => {
      if (this.deps.killSwitch()) refuse(killSwitchError())
      controller.signal.throwIfAborted()
      if (now() >= frame.deadline - (this.deps.marginMs ?? 1_000)) throw new DeadlineError()
      const decision = decide({ operation: op, ceiling: this.deps.ceiling(), hubGrant: frame.grant, tokenScopes: Array.isArray(frame.scopes) ? frame.scopes : [], now: now() })
      if (!decision.allowed) refuse(denialError(decision.layer, decision.reason))
      if (optional && this.deps.allowsWithoutConfirmation?.(op) !== true && frame.confirmation === undefined) refuse(passkeyRequiredError())
      if (confirmedWith) {
        const current = this.deps.pinned()
        const id = frame.confirmation?.assertion.credentialId
        const before = confirmedWith.owner.find(item => item.credentialId === id)
        const after = current?.owner.find(item => item.credentialId === id)
        if (!current || current.hostId !== confirmedWith.hostId || current.hubOrigin !== confirmedWith.hubOrigin || current.rpId !== confirmedWith.rpId
          || !before || !after || before.publicKey !== after.publicKey || before.algorithm !== after.algorithm) {
          refuse({ code: 'denied', message: 'The passkey confirmation is no longer trusted on this DSH host.', denial: { layer: 'dsh', reason: 'confirmation-failed' }, fix: 'hub:/' })
        }
      }
    }
    assertAuthorized()
    const required = REQUIRES_CONFIRMATION.has(op) || (optional && this.deps.allowsWithoutConfirmation?.(op as OperationId) !== true)
    if (optional && required && frame.confirmation === undefined) throw new Refusal(passkeyRequiredError())
    // A confirmation sent along anyway (the hub page always asks for the passkey) is still checked.
    if (required || (optional && frame.confirmation !== undefined)) {
      const pinned = this.deps.pinned()
      if (!pinned) throw new OperationError('unavailable', 'this host is not paired')
      const verdict = await verifyConfirmation({
        confirmation: frame.confirmation,
        pinned,
        requestId: frame.id,
        operation: op,
        params: frame.params,
        now: now(),
        isUsed: id => this.deps.confirmations.isUsed(id),
      })
      if (!verdict.ok) throw new ConfirmationDenied(verdict.failure)
      confirmedWith = pinned
      await this.deps.confirmations.markUsed(frame.id, (frame.confirmation?.issuedAt ?? now()) + 2 * CONFIRMATION_TTL_MS)
    }
    assertAuthorized()
    const budget = frame.deadline - now() - (this.deps.marginMs ?? 1_000)
    if (budget <= 0) throw new DeadlineError()
    const ceiling = () => this.deps.ceiling()
    const context: OperationContext = {
      actor: { clientId: String(frame.actor?.clientId ?? 'unknown'), clientName: String(frame.actor?.clientName ?? 'unknown') },
      requestId: frame.id,
      scopes: Array.isArray(frame.scopes) ? [...frame.scopes] : [],
      get fullAccess() { return effectiveFullAccess(ceiling(), frame.grant, now()) },
      signal: controller.signal,
      assertAuthorized,
    }
    if (typeof frame.taskId === 'string') context.taskId = frame.taskId
    if (typeof frame.idempotencyKey === 'string') context.idempotencyKey = frame.idempotencyKey
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DeadlineError())
        controller.abort(new DeadlineError())
      }, budget)
      timer.unref?.()
    })
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      assertAuthorized()
      const value = await Promise.race([handler(frame.params as never, context), deadline, aborted])
      return { value, assertAuthorized }
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
    }
  }

  private toError(error: unknown, frame: RequestFrame): RemoraError {
    if (error instanceof Refusal) return error.error
    if (error instanceof ConfirmationDenied) {
      return { code: 'denied', message: `The passkey confirmation could not be verified on the DSH host (${error.failure}). Confirm again on the hub.`, denial: { layer: 'dsh', reason: 'confirmation-failed' }, fix: 'hub:/' }
    }
    if (error instanceof DeadlineError) return { code: 'unavailable', message: 'The operation did not finish before the deadline.' }
    if (error instanceof OperationError) return sanitize(error)
    this.deps.log?.(`Remora: ${String(frame.op).slice(0, 64)} failed`, error)
    return { code: 'internal', message: 'Internal error on the DSH host.' }
  }
}

class Refusal extends Error {
  readonly error: RemoraError
  constructor(error: RemoraError) {
    super(error.message)
    this.error = error
  }
}

class ConfirmationDenied extends Error {
  readonly failure: string
  constructor(failure: string) {
    super(failure)
    this.failure = failure
  }
}
