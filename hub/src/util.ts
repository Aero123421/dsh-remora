/**
 * Small helpers shared by the Worker and both Durable Objects. Pure apart
 * from WebCrypto, so they run the same under Node (unit tests) and workerd.
 */
import { fromBase64Url, toBase64Url } from './vendor/protocol/index.ts'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

/** Lowercase RFC 4648 base32 without padding: safe in URLs, ids and file names. */
export function base32(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31]
  return out
}

export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes))
}

/** Host ids look like `h` + 20 base32 characters; they never contain `-`, which separates task ids. */
export function newHostId(): string {
  return `h${base32(randomBytes(13)).slice(0, 20)}`
}

/** Task ids carry their host: `<hostId>-<random>`, so ledger operations need no lookup table. */
export function newTaskId(hostId: string): string {
  return `${hostId}-${base32(randomBytes(10))}`
}

export function hostIdOfTask(taskId: string): string | null {
  const index = taskId.indexOf('-')
  if (index <= 0) return null
  const hostId = taskId.slice(0, index)
  return /^h[a-z2-7]{20}$/.test(hostId) ? hostId : null
}

/** A code drawn uniformly from `alphabet` (rejection sampling, no modulo bias). */
export function randomCode(alphabet: string, length: number): string {
  let out = ''
  const limit = 256 - (256 % alphabet.length)
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length]
    }
  }
  return out
}

export async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison of two strings of the same length. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Verify an Ed25519 signature (raw 32-byte public key, both base64url) over a UTF-8 message. */
export async function verifyEd25519(publicKey: string, message: string, signature: string): Promise<boolean> {
  try {
    const keyBytes = fromBase64Url(publicKey)
    const sigBytes = fromBase64Url(signature)
    if (keyBytes.length !== 32 || sigBytes.length !== 64) return false
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, new TextEncoder().encode(message))
  } catch {
    return false
  }
}

export function isRawEd25519Key(publicKey: unknown): publicKey is string {
  if (typeof publicKey !== 'string') return false
  try {
    return fromBase64Url(publicKey).length === 32
  } catch {
    return false
  }
}

/** UTC day key used by the free-tier meter. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

export function clampText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
