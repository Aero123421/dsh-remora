/**
 * The outbound WebSocket to the hub (`/ws/host/<hostId>`).
 *
 *   hub  -> challenge { nonce, issuedAt, origin }
 *   host -> hello { name, versions, operations, ceiling, killSwitch }
 *   host -> auth { nonce, signature over hostAuthMessage(origin, hostId, nonce, issuedAt) }
 *   hub  -> ready, then requests / owner-credentials
 *
 * The host refuses to sign a challenge for any origin other than the pinned
 * hub origin. Reconnects use exponential backoff with jitter. Keepalive is
 * the fixed text pair KEEPALIVE_PING/KEEPALIVE_PONG every 30 s (Node's
 * WebSocket has no protocol-level ping); a missing pong reconnects.
 *
 * Proxies: Node 22's global WebSocket (undici) goes through HTTP(S)_PROXY
 * only when DSH is started with NODE_USE_ENV_PROXY=1 (Node ≥ 22.21 / 24.5).
 * The settings tab warns when a proxy variable is set without it.
 */
import {
  KEEPALIVE_PING, KEEPALIVE_PONG, PROTOCOL_VERSION, hostAuthMessage, hostSocketPath, parseHubFrame,
  type CloseFrame, type HelloFrame, type HostFrame, type OwnerCredential, type RequestFrame,
} from '@dsh-remora/protocol'
import { systemClock, type Clock } from './events.ts'
import type { HostKey } from './hostkey.ts'
import type { PairedHub } from './settings.ts'

export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
}

const OPEN = 1

export type LinkState = 'idle' | 'connecting' | 'authenticating' | 'connected' | 'backoff' | 'stopped'

export interface LinkStatus {
  state: LinkState
  since: number
  /** Last failure, e.g. `auth_failed`, `keepalive-timeout`, `origin-mismatch`, `closed:1006`. */
  lastError: string | null
  /** Consecutive failed attempts. */
  attempts: number
  /** When the next attempt starts (state `backoff`). */
  retryAt: number | null
  connectedAt: number | null
}

export type HelloContent = Pick<HelloFrame, 'name' | 'plugin' | 'dsh' | 'operations' | 'ceiling' | 'killSwitch'>

export interface HubLinkDeps {
  paired: () => PairedHub | null
  key: () => HostKey | null
  hello: () => HelloContent
  onReady: () => void
  onRequest: (frame: RequestFrame) => void
  onOwnerCredentials: (credentials: OwnerCredential[]) => void
  /** `protocol_mismatch` and `revoked` stop reconnecting. */
  onFatal: (reason: CloseFrame['reason']) => void
  onStatus?: (status: LinkStatus) => void
  createSocket?: (url: string) => SocketLike
  clock?: Clock
  random?: () => number
  keepaliveMs?: number
  pongTimeoutMs?: number
  handshakeTimeoutMs?: number
  log?: (message: string) => void
}

export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_CAP_MS = 60_000
/** After auth failures and duplicate connections the hub is not hammered. */
export const SLOW_RETRY_MS = 60_000

