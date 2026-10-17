/**
 * Local audit log: one JSON line per event in `audit.jsonl`, hash-chained so
 * a removed or edited line breaks verification. It records who did what and
 * how it ended — never prompts, transcript text or parameters.
 *
 * When the file grows past `maxBytes` it is renamed to
 * `audit-<timestamp>.jsonl` and a new file continues the same chain (its
 * first entry's `prev` is the last hash of the rotated file).
 */
import { mkdir, open, rename, stat } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { createHash, type Hash } from 'node:crypto'
import { join } from 'node:path'
import { canonicalJson, type DenialLayer, type DenialReason } from '@dsh-remora/protocol'
import { withFileLock } from './lock.ts'

export const GENESIS_HASH = '0'.repeat(64)

export type AuditOutcome = 'ok' | 'error' | 'denied'

export interface AuditInput {
  /** `request`: an operation from the hub. `settings`: a change made on the DSH tab. `connection`: hub link events. */
  kind: 'request' | 'settings' | 'connection'
  /** Operation id, settings action or connection event. */
  action: string
  outcome: AuditOutcome
  clientId?: string
  clientName?: string
  requestId?: string
  code?: string
  layer?: DenialLayer
  reason?: DenialReason | string
  durationMs?: number
  /** For settings changes: whether the browser was on this PC. */
  local?: boolean
}

export interface AuditEntry extends AuditInput {
  seq: number
  at: number
  prev: string
  hash: string
}

function hashOf(entry: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(entry)).digest('hex')
}

/** Verify a sequence of entries; returns the index of the first bad entry, or -1. */
export function verifyChain(entries: readonly AuditEntry[], start = entries[0]?.prev ?? GENESIS_HASH): number {
  let prev = start
  for (const [index, entry] of entries.entries()) {
    const { hash, ...rest } = entry
    if (entry.prev !== prev || hashOf(rest) !== hash) return index
    prev = hash
  }
  return -1
}

function isEntry(value: unknown): value is AuditEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<AuditEntry>
  return Number.isSafeInteger(entry.seq) && Number(entry.seq) > 0 && typeof entry.at === 'number' && Number.isFinite(entry.at) &&
    typeof entry.prev === 'string' && /^[0-9a-f]{64}$/.test(entry.prev) && typeof entry.hash === 'string' && /^[0-9a-f]{64}$/.test(entry.hash) &&
    ['request', 'settings', 'connection'].includes(String(entry.kind)) && typeof entry.action === 'string' && ['ok', 'error', 'denied'].includes(String(entry.outcome))
}

/** ctime also invalidates in-place edits that restore the old size and mtime. */
function sameFile(a: BigIntStats | null, b: BigIntStats): boolean {
  return a !== null && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

export class AuditLog {
  private readonly path: string
  private readonly dir: string
  private readonly keep: number
  private readonly maxBytes: number
  private recent: AuditEntry[] = []
  private last: { seq: number; hash: string } = { seq: 0, hash: GENESIS_HASH }
  private queue: Promise<void> = Promise.resolve()
  private size = 0
  private verifiedFile: BigIntStats | null = null
  /** Expected bytes, incremented only by our successful appends. */
  private contentHash: Hash | null = null
  /** False when the stored chain failed verification at load. */
  intact = true
  private readonly now: () => number

  private constructor(dir: string, options: { keep?: number; maxBytes?: number; now?: () => number }) {
    this.dir = dir
    this.path = join(dir, 'audit.jsonl')
    this.keep = options.keep ?? 500
    this.maxBytes = options.maxBytes ?? 5 * 1024 * 1024
    this.now = options.now ?? Date.now
  }

  static async open(dir: string, options: { keep?: number; maxBytes?: number; now?: () => number } = {}): Promise<AuditLog> {
    const log = new AuditLog(dir, options)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await withFileLock(dir, 'audit.lock', () => log.refresh())
    return log
  }

  /** Called under audit.lock. Any external change revalidates the entire file. */
  private async refresh(): Promise<void> {
    let handle
    try { handle = await open(this.path, 'r') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.verifiedFile = null
      this.contentHash = createHash('sha256')
      this.size = 0
      this.recent = []
      this.last = { seq: 0, hash: GENESIS_HASH }
      return
    }
    let bytes: Buffer
    let before: BigIntStats
    let after: BigIntStats
    try {
      before = await handle.stat({ bigint: true })
      if (sameFile(this.verifiedFile, before)) return
      bytes = await handle.readFile()
      after = await handle.stat({ bigint: true })
    } finally { await handle.close() }
    // Do not cache a snapshot changed by an uncooperative writer during the read.
    this.verifiedFile = sameFile(before, after) ? after : null
    const contentHash = createHash('sha256').update(bytes)
    if (this.contentHash && contentHash.copy().digest('hex') === this.contentHash.copy().digest('hex')) return
    this.contentHash = contentHash
    this.size = bytes.byteLength
    const text = bytes.toString('utf8')
    const entries: AuditEntry[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const entry: unknown = JSON.parse(line)
        if (isEntry(entry)) entries.push(entry)
        else this.intact = false
      } catch { this.intact = false }
    }
    if (entries.length > 0) {
      if (verifyChain(entries) !== -1) this.intact = false
      const tail = entries[entries.length - 1] as AuditEntry
      this.last = { seq: tail.seq, hash: tail.hash }
    } else this.last = { seq: 0, hash: GENESIS_HASH }
    this.recent = entries.slice(-this.keep)
  }

  /** Append one entry. Resolves once it is written. Failures are reported to the caller. */
  append(input: AuditInput): Promise<AuditEntry> {
    const run = this.queue.then(() => withFileLock(this.dir, 'audit.lock', async () => {
      // Settings can be edited in several DSH processes; continue the chain
      // written by the last writer while holding the shared mutation lock.
      await this.refresh()
      const body = { ...input, seq: this.last.seq + 1, at: this.now(), prev: this.last.hash }
      const entry: AuditEntry = { ...body, hash: hashOf(body) }
      const line = `${JSON.stringify(entry)}\n`
      if (this.size + Buffer.byteLength(line) > this.maxBytes && this.size > 0) await this.rotate()
      const handle = await open(this.path, 'a', 0o600)
      // A failed append invalidates the cache, including any partial line.
      this.verifiedFile = null
      try {
        await handle.writeFile(line)
      } finally { await handle.close() }
      // Never trust a post-write stat: an external edit during the append could
      // otherwise be mistaken for our write. Recheck the expected byte digest
      // next time; only changed bytes need JSON parsing and chain validation.
      this.contentHash?.update(line)
      this.size += Buffer.byteLength(line)
      this.last = { seq: entry.seq, hash: entry.hash }
      this.recent.push(entry)
      if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep)
      return entry
    }))
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Most recent entries, newest last. */
  entries(): readonly AuditEntry[] {
    return this.recent
  }

  /** Await writes before the plugin's shared storage is torn down. */
  flush(): Promise<void> { return this.queue }

  private async rotate(): Promise<void> {
    const target = join(this.dir, `audit-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.jsonl`)
    try {
      await stat(target)
      return
    } catch { /* target is free: the expected case */ }
    await rename(this.path, target)
    this.size = 0
    this.verifiedFile = null
    this.contentHash = createHash('sha256')
  }
}
