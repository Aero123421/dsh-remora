/**
 * Handles every `request` frame from the hub:
 *
 *   1. the operation exists and this host serves it
 *   2. params match the operation's input schema
 *   3. the kill switch is off
 *   4. decide(DSH ceiling, hub grant, token scopes) allows it
 *   5. for REQUIRES_CONFIRMATION: the owner's passkey assertion verifies
 *      against the pinned credentials, and its requestId is recorded as used
 *   6. the adapter handler runs with a timeout before `frame.deadline`
 *
 * `OperationError` becomes a structured error; anything else becomes
 * `internal` without details (the cause is logged locally only). Every
 * request is written to the local audit log.
 */
import {
  CONFIRMATION_TTL_MS, OPERATIONS, REQUIRES_CONFIRMATION, decide, fixFor, validateParams,
  type DenialLayer, type DenialReason, type Grant, type OperationId, type RemoraError, type RequestFrame, type ResponseFrame,
} from '@dsh-remora/protocol'
import { OperationError, type HostOperationId, type OperationContext, type OperationHandler, type OperationHandlers } from '../ops/types.ts'
import type { AuditInput } from './audit.ts'
import { verifyConfirmation } from './confirmation.ts'
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
  pinned: () => PairedHub | null
  confirmations: ConfirmationLedger
  audit: (entry: AuditInput) => void
  respond: (frame: ResponseFrame) => void
  now?: () => number
  /** Time kept back before the hub's deadline for the response to travel. */
  marginMs?: number
  log?: (message: string, error?: unknown) => void
}

const HUB_ONLY: ReadonlySet<string> = new Set(['status', 'hosts.list'])

const DENIAL_MESSAGES: Readonly<Record<DenialLayer, string>> = {
  dsh: 'Refused by the permission ceiling set on the DSH host (Remora settings tab).',
  hub: 'Refused by the access this client was granted on the hub.',
  token: 'The access token does not carry the scope this operation needs.',
}

export function denialError(layer: DenialLayer, reason: DenialReason, message = DENIAL_MESSAGES[layer]): RemoraError {
  return { code: 'denied', message, denial: { layer, reason }, fix: fixFor(layer) }
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

class DeadlineError extends Error {}

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
    for (const controller of this.inflight.values()) controller.abort(new Error(reason))
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
      const result = await this.run(frame, controller, now)
      response = { t: 'response', id: frame.id, ok: true, result }
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

  private async run(frame: RequestFrame, controller: AbortController, now: () => number): Promise<unknown> {
    const spec = OPERATIONS.find(op => op.id === frame.op)
    const handler = spec && !HUB_ONLY.has(spec.id) ? (this.deps.handlers()[spec.id as HostOperationId] as OperationHandler<HostOperationId> | undefined) : undefined
    if (!spec || !handler) throw new OperationError('not_found', `operation ${String(frame.op).slice(0, 64)} is not available on this host`)
    const op = spec.id as HostOperationId
    const issues = validateParams(op as OperationId, frame.params)
    if (issues.length > 0) throw new OperationError('invalid_request', issues.slice(0, 5).map(issue => `${issue.path} ${issue.message}`).join('; '))
    if (this.deps.killSwitch()) throw new Refusal(killSwitchError())
    const decision = decide({ operation: op, ceiling: this.deps.ceiling(), hubGrant: frame.grant, tokenScopes: Array.isArray(frame.scopes) ? frame.scopes : [], now: now() })
    if (!decision.allowed) throw new Refusal(denialError(decision.layer, decision.reason))
    if (REQUIRES_CONFIRMATION.has(op)) {
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
      await this.deps.confirmations.markUsed(frame.id, (frame.confirmation?.issuedAt ?? now()) + 2 * CONFIRMATION_TTL_MS)
    }
    const budget = frame.deadline - now() - (this.deps.marginMs ?? 1_000)
    if (budget <= 0) throw new DeadlineError()
    const context: OperationContext = {
      actor: { clientId: String(frame.actor?.clientId ?? 'unknown'), clientName: String(frame.actor?.clientName ?? 'unknown') },
      requestId: frame.id,
      scopes: Array.isArray(frame.scopes) ? [...frame.scopes] : [],
      signal: controller.signal,
    }
    if (typeof frame.taskId === 'string') context.taskId = frame.taskId
    if (typeof frame.idempotencyKey === 'string') context.idempotencyKey = frame.idempotencyKey
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DeadlineError())
        controller.abort(new Error('deadline'))
      }, budget)
      timer.unref?.()
    })
    try {
      return await Promise.race([handler(frame.params as never, context), deadline])
    } finally {
      clearTimeout(timer)
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
