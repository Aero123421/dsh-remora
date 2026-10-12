/** A stand-in for the Cloudflare hub: pairing over HTTP and the host WebSocket. */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  KEEPALIVE_PING, KEEPALIVE_PONG, hostAuthMessage, pairPollMessage, parseHostFrame, rotateKeyMessage, unpairMessage,
  type HostFrame, type HubFrame, type OwnerCredential,
} from '@dsh-remora/protocol'

export interface FakeHubOptions {
  port: number
  owner: OwnerCredential[]
  /** Number of `pending` answers before approval. */
  pendingPolls?: number
  approve?: 'approved' | 'denied'
  rpId?: string
}

function ed25519Key(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' })
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

export class FakeHub {
  readonly origin: string
  readonly options: FakeHubOptions
  readonly hostId = 'host_test1'
  publicKey: string | null = null
  /** A key proved during a rotation, accepted until a handshake decides (like the real hub). */
  nextKey: string | null = null
  /** Rotation handshakes seen: which key each one used. */
  readonly keysUsed: ('current' | 'next')[] = []
  pollSignaturesValid = true
  polls = 0
  /** Set when the host removed itself with a valid signature. */
  unpaired = false
  /** Frames received from the host after authentication, newest last. */
  readonly received: HostFrame[] = []
  readonly hellos: HostFrame[] = []
  authFailures = 0
  connections = 0
  socket: WebSocket | null = null
  /** Do not answer keepalive pings. */
  silent = false
  /** Answer `close: auth_failed` instead of `ready`. */
  rejectAuth = false
  challengeOrigin: string | null = null
  private server: Server
  private wss: WebSocketServer

  constructor(options: FakeHubOptions) {
    this.options = options
    this.origin = `http://127.0.0.1:${options.port}`
    this.server = createServer((req, res) => { void this.http(req, res) })
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== `/ws/host/${this.hostId}`) { socket.destroy(); return }
      this.wss.handleUpgrade(req, socket, head, ws => this.onSocket(ws))
    })
  }

  listen(): Promise<void> {
    return new Promise(resolve => this.server.listen(this.options.port, '127.0.0.1', () => resolve()))
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate()
    await new Promise<void>(resolve => this.wss.close(() => resolve()))
    this.server.closeAllConnections()
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private async http(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.method === 'POST' && req.url === '/pair/start') {
      const input = await body(req)
      this.publicKey = input.publicKey as string
      reply(200, { pairingId: 'pair-1', userCode: 'ABCD2345', verifyUrl: `${this.origin}/pair?code=ABCD-2345`, expiresAt: Date.now() + 600_000, pollIntervalMs: 1000 })
      return
    }
    if (req.method === 'POST' && req.url === '/pair/poll') {
      const input = await body(req)
      this.polls++
      const ok = this.publicKey !== null && verify(null, Buffer.from(pairPollMessage(this.origin, input.pairingId as string)), ed25519Key(this.publicKey), Buffer.from(input.signature as string, 'base64url'))
      if (!ok) { this.pollSignaturesValid = false; reply(401, { error: 'bad signature' }); return }
      if (this.polls <= (this.options.pendingPolls ?? 0)) { reply(200, { status: 'pending' }); return }
      if (this.options.approve === 'denied') { reply(200, { status: 'denied' }); return }
      reply(200, { status: 'approved', hostId: this.hostId, hubOrigin: this.origin, rpId: this.options.rpId ?? '127.0.0.1', owner: this.options.owner })
      return
    }
    if (req.method === 'POST' && req.url === '/pair/unpair') {
      const input = await body(req)
      const ok = this.publicKey !== null && input.hostId === this.hostId
        && verify(null, Buffer.from(unpairMessage(this.origin, this.hostId, input.issuedAt as number)), ed25519Key(this.publicKey), Buffer.from(input.signature as string, 'base64url'))
      if (!ok) { reply(401, { error: 'bad signature' }); return }
      this.unpaired = true
      reply(200, { ok: true })
      return
    }
    reply(404, {})
  }

  private onSocket(ws: WebSocket): void {
    this.connections++
    const nonce = `nonce-${this.connections}`
    const issuedAt = Date.now()
    let stage: 'challenged' | 'hello' | 'ready' = 'challenged'
    ws.send(JSON.stringify({ t: 'challenge', nonce, issuedAt, origin: this.challengeOrigin ?? this.origin }))
    ws.on('message', data => {
      const text = data.toString()
      if (text === KEEPALIVE_PING) { if (!this.silent) ws.send(KEEPALIVE_PONG); return }
      const frame = parseHostFrame(text)
      if (frame.t === 'hello') { stage = 'hello'; this.hellos.push(frame); return }
      if (frame.t === 'auth') {
        const message = Buffer.from(hostAuthMessage(this.origin, this.hostId, nonce, issuedAt))
        const signedBy = (key: string | null) => key !== null && verify(null, message, ed25519Key(key), Buffer.from(frame.signature, 'base64url'))
        const current = stage === 'hello' && frame.nonce === nonce && signedBy(this.publicKey)
        const next = !current && stage === 'hello' && frame.nonce === nonce && signedBy(this.nextKey)
        if ((!current && !next) || this.rejectAuth) { this.authFailures++; this.send({ t: 'close', reason: 'auth_failed' }, ws); ws.close(4001); return }
        if (next) { this.publicKey = this.nextKey; this.nextKey = null; this.keysUsed.push('next') } else if (this.nextKey) { this.nextKey = null; this.keysUsed.push('current') }
        stage = 'ready'
        this.socket = ws
        this.send({ t: 'ready', connectionId: `conn-${this.connections}` }, ws)
        return
      }
      if (stage === 'ready') this.received.push(frame)
    })
    ws.on('close', () => { if (this.socket === ws) this.socket = null })
  }

  /** Ask the host for a new key, check its proof like the hub does, and accept it (hub side of host.rotate-key). */
  async rotate(options: { forgetNext?: boolean } = {}): Promise<string> {
    const nonce = `rotate-${Date.now()}`
    const issuedAt = Date.now()
    this.send({ t: 'rotate-key', nonce, issuedAt })
    const started = Date.now()
    let proof: Extract<HostFrame, { t: 'rotate-key-proof' }> | undefined
    while (!proof) {
      proof = this.received.find((frame): frame is Extract<HostFrame, { t: 'rotate-key-proof' }> => frame.t === 'rotate-key-proof' && frame.nonce === nonce)
      if (Date.now() - started > 3000) throw new Error('no rotate-key-proof')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const message = Buffer.from(rotateKeyMessage(this.origin, this.hostId, nonce, issuedAt, proof.publicKey))
    const ok = verify(null, message, ed25519Key(this.publicKey as string), Buffer.from(proof.signature, 'base64url'))
      && verify(null, message, ed25519Key(proof.publicKey), Buffer.from(proof.newSignature, 'base64url'))
    if (!ok) throw new Error('the rotation proof does not verify')
    // forgetNext: as if the hub dropped the new key before the host came back (it must fall back to the old one).
    this.nextKey = options.forgetNext ? null : proof.publicKey
    this.send({ t: 'rotate-key-commit', nonce, publicKey: proof.publicKey })
    return proof.publicKey
  }

  send(frame: HubFrame, ws: WebSocket | null = this.socket): void {
    ws?.send(JSON.stringify(frame))
  }

  /** Wait for a response frame with this id. */
  async response(id: string, timeoutMs = 3000): Promise<Extract<HostFrame, { t: 'response' }>> {
    const started = Date.now()
    for (;;) {
      const found = this.received.find(frame => frame.t === 'response' && frame.id === id)
      if (found) return found as Extract<HostFrame, { t: 'response' }>
      if (Date.now() - started > timeoutMs) throw new Error(`no response for ${id}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  events(): Extract<HostFrame, { t: 'event' }>['events'] {
    return this.received.flatMap(frame => (frame.t === 'event' ? frame.events : []))
  }
}
