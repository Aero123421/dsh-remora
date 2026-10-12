/**
 * One Durable Object per DSH host. Holds the host's outbound WebSocket using
 * the Hibernation API, so an idle connection costs nothing; the keepalive is
 * answered by `setWebSocketAutoResponse` without waking the object.
 *
 * P0 scaffold: handshake skeleton only. Signature verification against the
 * paired Ed25519 key, the task ledger and request relaying come next.
 */
import { DurableObject } from 'cloudflare:workers'
import { KEEPALIVE_PING, KEEPALIVE_PONG, isSupportedProtocol, parseHostFrame, type HubFrame } from './vendor/protocol/index.ts'

interface Attachment {
  stage: 'challenged' | 'hello' | 'ready'
  nonce: string
  issuedAt: number
  hostId?: string
}

const send = (ws: WebSocket, frame: HubFrame) => ws.send(JSON.stringify(frame))

export class HostDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG))
    ctx.blockConcurrencyWhile(async () => {
      // Prompts are deleted once delivered; audit rows never hold content.
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          task_id TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          state TEXT NOT NULL,
          prompt TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (client_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS audit (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          actor TEXT NOT NULL,
          operation TEXT NOT NULL,
          outcome TEXT NOT NULL,
          prev_hash TEXT NOT NULL,
          hash TEXT NOT NULL
        );
      `)
    })
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('expected a WebSocket upgrade', { status: 426 })
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    const attachment: Attachment = { stage: 'challenged', nonce: crypto.randomUUID(), issuedAt: Date.now() }
    server.serializeAttachment(attachment)
    send(server, { t: 'challenge', nonce: attachment.nonce, issuedAt: attachment.issuedAt, origin: new URL(request.url).origin })
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') { ws.close(1003, 'text frames only'); return }
    let frame
    try { frame = parseHostFrame(message) } catch { ws.close(1007, 'invalid frame'); return }
    const attachment = ws.deserializeAttachment() as Attachment
    switch (frame.t) {
      case 'hello':
        if (!isSupportedProtocol(frame.protocol)) {
          send(ws, { t: 'close', reason: 'protocol_mismatch' })
          ws.close(4000, 'protocol mismatch')
          return
        }
        ws.serializeAttachment({ ...attachment, stage: 'hello', hostId: frame.hostId } satisfies Attachment)
        return
      case 'auth':
        // Pairing is not implemented yet, so no host can authenticate.
        send(ws, { t: 'close', reason: 'auth_failed' })
        ws.close(4001, 'pairing is not available yet')
        return
      default:
        if (attachment.stage !== 'ready') ws.close(4001, 'not authenticated')
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code === 1005 ? 1000 : code, 'closing')
  }
}
