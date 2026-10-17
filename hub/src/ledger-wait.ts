/**
 * Ledger notifications use accepted hibernating sockets. Only the outer Worker
 * owns a timeout: an idle Durable Object has no request or timer keeping it awake.
 * Short-lived signed capabilities keep this transport separate from host auth.
 */
import { TASK_WAIT_MAX_MS, fromBase64Url, toBase64Url } from './vendor/protocol/index.ts'
import { randomToken } from './util.ts'

export const WAIT_TAG = 'ledger-wait'
export const WAIT_PATH = '/internal/ledger-wait'
export const WAIT_HEADER = 'x-remora-ledger-wait'
export const WAIT_PER_CLIENT = 8
export const WAIT_PER_OBJECT = 128

export interface WaitAttachment {
  kind: 'ledger-wait'
  key: string
  clientId: string
  nonce: string
  expiresAt: number
}
interface Capability<T> { input: T; nonce: string; expiresAt: number }

const keyFor = (secret: string) => crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])

export async function mintWait<T>(secret: string, input: T): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ input, nonce: randomToken(18), expiresAt: Date.now() + 60_000 })))
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), new TextEncoder().encode(payload))
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`
}

export async function readWait<T>(secret: string | null, token: string | null): Promise<Capability<T> | null> {
  if (!secret || !token || token.length > 16_384) return null
  try {
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra) return null
    if (!await crypto.subtle.verify('HMAC', await keyFor(secret), fromBase64Url(signature), new TextEncoder().encode(payload))) return null
    const cap = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as Capability<T>
    return cap.expiresAt > Date.now() && cap.expiresAt <= Date.now() + 60_000 ? cap : null
  } catch { return null }
}

export function isWaitSocket(socket: WebSocket): boolean {
  return (socket.deserializeAttachment() as Partial<WaitAttachment> | null)?.kind === WAIT_TAG
}

export function openWait(ctx: DurableObjectState, attachment: WaitAttachment): { response: Response; server: WebSocket } | null {
  const now = Date.now()
  const sockets = ctx.getWebSockets(WAIT_TAG)
  const active = sockets.filter(socket => {
    const stored = socket.deserializeAttachment() as WaitAttachment
    if (stored.expiresAt <= now) { socket.close(1000, 'wait expired'); return false }
    return true
  })
  if (active.length >= WAIT_PER_OBJECT || active.filter(socket => (socket.deserializeAttachment() as WaitAttachment).clientId === attachment.clientId).length >= WAIT_PER_CLIENT || active.some(socket => (socket.deserializeAttachment() as WaitAttachment).nonce === attachment.nonce)) return null
  const { 0: client, 1: server } = new WebSocketPair()
  ctx.acceptWebSocket(server, [WAIT_TAG])
  server.serializeAttachment(attachment)
  return { response: new Response(null, { status: 101, webSocket: client }), server }
}

export function notifyWaiters(ctx: DurableObjectState, key?: string): void {
  for (const socket of ctx.getWebSockets(WAIT_TAG)) {
    const attachment = socket.deserializeAttachment() as WaitAttachment
    if (key !== undefined && attachment.key !== key && attachment.expiresAt > Date.now()) continue
    try { socket.send(JSON.stringify({ type: 'changed' })); socket.close(1000, 'wait ended') } catch { /* already closing */ }
  }
}

export function waitResult(server: WebSocket, outcome: unknown, waiting: boolean, timeoutMs: number): void {
  try {
    server.send(JSON.stringify({ type: 'result', outcome, waiting, timeoutMs }))
    if (!waiting) server.close(1000, 'ready')
  } catch { /* A change closed the socket while the initial query was running. */ }
}

/** Runs in the outer Worker, never inside a Durable Object. Null requests a fresh authorized read. */
export async function awaitWaitResponse<T>(response: Response, signal?: AbortSignal): Promise<T | null> {
  if (response.status !== 101 || !response.webSocket) return await response.json() as T
  const socket = response.webSocket
  return new Promise<T | null>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    const finish = (outcome: T | null, aborted = false) => {
      if (finished) return
      finished = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.removeEventListener('message', message)
      socket.removeEventListener('close', close)
      socket.removeEventListener('error', close)
      try { socket.close(1000, 'collector finished') } catch { /* already closed */ }
      if (aborted) reject(signal?.reason ?? new Error('Request aborted'))
      else resolve(outcome)
    }
    const abort = () => finish(null, true)
    const close = () => finish(null)
    const message = (event: MessageEvent) => {
      try {
        const frame = JSON.parse(String(event.data)) as { type: string; outcome: T; waiting: boolean; timeoutMs: number }
        if (frame.type !== 'result') { finish(null); return }
        if (!frame.waiting) { finish(frame.outcome); return }
        timer = setTimeout(() => finish(null), Math.max(0, Math.min(TASK_WAIT_MAX_MS, frame.timeoutMs)))
      } catch { finish(null) }
    }
    socket.addEventListener('message', message)
    socket.addEventListener('close', close)
    socket.addEventListener('error', close)
    signal?.addEventListener('abort', abort, { once: true })
    socket.accept()
    if (signal?.aborted) abort()
  })
}
