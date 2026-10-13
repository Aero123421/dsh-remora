/**
 * Pairing client (`@dsh-remora/protocol/pairing.ts`): generate a fresh key,
 * `POST /pair/start`, show the code and QR on the settings tab, and poll
 * `POST /pair/poll` with signed requests until the owner approves, denies or
 * the code expires.
 */
import {
  ENDPOINTS, PAIRING_POLL_INTERVAL_MS, fromBase64Url, PROTOCOL_VERSION, USER_CODE_ALPHABET, formatUserCode, pairPollMessage,
  type OwnerCredential, type PairPollResponse, type PairStartResponse,
} from '@dsh-remora/protocol'
import { coseToKeyObject, SUPPORTED_COSE_ALGORITHMS } from './cose.ts'
import { HostKey } from './hostkey.ts'

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Validate a hub URL typed on the settings tab and return its origin. https only, except loopback for development. */
export function normalizeHubUrl(input: string): string {
  let url: URL
  try { url = new URL(input.trim()) } catch { throw new PairingError('invalid-hub-url', 'not a URL') }
  if (url.username !== '' || url.password !== '') throw new PairingError('invalid-hub-url', 'credentials are not allowed in the URL')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    throw new PairingError('invalid-hub-url', 'the hub URL must start with https://')
  }
  return url.origin
}

export class PairingError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PairingError'
    this.code = code
  }
}

export type PairingPhase = 'idle' | 'starting' | 'waiting' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'error'

export interface PairingView {
  phase: PairingPhase
  hubOrigin?: string
  /** XXXX-XXXX */
  userCode?: string
  verifyUrl?: string
  expiresAt?: number
  error?: string
}

export interface ApprovedPairing {
  hostId: string
  hubOrigin: string
  rpId: string
  owner: OwnerCredential[]
}

export interface PairingDeps {
  fetch?: FetchLike
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Persist the approved pairing and its key. Throwing turns the attempt into an error. */
  onApproved: (pairing: ApprovedPairing, key: HostKey, signal: AbortSignal) => Promise<void>
  onChange?: (view: PairingView) => void
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return }
  const onAbort = (): void => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
  signal.addEventListener('abort', onAbort, { once: true })
})

/** rpId must be the hub's host or a registrable parent of it. */
export function rpIdMatches(origin: string, rpId: string): boolean {
  const host = new URL(origin).hostname
  return rpId !== '' && (host === rpId || host.endsWith(`.${rpId}`))
}

export function checkOwnerCredentials(owner: unknown): OwnerCredential[] {
  if (!Array.isArray(owner) || owner.length === 0) throw new PairingError('invalid-response', 'the hub sent no owner passkeys')
  return owner.map(item => {
    const entry = item as Partial<OwnerCredential>
    if (typeof entry.credentialId !== 'string' || typeof entry.publicKey !== 'string' || typeof entry.algorithm !== 'number' || !SUPPORTED_COSE_ALGORITHMS.includes(entry.algorithm)) {
      throw new PairingError('invalid-response', 'unsupported owner passkey')
    }
    coseToKeyObject(fromBase64Url(entry.publicKey), entry.algorithm)
    return { credentialId: entry.credentialId, publicKey: entry.publicKey, algorithm: entry.algorithm }
  })
}

export class PairingClient {
  private readonly deps: PairingDeps
  private current: PairingView = { phase: 'idle' }
  private abort: AbortController | null = null

  constructor(deps: PairingDeps) {
    this.deps = deps
  }

  get view(): PairingView {
    return this.current
  }

  private set(view: PairingView): void {
    this.current = view
    this.deps.onChange?.(view)
  }

  private async post<T>(origin: string, path: string, body: unknown, signal: AbortSignal): Promise<T> {
    const fetchImpl: FetchLike = this.deps.fetch ?? ((input, init) => fetch(input, init))
    const response = await fetchImpl(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) throw new PairingError(response.status >= 500 ? 'hub-unavailable' : 'hub-refused', `the hub answered ${response.status}`)
    return await response.json() as T
  }