/** Equal-jitter exponential backoff. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempt, 16))
  return Math.round(cap / 2 + random() * (cap / 2))
}

export function socketUrl(hubOrigin: string, hostId: string): string {
  const url = new URL(hostSocketPath(hostId), hubOrigin)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  return url.toString()
}

export class HubLink {
  private readonly deps: HubLinkDeps
  private readonly clock: Clock
  private socket: SocketLike | null = null
  private generation = 0
  private running = false
  private timers = new Set<unknown>()
  private keepaliveTimer: unknown = null
  private pongTimer: unknown = null
  private retryTimer: unknown = null
  private current: LinkStatus

  constructor(deps: HubLinkDeps) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
    this.current = { state: 'idle', since: this.clock.now(), lastError: null, attempts: 0, retryAt: null, connectedAt: null }
  }

  get status(): LinkStatus {
    return this.current
  }

  get connected(): boolean {
    return this.current.state === 'connected'
  }

  private update(patch: Partial<LinkStatus>): void {
    const state = patch.state ?? this.current.state
    this.current = { ...this.current, ...patch, since: state !== this.current.state ? this.clock.now() : this.current.since }
    this.deps.onStatus?.(this.current)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.update({ attempts: 0, lastError: null })
    this.connect()
  }

  /** Close the link and stop reconnecting. */
  stop(state: 'idle' | 'stopped' = 'idle', error: string | null = this.current.lastError): void {
    this.running = false
    this.generation++
    this.clearTimers()
    const socket = this.socket
    this.socket = null
    if (socket) try { socket.close(1000, 'closing') } catch { /* the socket is already closed */ }
    this.update({ state, lastError: error, retryAt: null, connectedAt: null })
  }

  /** Drop the current socket and reconnect now (e.g. after settings changed). */
  reconnect(): void {
    if (!this.running) { this.start(); return }
    this.drop('reconnect', 0)
  }

  /** Send a frame if the link is up. */
  send(frame: HostFrame): boolean {
    if (this.current.state !== 'connected' || !this.socket || this.socket.readyState !== OPEN) return false
    try {
      this.socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  private setTimer(fn: () => void, ms: number): unknown {
    const handle = this.clock.setTimeout(() => { this.timers.delete(handle); fn() }, ms)
    this.timers.add(handle)
    return handle
  }

  private clearTimer(handle: unknown): void {
    if (handle === null) return
    this.clock.clearTimeout(handle)
    this.timers.delete(handle)
  }

  private clearTimers(): void {
    for (const handle of this.timers) this.clock.clearTimeout(handle)
    this.timers.clear()
    this.keepaliveTimer = null
    this.pongTimer = null
    this.retryTimer = null
  }

  private connect(): void {
    const paired = this.deps.paired()
    const key = this.deps.key()
    if (!paired || !key) { this.stop('idle', 'not-paired'); return }
    const generation = ++this.generation
    this.update({ state: 'connecting', retryAt: null })
    let socket: SocketLike
    try {
      socket = (this.deps.createSocket ?? (url => new WebSocket(url) as unknown as SocketLike))(socketUrl(paired.hubOrigin, paired.hostId))
    } catch (error) {
      this.deps.log?.(`Remora: could not open the hub connection: ${(error as Error).message}`)
      this.scheduleRetry('socket-error', 0)
      return
    }
    this.socket = socket
    const handshake = this.setTimer(() => { if (generation === this.generation) this.drop('handshake-timeout', 0) }, this.deps.handshakeTimeoutMs ?? 15_000)
    socket.addEventListener('message', event => {
      if (generation !== this.generation) return
      if (typeof event.data !== 'string') { this.drop('binary-frame', 0); return }
      if (event.data === KEEPALIVE_PONG) { this.clearTimer(this.pongTimer); this.pongTimer = null; return }
      let frame
      try { frame = parseHubFrame(event.data) } catch { this.drop('invalid-frame', 0); return }
      switch (frame.t) {
        case 'challenge': {
          if (this.current.state !== 'connecting') return
          if (frame.origin !== paired.hubOrigin) { this.drop('origin-mismatch', SLOW_RETRY_MS); return }
          const hello: HelloFrame = { t: 'hello', protocol: PROTOCOL_VERSION, hostId: paired.hostId, ...this.deps.hello() }
          socket.send(JSON.stringify(hello))
          socket.send(JSON.stringify({ t: 'auth', nonce: frame.nonce, signature: key.sign(hostAuthMessage(paired.hubOrigin, paired.hostId, frame.nonce, frame.issuedAt)) }))
          this.update({ state: 'authenticating' })
          return
        }
        case 'ready':
          if (this.current.state !== 'authenticating') return
          this.clearTimer(handshake)
          this.update({ state: 'connected', attempts: 0, lastError: null, connectedAt: this.clock.now() })
          this.scheduleKeepalive(generation)
          this.deps.onReady()
          return
        case 'close':
          this.onCloseFrame(frame.reason)
          return
        case 'request':
          if (this.current.state === 'connected') this.deps.onRequest(frame)
          return
        case 'owner-credentials':
          if (this.current.state === 'connected' && Array.isArray(frame.credentials)) this.deps.onOwnerCredentials(frame.credentials)
          return
      }
    })
    socket.addEventListener('close', event => {
      if (generation !== this.generation) return
      this.socket = null
      this.generation++
      this.scheduleRetry(`closed:${event.code}`, 0)
    })
    socket.addEventListener('error', () => { /* a close event follows */ })
  }

  private onCloseFrame(reason: CloseFrame['reason']): void {
    if (reason === 'protocol_mismatch' || reason === 'revoked') {
      this.stop('stopped', reason)
      this.deps.onFatal(reason)
      return
    }
    this.drop(reason, SLOW_RETRY_MS)
  }

  private scheduleKeepalive(generation: number): void {
    this.keepaliveTimer = this.setTimer(() => {
      if (generation !== this.generation || !this.socket) return
      try { this.socket.send(KEEPALIVE_PING) } catch { this.drop('keepalive-send', 0); return }
      this.clearTimer(this.pongTimer)
      this.pongTimer = this.setTimer(() => { if (generation === this.generation) this.drop('keepalive-timeout', 0) }, this.deps.pongTimeoutMs ?? 10_000)
      this.scheduleKeepalive(generation)
    }, this.deps.keepaliveMs ?? 30_000)
  }

  /** Close the current socket and schedule a reconnect. */
  private drop(error: string, minDelay: number): void {
    this.generation++
    const socket = this.socket
    this.socket = null
    if (socket) try { socket.close(4000, error.slice(0, 100)) } catch { /* already closed */ }
    this.scheduleRetry(error, minDelay)
  }

  private scheduleRetry(error: string, minDelay: number): void {
    this.clearTimers()
    if (!this.running) return
    const attempts = this.current.attempts + 1
    const delay = error === 'reconnect' ? 0 : Math.max(minDelay, backoffDelay(attempts - 1, this.deps.random))
    this.update({ state: 'backoff', lastError: error === 'reconnect' ? this.current.lastError : error, attempts: error === 'reconnect' ? 0 : attempts, retryAt: this.clock.now() + delay, connectedAt: null })
    this.retryTimer = this.setTimer(() => { if (this.running) this.connect() }, delay)
  }
}
