/**
 * Remora hub Worker.
 *
 * P0 scaffold: routing, the home page, the host WebSocket entry and the two
 * Durable Object classes. Passkeys, OAuth (workers-oauth-provider), MCP and
 * the REST API are stubbed with 501 and arrive in the next steps.
 */
import { HostDO } from './host-do.ts'
import { HubDO } from './hub-do.ts'
import { route } from './router.ts'
import { SECURITY_HEADERS, renderHome } from './ui.ts'
import { HUB_VERSION } from './version.ts'

export { HostDO, HubDO }

const notYet = (what: string) => Response.json({ error: { code: 'unavailable', message: `${what} is not implemented yet` } }, { status: 501 })

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    const target = route(request.method, url.pathname)
    switch (target.kind) {
      case 'home': {
        const status = await env.HUB.get(env.HUB.idFromName('hub')).status()
        return new Response(renderHome({ ...status, version: HUB_VERSION }), { headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' } })
      }
      case 'health':
        return Response.json({ ok: true, version: HUB_VERSION })
      case 'host-socket':
        return env.HOST.get(env.HOST.idFromName(target.hostId)).fetch(request)
      case 'mcp':
        return notYet('MCP')
      case 'api':
        return notYet('The HTTP API')
      case 'oauth':
        return notYet('OAuth')
      case 'method-not-allowed':
        return new Response('method not allowed', { status: 405, headers: { allow: target.allow } })
      case 'not-found':
        return new Response('not found', { status: 404 })
    }
  },
} satisfies ExportedHandler<Env>
