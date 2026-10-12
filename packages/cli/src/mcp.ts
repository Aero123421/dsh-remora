/**
 * stdio MCP bridge. Local MCP clients (Claude Code, Codex, ...) start
 * `remora mcp`; every newline-delimited JSON-RPC message from stdin is POSTed
 * to the hub's stateless streamable-HTTP endpoint (`ENDPOINTS.mcp`) with the
 * CLI's bearer token, and the reply — JSON or an SSE stream — is written back
 * to stdout one message per line. Nothing but JSON-RPC goes to stdout.
 */
import { createInterface } from 'node:readline'
import { ENDPOINTS } from '@dsh-remora/protocol'
import type { Ctx } from './ctx.ts'
import { CliError } from './errors.ts'
import type { Hub } from './hub.ts'

/** Tried first by `mcp probe`: no handshake, `_meta` + header checks. */
export const MCP_MODERN_VERSION = '2026-07-28'
/** Fallback with the classic `initialize` handshake. */
export const MCP_LEGACY_VERSION = '2025-06-18'
/** @deprecated kept for callers of round 1 */
export const MCP_CLIENT_PROTOCOL_VERSION = MCP_LEGACY_VERSION
const META_VERSION = 'io.modelcontextprotocol/protocolVersion'

type Json = Record<string, unknown>

function requestIds(message: unknown): (string | number)[] {
  const items = Array.isArray(message) ? message : [message]
  return items.flatMap(m => {
    const r = m as Json | null
    return r && typeof r.method === 'string' && (typeof r.id === 'string' || typeof r.id === 'number') ? [r.id] : []
  })
}

function isInitialize(message: unknown): boolean {
  return !Array.isArray(message) && (message as Json | null)?.method === 'initialize'
}

/** RFC 2047-style encoding the hub decodes for non-ASCII header values. */
function headerValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

/**
 * MCP 2026-07-28 requests declare their version in `_meta` and must repeat
 * it (plus the method and tool name) in headers. The bridge derives those
 * headers from the message so a modern client works through it unchanged.
 */
function modernHeaders(message: unknown): Record<string, string> | null {
  if (Array.isArray(message)) return null
  const m = message as Json | null
  const params = (m?.params ?? {}) as Json
  const version = ((params._meta ?? {}) as Json)[META_VERSION]
  if (typeof version !== 'string' || typeof m?.method !== 'string') return null
  const headers: Record<string, string> = { 'mcp-protocol-version': version, 'mcp-method': m.method }
  if (m.method === 'tools/call' && typeof params.name === 'string') headers['mcp-name'] = headerValue(params.name)
  return headers
}

function rpcError(id: string | number | null, code: number, message: string): Json {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** Parse an SSE body, calling `onData` for each event's data. */
async function readSse(body: ReadableStream<Uint8Array>, onData: (data: string, event: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  let event = 'message'
  const dispatch = () => {
    if (data.length > 0) onData(data.join('\n'), event)
    data = []
    event = 'message'
  }
  const line = (raw: string) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (text === '') { dispatch(); return }
    if (text.startsWith(':')) return
    const colon = text.indexOf(':')
    const field = colon === -1 ? text : text.slice(0, colon)
    let value = colon === -1 ? '' : text.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
  }
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        line(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
    }
    buffer += decoder.decode()
    if (buffer) line(buffer)
    dispatch()
  } finally {
    reader.releaseLock()
  }
}

/** Sends JSON-RPC messages to the hub's MCP endpoint and collects what comes back. */
export class McpForwarder {
  readonly hub: Hub
  protocolVersion: string | null = null
  sessionId: string | null = null
  constructor(hub: Hub) { this.hub = hub }

