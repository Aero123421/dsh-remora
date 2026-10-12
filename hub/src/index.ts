/**
 * Remora hub Worker: passkey-only owner UI, host pairing and WebSockets,
 * OAuth (workers-oauth-provider) for MCP and the HTTP API.
 */
import { handleApi } from './api.ts'
import { handleAuth } from './auth.ts'
import { hubOrigin } from './config.ts'
import { HostDO } from './host-do.ts'
import { HubDO } from './hub-do.ts'
import { html } from './http.ts'
import { handleMcp } from './mcp.ts'
import { countWorkerRequest, hostStub, maybeFlush } from './meter.ts'
import { handleOAuth, oauthFor, registerProtectedHandlers } from './oauth.ts'
import { isPairedHost } from './ops.ts'
import { hostUnpair, pairApprovePage, pairApprovePost, pairPoll, pairStart } from './pair.ts'
import { route } from './router.ts'
import { h, page } from './ui/layout.ts'
import { handleUi } from './ui/routes.ts'
import { HUB_VERSION } from './version.ts'

export { HostDO, HubDO }

registerProtectedHandlers({ mcp: handleMcp, api: handleApi })

function notFound(): Response {
  return html(page({ title: '見つかりません', narrow: true, body: h`<h1>見つかりません</h1><p><a class="button" href="/">ホームへ</a></p>` }), { status: 404 })
}

async function dispatch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const target = route(request.method, url.pathname)
  switch (target.kind) {
    case 'health':
      return Response.json({ ok: true, version: HUB_VERSION })
    case 'host-socket': {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 })
      if (!(await isPairedHost(env, target.hostId))) return new Response('unknown host', { status: 404 })
      const forwarded = new Request(request)
      forwarded.headers.set('x-remora-origin', hubOrigin(request, env))
      return hostStub(env, target.hostId).fetch(forwarded)
    }
    case 'pair-start':
      return pairStart(request, env)
    case 'pair-poll':
      return pairPoll(request, env)
    case 'host-unpair':
      return hostUnpair(request, env)
    case 'pair-approve':
      return request.method === 'POST' ? pairApprovePost(request, env) : pairApprovePage(request, env)
    case 'auth':
      return handleAuth(request, env, target.path)
    case 'mcp':
      return oauthFor(hubOrigin(request, env), env).mcp.fetch(request, env, ctx)
    case 'api':
      if (!target.path.startsWith('/ops')) return Response.json({ error: { code: 'not_found', message: 'Use POST /api/v1/ops/<operationId>.' } }, { status: 404 })
      return oauthFor(hubOrigin(request, env), env).api.fetch(request, env, ctx)
    case 'oauth':
      return (await handleOAuth(request, env, ctx)) ?? notFound()
    case 'ui':
      return (await handleUi(request, env)) ?? notFound()
    case 'method-not-allowed':
      return new Response('method not allowed', { status: 405, headers: { allow: target.allow } })
    case 'not-found':
      return notFound()
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    countWorkerRequest()
    try {
      return await dispatch(request, env, ctx)
    } finally {
      maybeFlush(env, ctx)
    }
  },
} satisfies ExportedHandler<Env>
