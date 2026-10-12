import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEEPALIVE_PING, KEEPALIVE_PONG } from '@dsh-remora/protocol'
import { BACKOFF_CAP_MS, HubLink, SLOW_RETRY_MS, backoffDelay, socketUrl, type SocketLike } from '../src/core/connection.ts'
import type { Clock } from '../src/core/events.ts'
import { HostKey } from '../src/core/hostkey.ts'

function manualClock() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: handle => { timers.delete(handle as number) },
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at
      timers.delete(due[0])
      due[1].fn()
    }
    now = target
  }
  return { clock, advance }
}

class FakeSocket implements SocketLike {
  readyState = 1
  sent: string[] = []
  closed: { code: number | undefined; reason: string | undefined } | null = null
  private listeners: Record<string, ((event: never) => void)[]> = {}
  addEventListener(type: string, listener: (event: never) => void): void {
    (this.listeners[type] ??= []).push(listener)
  }
  send(data: string): void { this.sent.push(data) }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; this.readyState = 3 }
  receive(data: unknown): void { for (const l of this.listeners.message ?? []) l({ data } as never) }
  closeFromServer(code = 1006): void { this.readyState = 3; for (const l of this.listeners.close ?? []) l({ code, reason: '' } as never) }
}

const hubOrigin = 'https://hub.example.com'
const paired = { hostId: 'h1', hubOrigin, rpId: 'hub.example.com', owner: [], publicKey: '', pairedAt: 0 }

function setup() {
  const { clock, advance } = manualClock()
  const key = HostKey.generate()
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const fatal: string[] = []
  let ready = 0
  const link = new HubLink({
    paired: () => ({ ...paired, publicKey: key.publicKey }),
    key: () => key,
    hello: () => ({ name: 'pc', plugin: { version: '1' }, dsh: { version: null }, operations: [], ceiling: { level: 'view' }, killSwitch: false }),
    onReady: () => { ready++ },
    onRequest: () => {},
    onOwnerCredentials: () => {},
    onFatal: reason => { fatal.push(reason) },
    createSocket: url => { urls.push(url); const s = new FakeSocket(); sockets.push(s); return s },
    clock,
    random: () => 0.5,
  })
  const handshake = (socket: FakeSocket, origin = hubOrigin) => {
    socket.receive(JSON.stringify({ t: 'challenge', nonce: 'n1', issuedAt: 5, origin }))
    socket.receive(JSON.stringify({ t: 'ready', connectionId: 'c' }))
  }
  return { link, sockets, urls, fatal, advance, handshake, ready: () => ready }
}

test('socket URLs and backoff with jitter', () => {
  assert.equal(socketUrl('https://hub.example.com', 'h1'), 'wss://hub.example.com/ws/host/h1')
  assert.equal(socketUrl('http://127.0.0.1:8787', 'h1'), 'ws://127.0.0.1:8787/ws/host/h1')
  assert.equal(backoffDelay(0, () => 0), 500)
  assert.equal(backoffDelay(0, () => 1), 1000)
  assert.equal(backoffDelay(30, () => 1), BACKOFF_CAP_MS)
})

test('handshake signs for the pinned origin, keeps alive, and reconnects when pongs stop', () => {
  const t = setup()
  t.link.start()
  const first = t.sockets[0] as FakeSocket
  t.handshake(first)
  assert.equal(t.link.status.state, 'connected')
  assert.equal(t.ready(), 1)
  assert.deepEqual(first.sent.map(s => (JSON.parse(s) as { t: string }).t), ['hello', 'auth'])
  t.advance(30_000)
  assert.equal(first.sent.at(-1), KEEPALIVE_PING)
  first.receive(KEEPALIVE_PONG)
  t.advance(30_000)
  assert.equal(t.link.status.state, 'connected')
  t.advance(10_000)
  assert.equal(t.link.status.state, 'backoff')
  assert.equal(t.link.status.lastError, 'keepalive-timeout')
  assert.ok(first.closed)
  t.advance(1_000)
  assert.equal(t.sockets.length, 2)
  t.handshake(t.sockets[1] as FakeSocket)
  assert.equal(t.link.status.state, 'connected')
  assert.equal(t.link.status.attempts, 0)
})

test('a challenge for another origin is never signed', () => {
  const t = setup()
  t.link.start()
  const socket = t.sockets[0] as FakeSocket
  socket.receive(JSON.stringify({ t: 'challenge', nonce: 'n1', issuedAt: 5, origin: 'https://evil.example.com' }))
  assert.deepEqual(socket.sent, [])
  assert.equal(t.link.status.lastError, 'origin-mismatch')
  assert.ok((t.link.status.retryAt ?? 0) >= SLOW_RETRY_MS)
})

test('auth failures back off slowly; a protocol mismatch stops reconnecting', () => {
  const t = setup()
  t.link.start()
  ;(t.sockets[0] as FakeSocket).receive(JSON.stringify({ t: 'close', reason: 'auth_failed' }))
  assert.equal(t.link.status.state, 'backoff')
  assert.ok((t.link.status.retryAt ?? 0) >= SLOW_RETRY_MS)
  t.advance(SLOW_RETRY_MS)
  const second = t.sockets[1] as FakeSocket
  second.closeFromServer(1006)
  assert.equal(t.link.status.lastError, 'closed:1006')
  assert.equal(t.link.status.attempts, 2)
  t.advance(2_000)
  assert.equal(t.sockets.length, 3)
  ;(t.sockets[2] as FakeSocket).receive(JSON.stringify({ t: 'close', reason: 'protocol_mismatch' }))
  assert.equal(t.link.status.state, 'stopped')
  assert.deepEqual(t.fatal, ['protocol_mismatch'])
  t.advance(BACKOFF_CAP_MS * 2)
  assert.equal(t.sockets.length, 3, 'no reconnect after protocol mismatch')
})

test('the handshake times out', () => {
  const t = setup()
  t.link.start()
  t.advance(15_000)
  assert.equal(t.link.status.lastError, 'handshake-timeout')
})