  async send(message: unknown, emit: (reply: unknown) => void): Promise<void> {
    const ids = requestIds(message)
    const requested = new Set(ids)
    const pending = new Set(ids)
    const fail = (text: string) => {
      for (const id of pending) { pending.delete(id); emit(rpcError(id, -32000, text)) }
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    Object.assign(headers, modernHeaders(message) ?? {})
    let response: Response
    try {
      response = await this.hub.authorizedFetch('mcp', this.hub.url + ENDPOINTS.mcp, { method: 'POST', headers, body: JSON.stringify(message) })
    } catch (error) {
      const hint = error instanceof CliError && error.detail.hint ? ` ${error.detail.hint}` : ''
      fail(`Remora: ${(error as Error).message}${hint}`)
      return
    }
    const session = response.headers.get('mcp-session-id')
    if (session) this.sessionId = session
    const watch = (reply: unknown) => {
      const items = (Array.isArray(reply) ? reply : [reply]).filter(item => {
        const response = item as Json | null
        const id = response?.id
        if ((typeof id === 'string' || typeof id === 'number') && (response?.result !== undefined || response?.error !== undefined) && requested.has(id)) {
          if (!pending.delete(id)) return false
          if (isInitialize(message)) {
            const version = (response?.result as Json | undefined)?.protocolVersion
            if (typeof version === 'string') this.protocolVersion = version
          }
        }
        return true
      })
      if (items.length > 0) emit(Array.isArray(reply) ? items : items[0])
    }
    try {
      if (!response.ok) {
        let detail = ''
        try {
          const body = await response.json() as { jsonrpc?: unknown; error?: { message?: unknown } | string, error_description?: unknown }
          // A JSON-RPC error with an HTTP status (e.g. 400 unsupported version) goes to the client as is.
          if (body?.jsonrpc === '2.0' && ids.length > 0) { watch(body); fail('Remora: ハブが応答を返しませんでした'); return }
          const e = body?.error
          detail = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : ''
        } catch { /* not JSON */ }
        fail(`Remora: ハブがエラーを返しました（HTTP ${response.status}${detail ? `: ${detail}` : ''}）${response.status === 401 ? '。remora login でログインし直してください' : ''}`)
        return
      }
      const type = (response.headers.get('content-type') ?? '').toLowerCase()
      if (response.status === 202 || response.status === 204 || !response.body) {
        await response.body?.cancel().catch(() => {})
        fail('Remora: ハブが応答を返しませんでした')
        return
      }
      if (type.includes('text/event-stream')) {
        await readSse(response.body, (data, event) => {
          if (event !== 'message') return
          let parsed: unknown
          try { parsed = JSON.parse(data) } catch { return }
          watch(parsed)
        })
        fail('Remora: ハブとの接続が応答の途中で切れました')
        return
      }
      const text = await response.text()
      if (!text.trim()) { fail('Remora: ハブが空の応答を返しました'); return }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        fail('Remora: ハブの応答が JSON ではありません')
        return
      }
      watch(parsed)
      fail('Remora: ハブが応答を返しませんでした')
    } catch {
      // A response may fail after its headers, or after only part of a batch.
      // Report only unanswered requests; notifications never get an error reply.
      fail('Remora: ハブとの接続が応答の途中で切れました')
    }
  }
}

/** Run the stdio bridge until stdin closes. */
export async function runMcpBridge(ctx: Ctx, hub: Hub): Promise<number> {
  const forwarder = new McpForwarder(hub)
  const pending = new Set<Promise<void>>()
  const write = (reply: unknown) => ctx.out(JSON.stringify(reply))
  const rl = createInterface({ input: ctx.stdin, crlfDelay: Infinity })
  let chain: Promise<void> = Promise.resolve()
  for await (const raw of rl) {
    const line = raw.trim()
    if (!line) continue
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      write(rpcError(null, -32700, 'Parse error'))
      continue
    }
    // `initialize` must finish before anything else so the negotiated
    // protocol version is known; later messages run concurrently.
    const task = isInitialize(message)
      ? (chain = chain.then(() => forwarder.send(message, write)))
      : chain.then(() => forwarder.send(message, write))
    const tracked = task.catch(error => { ctx.err(`remora mcp: ${(error as Error).message}`) }).finally(() => { pending.delete(tracked) })
    pending.add(tracked)
  }
  await Promise.all(pending)
  return 0
}

export interface ProbeResult {
  serverInfo: unknown
  protocolVersion: unknown
  tools: { name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]
}

/**
 * Try MCP 2026-07-28 (`server/discover`, no handshake) first; when the hub
 * refuses it, fall back to the 2025-06-18 `initialize` handshake. Then list
 * every tool (following cursors).
 */
export async function probe(hub: Hub): Promise<ProbeResult> {
  const forwarder = new McpForwarder(hub)
  let nextId = 1
  let modern = false
  const call = async (method: string, params: Json): Promise<Json> => {
    const id = nextId++
    const replies: unknown[] = []
    const withMeta = modern ? { ...params, _meta: { ...(params._meta as Json | undefined), [META_VERSION]: MCP_MODERN_VERSION } } : params
    await forwarder.send({ jsonrpc: '2.0', id, method, params: withMeta }, reply => { replies.push(...(Array.isArray(reply) ? reply : [reply])) })
    const reply = replies.find(r => (r as Json | null)?.id === id) as Json | undefined
    if (!reply) throw new CliError(`${method} の応答がありません。`)
    if (reply.error) throw new CliError(`${method} が失敗しました: ${String((reply.error as Json).message)}`)
    return reply.result as Json
  }
  let serverInfo: unknown
  let protocolVersion: unknown
  modern = true
  try {
    const discovered = await call('server/discover', {})
    const versions = discovered.supportedVersions
    if (Array.isArray(versions) && !versions.includes(MCP_MODERN_VERSION)) throw new CliError('2026-07-28 is not supported')
    serverInfo = ((discovered._meta ?? {}) as Json)['io.modelcontextprotocol/serverInfo'] ?? discovered.serverInfo
    protocolVersion = MCP_MODERN_VERSION
  } catch {
    modern = false
    const init = await call('initialize', { protocolVersion: MCP_LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'remora-cli', version: '0' } })
    if (typeof init.protocolVersion === 'string') forwarder.protocolVersion = init.protocolVersion
    await forwarder.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, () => {})
    serverInfo = init.serverInfo
    protocolVersion = init.protocolVersion
  }
  const tools: ProbeResult['tools'] = []
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const result = await call('tools/list', cursor ? { cursor } : {})
    tools.push(...((result.tools as ProbeResult['tools'] | undefined) ?? []))
    cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined
    if (!cursor) break
  }
  return { serverInfo, protocolVersion, tools }
}
