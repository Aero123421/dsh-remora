/** Mapping DSH failures to Remora `OperationError`s. */
import { fixFor } from '@dsh-remora/protocol'
import { OperationError } from '../ops/types.ts'
import type { DshRemoteErrorLike } from './dsh-types.ts'

export function isRemoteError(error: unknown): error is DshRemoteErrorLike {
  return typeof error === 'object' && error !== null
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { message?: unknown }).message === 'string'
}

/** Scope refusal on the DSH side (workspace/session not reachable from outside). */
export function denied(message: string): OperationError {
  return new OperationError('denied', message, { denial: { layer: 'dsh', reason: 'out-of-scope' }, fix: fixFor('dsh') })
}

export function invalid(message: string): OperationError {
  return new OperationError('invalid_request', message)
}

export function notFound(message: string): OperationError {
  return new OperationError('not_found', message)
}

export function unavailable(message: string): OperationError {
  return new OperationError('unavailable', message)
}

/** Translate a DSH `RemoteError` (namespaced code) or any thrown value. Messages are kept short and DSH-free of paths where possible. */
export function fromDsh(error: unknown, what: string): OperationError {
  if (error instanceof OperationError) return error
  if (isRemoteError(error)) {
    const code = error.code
    const message = `${what}: ${error.message}`
    switch (code) {
      case 'session/not-found':
      case 'workspace/not-found':
      case 'job/not-found':
      case 'session/queue-item-not-found':
        return new OperationError('not_found', message)
      case 'gateway/bad-request':
      case 'session/attachment-invalid':
      case 'session/title-invalid':
      case 'session/invalid-time-zone':
      case 'workspace/invalid-path':
        return new OperationError('invalid_request', message)
      case 'session/writer-held':
      case 'session/agent-busy':
      case 'session/conflict':
      case 'agent-preset/conflict':
      case 'session/steer-unavailable':
        return new OperationError('conflict', message)
      case 'session/model-unavailable':
      case 'session/provider-models-unavailable':
      case 'session/provider-credentials-unavailable':
      case 'session/migration-required':
      case 'session/projections-unavailable':
        return new OperationError('unavailable', message)
      case 'gateway/cancelled':
        return new OperationError('unavailable', `${what}: cancelled`)
      default:
        if (/^[A-Z_]+$/.test(code)) return new OperationError('conflict', message) // HarnessError codes (GoalError, UserQuestionError)
        return new OperationError('internal', message)
    }
  }
  return new OperationError('internal', `${what}: ${error instanceof Error ? error.message : String(error)}`)
}
