/**
 * Web Push with WebCrypto only (no nodejs_compat, no library):
 * - message encryption per RFC 8291 with the `aes128gcm` content coding (RFC 8188);
 * - VAPID authentication per RFC 8292 (ES256 JWT + `vapid t=…, k=…`).
 * Pure apart from WebCrypto, so it runs under Node for the unit tests.
 */

/** base64url without padding (local copy so this module stays free of the protocol import graph). */
export function toBase64Url(data: Uint8Array): string {
  let binary = ''
  for (const byte of data) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((text.length + 3) % 4))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url: the browser's applicationServerKey. */
  publicKey: string
  /** The private key as a JWK (stored in HubDO only). */
  privateJwk: JsonWebKey
}

export interface PushSubscriptionKeys {
  endpoint: string
  /** The browser's P-256 public key (65 bytes), base64url. */
  p256dh: string
  /** The browser's 16-byte authentication secret, base64url. */
  auth: string
}

export interface PushMessageOptions {
  /** Seconds the push service keeps an undelivered message. */
  ttl: number
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  /** Replaces an undelivered message with the same topic (≤ 32 base64url characters). */
  topic?: string
}

/** Record size written into the header; one record carries the whole (small) message. */
const RECORD_SIZE = 4096

const enc = new TextEncoder()

/** A copy backed by a plain ArrayBuffer, as WebCrypto's types require. */
const bytes = (data: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> => new Uint8Array(data instanceof ArrayBuffer ? data.slice(0) : data)

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, bytes(data)))
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  return { publicKey: toBase64Url(raw), privateJwk }
}

/** The `Authorization` header value for one push service (RFC 8292 §3). */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const header = toBase64Url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  // `exp` must be at most 24 hours ahead; 12 hours leaves room for clock skew.
  const claims = toBase64Url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  // WebCrypto returns the raw r||s form that JWS ES256 uses.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)))
  return `vapid t=${header}.${claims}.${toBase64Url(signature)}, k=${keys.publicKey}`
}

export interface EncryptOptions {
  /** Fixed salt and sender key pair, for test vectors only. */
  salt?: Uint8Array
  senderKeys?: CryptoKeyPair
}

/** Encrypt one push message for a subscription (RFC 8291 §3, single `aes128gcm` record). */
export async function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string, options: EncryptOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = bytes(fromBase64Url(p256dh))
  const authSecret = bytes(fromBase64Url(auth))
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 point')
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes')
  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error('payload too large')

  const sender = options.senderKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair)
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', sender.publicKey)) as ArrayBuffer)
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  // The runtime reads `public`; workers-types spells the field `$public`, so cast.
  const ecdhParams = { name: 'ECDH', public: uaKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0]
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, sender.privateKey, 256))

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const prkKey = await hmac(authSecret, ecdhSecret)
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])))
  const salt = options.salt ? bytes(options.salt) : crypto.getRandomValues(new Uint8Array(16))
  const prk = await hmac(salt, ikm)
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16)
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12)

  // One record: the plaintext followed by the 0x02 "last record" delimiter.
  const record = concat(plaintext, new Uint8Array([2]))
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record))

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = asPublic.length
  header.set(asPublic, 21)
  return concat(header, ciphertext)
}

/** The full HTTP request to a push service. */
export async function buildPushRequest(subscription: PushSubscriptionKeys, payload: unknown, keys: VapidKeys, subject: string, options: PushMessageOptions): Promise<Request> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), subscription.p256dh, subscription.auth)
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    ttl: String(Math.max(0, Math.floor(options.ttl))),
    urgency: options.urgency ?? 'normal',
    authorization: await vapidAuthorization(subscription.endpoint, keys, subject),
  }
  if (options.topic) headers.topic = options.topic
  return new Request(subscription.endpoint, { method: 'POST', headers, body })
}

/** Push services this hub sends to; anything else is refused at subscription time. */
const PUSH_SERVICE_SUFFIXES = ['.googleapis.com', '.mozilla.com', '.push.apple.com', '.notify.windows.com']

export function isPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
    const host = `.${url.hostname.toLowerCase()}`
    return PUSH_SERVICE_SUFFIXES.some(suffix => host.endsWith(suffix))
  } catch {
    return false
  }
}

export function isSubscriptionKey(value: unknown, length: number): value is string {
  if (typeof value !== 'string' || value.length > 200) return false
  try {
    const decoded = fromBase64Url(value.replace(/=+$/, ''))
    return decoded.length === length && (length !== 65 || decoded[0] === 4)
  } catch {
    return false
  }
}
