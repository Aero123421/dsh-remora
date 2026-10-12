/**
 * Local audit log: one JSON line per event in `audit.jsonl`, hash-chained so
 * a removed or edited line breaks verification. It records who did what and
 * how it ended — never prompts, transcript text or parameters.
 *
 * When the file grows past `maxBytes` it is renamed to
 * `audit-<timestamp>.jsonl` and a new file continues the same chain (its
 * first entry's `prev` is the last hash of the rotated file).
 */
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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

export class AuditLog {
  private readonly path: string
  private readonly dir: string
  private readonly keep: number
  private readonly maxBytes: number
  private recent: AuditEntry[] = []
  private last: { seq: number; hash: string } = { seq: 0, hash: GENESIS_HASH }
  private queue: Promise<void> = Promise.resolve()
  private size = 0
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
    let text = ''
    try { text = await readFile(log.path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    log.size = Buffer.byteLength(text)
    const entries: AuditEntry[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try { entries.push(JSON.parse(line) as AuditEntry) } catch { log.intact = false }
    }
    if (entries.length > 0) {
      if (verifyChain(entries) !== -1) log.intact = false
      const tail = entries[entries.length - 1] as AuditEntry
      log.last = { seq: tail.seq, hash: tail.hash }
    }
    log.recent = entries.slice(-log.keep)
    return log
  }

  /** Append one entry. Resolves once it is written. Failures are reported to the caller. */
  append(input: AuditInput): Promise<AuditEntry> {
    const run = this.queue.then(() => withFileLock(this.dir, 'audit.lock', async () => {
      // Settings can be edited in several DSH processes; continue the chain
      // written by the last writer while holding the shared mutation lock.
      const stored = await AuditLog.open(this.dir, { keep: this.keep, maxBytes: this.maxBytes, now: this.now })
      this.recent = stored.recent
      this.last = stored.last
      this.size = stored.size
      this.intact = this.intact && stored.intact
      const body = { ...input, seq: this.last.seq + 1, at: this.now(), prev: this.last.hash }
      const entry: AuditEntry = { ...body, hash: hashOf(body) }
      const line = `${JSON.stringify(entry)}\n`
      if (this.size + line.length > this.maxBytes && this.size > 0) await this.rotate()
      await appendFile(this.path, line, { mode: 0o600 })
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
  }
}
