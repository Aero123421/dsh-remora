/**
 * Just enough CBOR to read a COSE_Key (RFC 9052/9053) and turn it into a
 * `node:crypto` public key: EC2 P-256 (ES256, -7), OKP Ed25519 (EdDSA, -8)
 * and RSA (RS256, -257).
 */
import { createPublicKey, type KeyObject } from 'node:crypto'
import { toBase64Url } from '@dsh-remora/protocol'

export type CborValue = number | bigint | boolean | null | string | Uint8Array | CborValue[] | Map<CborValue, CborValue>

/** Decode one CBOR item. Throws on trailing bytes, indefinite lengths and unsupported types. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  let offset = 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const need = (n: number) => { if (offset + n > bytes.length) throw new Error('cbor: truncated') }
  const readLength = (info: number): number => {
    if (info < 24) return info
    if (info === 24) { need(1); return bytes[offset++] as number }
    if (info === 25) { need(2); const v = view.getUint16(offset); offset += 2; return v }
    if (info === 26) { need(4); const v = view.getUint32(offset); offset += 4; return v }
    if (info === 27) {
      need(8)
      const v = view.getBigUint64(offset); offset += 8
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: length too large')
      return Number(v)
    }
    throw new Error('cbor: indefinite or reserved length')
  }
  const item = (depth: number): CborValue => {
    if (depth > 16) throw new Error('cbor: nested too deeply')
    need(1)
    const initial = bytes[offset++] as number
    const major = initial >> 5
    const info = initial & 0x1f
    switch (major) {
      case 0: return readLength(info)
      case 1: return -1 - readLength(info)
      case 2: { const n = readLength(info); need(n); const out = bytes.slice(offset, offset + n); offset += n; return out }
      case 3: { const n = readLength(info); need(n); const out = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + n)); offset += n; return out }
      case 4: { const n = readLength(info); const out: CborValue[] = []; for (let i = 0; i < n; i++) out.push(item(depth + 1)); return out }
      case 5: {
        const n = readLength(info)
        const out = new Map<CborValue, CborValue>()
        for (let i = 0; i < n; i++) { const key = item(depth + 1); out.set(key, item(depth + 1)) }
        return out
      }
      case 7:
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22) return null
        throw new Error('cbor: unsupported simple value')
      default:
        throw new Error('cbor: unsupported major type')
    }
  }
  const value = item(0)
  if (offset !== bytes.length) throw new Error('cbor: trailing bytes')
  return value
}

export const COSE_ES256 = -7
export const COSE_EDDSA = -8
export const COSE_RS256 = -257
export const SUPPORTED_COSE_ALGORITHMS: readonly number[] = [COSE_ES256, COSE_EDDSA, COSE_RS256]

function bytesAt(map: Map<CborValue, CborValue>, key: number): Uint8Array {
  const value = map.get(key)
  if (!(value instanceof Uint8Array)) throw new Error(`cose: parameter ${key} missing`)
  return value
}

/** Parse a COSE_Key and check it matches `algorithm`. */
export function coseToKeyObject(cose: Uint8Array, algorithm: number): KeyObject {
  const decoded = decodeCbor(cose)
  if (!(decoded instanceof Map)) throw new Error('cose: key is not a map')
  const kty = decoded.get(1)
  const alg = decoded.get(3)
  if (alg !== undefined && alg !== algorithm) throw new Error('cose: algorithm mismatch')
  if (algorithm === COSE_ES256) {
    const x = bytesAt(decoded, -2)
    const y = bytesAt(decoded, -3)
    if (kty !== 2 || decoded.get(-1) !== 1 || x.length !== 32 || y.length !== 32) throw new Error('cose: not an EC2 P-256 key')
    return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: toBase64Url(x), y: toBase64Url(y) }, format: 'jwk' })
  }
  if (algorithm === COSE_EDDSA) {
    const x = bytesAt(decoded, -2)
    if (kty !== 1 || decoded.get(-1) !== 6 || x.length !== 32) throw new Error('cose: not an OKP Ed25519 key')
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(x) }, format: 'jwk' })
  }
  if (algorithm === COSE_RS256) {
    const n = bytesAt(decoded, -1)
    const e = bytesAt(decoded, -2)
    if (kty !== 3 || n.length < 256) throw new Error('cose: not an RSA key of at least 2048 bits')
    return createPublicKey({ key: { kty: 'RSA', n: toBase64Url(n), e: toBase64Url(e) }, format: 'jwk' })
  }
  throw new Error(`cose: unsupported algorithm ${algorithm}`)
}
