/**
 * The host's Ed25519 key pair. The hub knows the public key from pairing and
 * challenges the host to sign on every connection.
 *
 * The private key lives in DSH's credential store (`ctx.credentials`, record
 * `dsh-remora/host-key`). DSH's local provider keeps it in
 * `$DSH_HOME/.credentials.yaml` as plain YAML with mode 0600 — protected by
 * file permissions only, like every other DSH secret. When no credential
 * service is available the key is written to `host-key.json` (0600) in the
 * plugin's data directory instead.
 *
 * Rotating the key means pairing again: a new key is generated for every
 * pairing and only replaces the old one once the hub approved it.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fromBase64Url, toBase64Url } from '@dsh-remora/protocol'
import { writeAtomic } from './storage.ts'

/** The slice of DSH's CredentialProvider used here (`@deepseek-ai/dsh-credentials`). */
export interface CredentialsLike {
  readRecord(key: string): Promise<{ kind: string; payload?: unknown } | undefined>
  modifyRecord(key: string, mutate: (current: unknown) => Promise<{ kind: 'grant'; payload: unknown } | undefined>): Promise<unknown>
  deleteRecord(key: string): Promise<void>
}

export const HOST_KEY_RECORD = 'dsh-remora/host-key'

export class HostKey {
  readonly privateKey: KeyObject
  /** base64url raw 32-byte public key. */
  readonly publicKey: string
  readonly createdAt: number

  constructor(privateKey: KeyObject, createdAt: number) {
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('host key must be Ed25519')
    this.privateKey = privateKey
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' })
    if (typeof jwk.x !== 'string') throw new Error('could not export the public key')
    this.publicKey = jwk.x
    this.createdAt = createdAt
  }

  static generate(now = Date.now()): HostKey {
    return new HostKey(generateKeyPairSync('ed25519').privateKey, now)
  }

  /** base64url Ed25519 signature over the UTF-8 message. */
  sign(message: string): string {
    return toBase64Url(new Uint8Array(sign(null, Buffer.from(message, 'utf8'), this.privateKey)))
  }

  toPayload(): StoredKey {
    return {
      version: 1,
      privateKey: (this.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
      publicKey: this.publicKey,
      createdAt: this.createdAt,
    }
  }

  static fromPayload(payload: unknown): HostKey {
    const stored = payload as Partial<StoredKey> | null
    if (!stored || stored.version !== 1 || typeof stored.privateKey !== 'string') throw new Error('stored host key is malformed')
    const key = new HostKey(createPrivateKey({ key: Buffer.from(stored.privateKey, 'base64'), format: 'der', type: 'pkcs8' }), stored.createdAt ?? 0)
    if (stored.publicKey !== undefined && stored.publicKey !== key.publicKey) throw new Error('stored host key does not match its public key')
    return key
  }
}

interface StoredKey {
  version: 1
  privateKey: string
  publicKey: string
  createdAt: number
}

export function publicKeyBytes(publicKey: string): Uint8Array {
  return fromBase64Url(publicKey)
}

/** Where the active host key is kept. */
export class HostKeyStore {
  private readonly credentials: CredentialsLike | undefined
  private readonly filePath: string

  constructor(dataDir: string, credentials: CredentialsLike | undefined) {
    this.credentials = credentials
    this.filePath = join(dataDir, 'host-key.json')
  }

  /** `credentials` (DSH credential store) or `file` (0600 file in the data directory). */
  get location(): 'credentials' | 'file' {
    return this.credentials ? 'credentials' : 'file'
  }

  async load(): Promise<HostKey | null> {
    if (this.credentials) {
      const record = await this.credentials.readRecord(HOST_KEY_RECORD)
      if (record === undefined) return null
      if (record.kind !== 'grant') throw new Error(`${HOST_KEY_RECORD} holds an unexpected record kind`)
      return HostKey.fromPayload(record.payload)
    }
    try {
      return HostKey.fromPayload(JSON.parse(await readFile(this.filePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async save(key: HostKey): Promise<void> {
    const payload = key.toPayload()
    if (this.credentials) {
      await this.credentials.modifyRecord(HOST_KEY_RECORD, async () => ({ kind: 'grant', payload }))
      return
    }
    await writeAtomic(this.filePath, `${JSON.stringify(payload)}\n`)
  }

  async delete(): Promise<void> {
    if (this.credentials) await this.credentials.deleteRecord(HOST_KEY_RECORD)
    await rm(this.filePath, { force: true })
  }
}
