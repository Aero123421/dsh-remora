// The hub under `wrangler dev` (equivalent to `npx wrangler dev` in hub/,
// but launched through node so the process group is ours to stop), plus a
// small HTTP API client that turns "not implemented yet" into a Skip.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { childEnv, run, start } from './procs.mjs'
import { Skip } from './steps.mjs'

/** `npm ci` in hub/ when its dependencies are missing (hub/ keeps its own lockfile). */
export async function ensureHubDeps({ hubDir, logFile }) {
  const wrangler = join(hubDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  if (!existsSync(wrangler)) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    await run('npm ci (hub)', npm, ['ci', '--no-audit', '--no-fund'], { cwd: hubDir, env: childEnv(), logFile, timeoutMs: 300_000 })
  }
  return wrangler
}

/**
 * Start `wrangler dev` on 127.0.0.1:<port>. State is persisted to the
 * world's temp dir, so every run starts with an empty hub (no owner yet).
 * The browser and the plugin reach it as http://localhost:<port>: WebAuthn
 * refuses IP addresses as relying-party ids.
 */
export async function startHub({ hubDir, port, stateDir, setupToken, logFile, timeoutMs = 120_000 }) {
  const wrangler = await ensureHubDeps({ hubDir, logFile })
  const env = childEnv({
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    // Do not fetch https://workers.cloudflare.com/cf.json (Request.cf); use miniflare's placeholder.
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    WRANGLER_LOG_PATH: join(stateDir, 'wrangler-logs'),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  })
  const args = [wrangler, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', stateDir, '--show-interactive-dev-session=false', '--var', `SETUP_TOKEN:${setupToken}`]
  const proc = start('wrangler dev', process.execPath, args, { cwd: hubDir, env, logFile })
  await proc.waitFor(/Ready on https?:\/\/\S+/, timeoutMs, 'wrangler "Ready on"')
  const origin = `http://localhost:${port}`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const response = await fetch(`${origin}/healthz`)
      if (response.ok) return { proc, origin, health: await response.json() }
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`hub /healthz did not answer\n${proc.tail()}`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

export class HubError extends Error {
  constructor(op, status, body) {
    super(`${op}: HTTP ${status} ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)}`)
    this.status = status
    this.body = body
  }
}

/** HTTP API client for POST /api/v1/ops/<operationId>. */
export function hubApi(origin, token) {
  return async function call(op, params = {}, { allow = [] } = {}) {
    const response = await fetch(`${origin}/api/v1/ops/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
    })
    const text = await response.text()
    let body = text
    try { body = JSON.parse(text) } catch { /* keep text */ }
    if (response.status === 501) throw new Skip(`${op}: the hub answers 501 (${body?.error?.message ?? 'not implemented yet'})`)
    if (!response.ok && !allow.includes(response.status)) throw new HubError(op, response.status, body)
    return { status: response.status, body }
  }
}
