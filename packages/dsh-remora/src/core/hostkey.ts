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
 * A new key is generated for every pairing and only replaces the old one
 * once the hub approved it. `host.rotate-key` replaces the key in place: the
 * old key stays in a second slot (`previous`) until the new one got through a
 * handshake, so a rotation interrupted at any point never locks the host out.
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
export const PREVIOUS_KEY_RECORD = 'dsh-remora/host-key-previous'

export type KeySlot = 'current' | 'previous'

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
  private readonly dataDir: string

  constructor(dataDir: string, credentials: CredentialsLike | undefined) {
    this.credentials = credentials
    this.dataDir = dataDir
  }

  private record(slot: KeySlot): string {
    return slot === 'current' ? HOST_KEY_RECORD : PREVIOUS_KEY_RECORD
  }

  private file(slot: KeySlot): string {
    return join(this.dataDir, slot === 'current' ? 'host-key.json' : 'host-key-previous.json')
  }

  /** `credentials` (DSH credential store) or `file` (0600 file in the data directory). */
  get location(): 'credentials' | 'file' {
    return this.credentials ? 'credentials' : 'file'
  }

  async load(slot: KeySlot = 'current'): Promise<HostKey | null> {
    if (this.credentials) {
      const record = await this.credentials.readRecord(this.record(slot))
      if (record === undefined) return null
      if (record.kind !== 'grant') throw new Error(`${this.record(slot)} holds an unexpected record kind`)
      return HostKey.fromPayload(record.payload)
    }
    try {
      return HostKey.fromPayload(JSON.parse(await readFile(this.file(slot), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async save(key: HostKey, slot: KeySlot = 'current'): Promise<void> {
    const payload = key.toPayload()
    if (this.credentials) {
      await this.credentials.modifyRecord(this.record(slot), async () => ({ kind: 'grant', payload }))
      return
    }
    await writeAtomic(this.file(slot), `${JSON.stringify(payload)}\n`)
  }

  /** Without `slot`, both keys. */
  async delete(slot?: KeySlot): Promise<void> {
    for (const one of slot ? [slot] : (['current', 'previous'] as const)) {
      if (this.credentials) await this.credentials.deleteRecord(this.record(one))
      await rm(this.file(one), { force: true })
    }
  }
}
