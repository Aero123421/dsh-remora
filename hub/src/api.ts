/**
 * HTTP API: `POST /api/v1/ops/<operationId>` with the params as the JSON
 * body and a bearer token (an OAuth token for the API audience, or a
 * personal token issued on the hub). Errors use `HttpErrorBody`.
 */
import { hubOrigin } from './config.ts'
import { errorResponse, json, readJson } from './http.ts'
import type { ApiCaller } from './oauth.ts'
import { runOperation } from './ops.ts'
import { ENDPOINTS, INPUT_SCHEMAS, OPERATIONS, type OperationId } from './vendor/protocol/index.ts'

export async function handleApi(request: Request, env: Env, _ctx: ExecutionContext, caller: ApiCaller): Promise<Response> {
  const url = new URL(request.url)
  const base = ENDPOINTS.ops.replace(/\/$/, '')
  if (url.pathname === base || url.pathname === ENDPOINTS.ops) {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: { allow: 'GET' } })
    return json({
      operations: OPERATIONS.map(spec => ({ id: spec.id, level: spec.level, scope: spec.scope, phase: spec.phase, readOnly: spec.readOnly, destructive: spec.destructive, description: spec.description, inputSchema: INPUT_SCHEMAS[spec.id as OperationId] })),
    })
  }
  let op: string
  try {
    op = decodeURIComponent(url.pathname.slice(ENDPOINTS.ops.length))
  } catch {
    return errorResponse({ code: 'invalid_request', message: 'The operation id in the path is not valid URL encoding.' })
  }
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
  let params: unknown
  try {
    params = await readJson(request, 256 * 1024)
  } catch {
    return errorResponse({ code: 'invalid_request', message: 'The body must be a JSON object of operation parameters.' })
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return errorResponse({ code: 'invalid_request', message: 'The body must be a JSON object of operation parameters.' })
  const outcome = await runOperation(env, { clientId: caller.props.clientId, clientName: caller.props.clientName, scopes: caller.auth.scope, kind: 'client' }, op, params, { origin: hubOrigin(request, env), signal: request.signal })
  return outcome.ok ? json(outcome.result ?? {}) : errorResponse(outcome.error)
}