  /** Start pairing with the hub. Resolves once the code is shown (or the start failed). Polling continues in the background. */
  async start(hubUrl: string, name: string, pluginVersion: string): Promise<PairingView> {
    this.cancel('cancelled')
    const origin = normalizeHubUrl(hubUrl)
    const abort = new AbortController()
    this.abort = abort
    const key = HostKey.generate()
    this.set({ phase: 'starting', hubOrigin: origin })
    let started: PairStartResponse
    try {
      started = await this.post<PairStartResponse>(origin, ENDPOINTS.pairStart, { publicKey: key.publicKey, name, pluginVersion, protocol: PROTOCOL_VERSION }, abort.signal)
      if (typeof started.pairingId !== 'string' || started.pairingId === '') throw new PairingError('invalid-response', 'missing pairingId')
      if (typeof started.userCode !== 'string' || started.userCode.length !== 8 || [...started.userCode].some(ch => !USER_CODE_ALPHABET.includes(ch))) throw new PairingError('invalid-response', 'invalid user code')
      if (typeof started.verifyUrl !== 'string' || new URL(started.verifyUrl).origin !== origin) throw new PairingError('invalid-response', 'the approval page is not on the hub')
      if (typeof started.expiresAt !== 'number') throw new PairingError('invalid-response', 'missing expiresAt')
    } catch (error) {
      if (abort.signal.aborted) return this.current
      this.set({ phase: 'error', hubOrigin: origin, error: errorCode(error) })
      return this.current
    }
    if (abort.signal.aborted || this.abort !== abort) return this.current
    this.set({ phase: 'waiting', hubOrigin: origin, userCode: formatUserCode(started.userCode), verifyUrl: started.verifyUrl, expiresAt: started.expiresAt })
    const interval = Math.min(30_000, Math.max(1_000, typeof started.pollIntervalMs === 'number' ? started.pollIntervalMs : PAIRING_POLL_INTERVAL_MS))
    void this.poll(origin, started, key, interval, abort)
    return this.current
  }

  private async poll(origin: string, started: PairStartResponse, key: HostKey, interval: number, abort: AbortController): Promise<void> {
    const now = this.deps.now ?? Date.now
    const sleep = this.deps.sleep ?? defaultSleep
    let failures = 0
    const waiting = this.current
    try {
      for (;;) {
        await sleep(interval * Math.min(8, 2 ** failures), abort.signal)
        if (abort.signal.aborted) return
        if (now() > started.expiresAt) { this.set({ phase: 'expired', hubOrigin: origin }); return }
        let result: PairPollResponse
        try {
          result = await this.post<PairPollResponse>(origin, ENDPOINTS.pairPoll, { pairingId: started.pairingId, signature: key.sign(pairPollMessage(origin, started.pairingId)) }, abort.signal)
          failures = 0
        } catch (error) {
          if (abort.signal.aborted) return
          if (error instanceof PairingError && error.code === 'hub-refused') throw error
          failures++
          continue
        }
        if (abort.signal.aborted) return
        if (result.status === 'pending') continue
        if (result.status === 'denied' || result.status === 'expired') { this.set({ phase: result.status, hubOrigin: origin }); return }
        if (result.status !== 'approved') throw new PairingError('invalid-response', 'unknown pairing status')
        if (result.hubOrigin !== origin) throw new PairingError('invalid-response', 'the hub reported a different origin')
        if (typeof result.hostId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(result.hostId)) throw new PairingError('invalid-response', 'invalid hostId')
        if (typeof result.rpId !== 'string' || !rpIdMatches(origin, result.rpId)) throw new PairingError('invalid-response', 'the passkey RP id does not match the hub')
        const owner = checkOwnerCredentials(result.owner)
        if (abort.signal.aborted) return
        await this.deps.onApproved({ hostId: result.hostId, hubOrigin: origin, rpId: result.rpId, owner }, key, abort.signal)
        if (abort.signal.aborted || this.abort !== abort) return
        this.set({ phase: 'approved', hubOrigin: origin })
        return
      }
    } catch (error) {
      if (abort.signal.aborted) return
      this.set({ ...waiting, phase: 'error', error: errorCode(error) })
    } finally {
      if (this.abort === abort) this.abort = null
    }
  }

  cancel(phase: 'cancelled' | 'idle' = 'cancelled'): void {
    if (this.abort) {
      this.abort.abort(new Error('pairing cancelled'))
      this.abort = null
      this.set({ phase })
    }
  }

  reset(): void {
    this.cancel('idle')
    this.set({ phase: 'idle' })
  }
}

function errorCode(error: unknown): string {
  if (error instanceof PairingError) return error.code
  return 'network'
}
