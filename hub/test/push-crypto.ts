/** The browser side of Web Push, for tests: decrypt an aes128gcm message and check a VAPID header. */
import { fromBase64Url, toBase64Url } from '../src/webpush.ts'

const enc = new TextEncoder()
const bytes = (data: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer> => new Uint8Array(data instanceof ArrayBuffer ? data.slice(0) : data)
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
const hmac = async (key: Uint8Array, data: Uint8Array) => {
  const imported = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, bytes(data)))
}

export interface Receiver {
  keys: CryptoKeyPair
  p256dh: string
  auth: string
}

/** A browser-side subscription key pair and auth secret. */
export async function newReceiver(): Promise<Receiver> {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer)
  return { keys, p256dh: toBase64Url(raw), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) }
}

/** Import a raw private scalar together with its public point (as RFC test vectors give them). */
export async function importReceiver(privateD: string, publicPoint: string, auth: string): Promise<Receiver> {
  const point = fromBase64Url(publicPoint)
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', d: privateD, x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33, 65)), ext: true }
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicKey = await crypto.subtle.importKey('raw', bytes(point), { name: 'ECDH', namedCurve: 'P-256' }, true, [])
  return { keys: { privateKey, publicKey }, p256dh: publicPoint, auth }
}

/** Decrypt one aes128gcm Web Push message (RFC 8291 §3.4) as the receiving browser. */
export async function decryptPush(body: Uint8Array, receiver: Receiver): Promise<string> {
  const salt = body.slice(0, 16)
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idLength = body[20] as number
  const asPublic = body.slice(21, 21 + idLength)
  const ciphertext = body.slice(21 + idLength)
  if (ciphertext.length > recordSize) throw new Error('record larger than rs')
  const uaPublic = fromBase64Url(receiver.p256dh)
  const asKey = await crypto.subtle.importKey('raw', bytes(asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdhParams = { name: 'ECDH', public: asKey } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0]
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, receiver.keys.privateKey, 256))
  const prkKey = await hmac(fromBase64Url(receiver.auth), ecdhSecret)
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])))
  const prk = await hmac(salt, ikm)
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16)
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12)
  const key = await crypto.subtle.importKey('raw', bytes(cek), { name: 'AES-GCM' }, false, ['decrypt'])
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(nonce) }, key, bytes(ciphertext)))
  let end = record.length - 1
  while (end >= 0 && record[end] === 0) end--
  if (record[end] !== 2) throw new Error('missing last-record delimiter')
  return new TextDecoder().decode(record.slice(0, end))
}

/** Verify a `vapid t=…, k=…` header (RFC 8292) and return its claims. */
export async function verifyVapid(header: string, expectedPublicKey: string): Promise<{ aud: string; exp: number; sub: string }> {
  const match = /^vapid t=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(header)
  if (!match) throw new Error(`malformed vapid header: ${header}`)
  const [, token, k] = match as unknown as [string, string, string]
  if (k !== expectedPublicKey) throw new Error('k does not match the hub key')
  const [head, claims, signature] = token.split('.') as [string, string, string]
  const parsedHead = JSON.parse(new TextDecoder().decode(fromBase64Url(head))) as { alg: string; typ: string }
  if (parsedHead.alg !== 'ES256') throw new Error('alg must be ES256')
  const key = await crypto.subtle.importKey('raw', bytes(fromBase64Url(k)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes(fromBase64Url(signature)), enc.encode(`${head}.${claims}`))
  if (!ok) throw new Error('bad VAPID signature')
  return JSON.parse(new TextDecoder().decode(fromBase64Url(claims))) as { aud: string; exp: number; sub: string }
}
