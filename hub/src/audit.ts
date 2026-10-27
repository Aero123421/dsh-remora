/**
 * Append-only audit log kept as a hash chain in a Durable Object's SQLite.
 * Rows record who did what, where and with which outcome; never content
 * (no prompts, replies, file names or parameters).
 */
import { AUDIT_GENESIS_HASH, AUDIT_KEPT_ROWS, auditHash as chainHash, verifyAuditRecords, type DenialLayer } from './vendor/protocol/index.ts'

export type AuditOutcome = 'ok' | 'denied' | 'error'

export interface AuditEntry {
  at: number
  /** Client id, `owner`, `host` or `hub`. */
  actor: string
  actorName: string
  operation: string
  hostId: string | null
  outcome: AuditOutcome
  /** For denials: the layer that refused. */
  layer: DenialLayer | null
  /** Denial reason or error code. */
  reason: string | null
}

export interface AuditRow extends AuditEntry {
  seq: number
  prevHash: string
  hash: string
}

export const AUDIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS audit (
    seq INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    operation TEXT NOT NULL,
    host_id TEXT,
    outcome TEXT NOT NULL,
    layer TEXT,
    reason TEXT,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
`

export const GENESIS_HASH = AUDIT_GENESIS_HASH

/** The hash of a row covers its sequence number, its fields and the previous hash (packages/protocol/src/audit.ts). */
export function auditHash(seq: number, entry: AuditEntry, prevHash: string): Promise<string> {
  return chainHash(seq, entry, prevHash)
}

type Row = { seq: number; at: number; actor: string; actor_name: string; operation: string; host_id: string | null; outcome: string; layer: string | null; reason: string | null; prev_hash: string; hash: string }

function fromRow(row: Row): AuditRow {
  return {
    seq: row.seq,
    at: row.at,
    actor: row.actor,
    actorName: row.actor_name,
    operation: row.operation,
    hostId: row.host_id,
    outcome: row.outcome as AuditOutcome,
    layer: row.layer as DenialLayer | null,
    reason: row.reason,
    prevHash: row.prev_hash,
    hash: row.hash,
  }
}

/**
 * The SQL this log uses. Durable Object `SqlStorage` satisfies it.
 * The cursor is untyped here so a unit test can pass a fake without the Workers types.
 */
export interface AuditSql {
  exec(query: string, ...bindings: any[]): { toArray(): any[] }
}

const APPEND_ATTEMPTS = 8

function isSeqConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
}

/**
 * Append one entry. Hashing awaits, so two requests on the same Durable Object
 * can read the same sequence. A conflicting insert retries with the next sequence
 * and a new hash. The caller still has to treat a thrown append as "the operation
 * may already have happened".
 */
export async function appendAudit(sql: AuditSql, entry: AuditEntry, maxRows = AUDIT_KEPT_ROWS): Promise<AuditRow> {
  for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
    const last = sql.exec('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').toArray()[0] as { seq: number; hash: string } | undefined
    const seq = (last?.seq ?? 0) + 1
    const prevHash = last?.hash ?? GENESIS_HASH
    const hash = await auditHash(seq, entry, prevHash)
    try {
      sql.exec(
        'INSERT INTO audit (seq, at, actor, actor_name, operation, host_id, outcome, layer, reason, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        seq, entry.at, entry.actor, entry.actorName, entry.operation, entry.hostId, entry.outcome, entry.layer, entry.reason, prevHash, hash,
      )
      // Keep the newest rows only. The chain stays verifiable from the first kept row's prev_hash.
      if (seq > maxRows && seq % 50 === 0) sql.exec('DELETE FROM audit WHERE seq <= ?', seq - maxRows)
      return { ...entry, seq, prevHash, hash }
    } catch (error) {
      if (!isSeqConflict(error) || attempt === APPEND_ATTEMPTS - 1) throw error
    }
  }
  throw new Error('audit append failed')
}

export function listAudit(sql: AuditSql, limit: number): AuditRow[] {
  return sql.exec('SELECT * FROM audit ORDER BY seq DESC LIMIT ?', limit).toArray().map(row => fromRow(row as Row))
}

/** Recompute the chain; returns the first broken sequence number, or null when intact. */
export function verifyAuditChain(rows: readonly AuditRow[]): Promise<number | null> {
  return verifyAuditRecords(rows)
}
