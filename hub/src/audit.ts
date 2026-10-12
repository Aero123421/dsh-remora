/**
 * Append-only audit log kept as a hash chain in a Durable Object's SQLite.
 * Rows record who did what, where and with which outcome; never content
 * (no prompts, replies, file names or parameters).
 */
import { canonicalJson, type DenialLayer } from './vendor/protocol/index.ts'
import { sha256Hex } from './util.ts'

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

export const GENESIS_HASH = '0'.repeat(64)

/** The hash of a row covers its sequence number, its fields and the previous hash. */
export function auditHash(seq: number, entry: AuditEntry, prevHash: string): Promise<string> {
  return sha256Hex(`remora-audit/v1\n${prevHash}\n${canonicalJson({ seq, ...entry })}`)
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

/** Append one entry. Call inside the Durable Object so appends are serialized. */
export async function appendAudit(sql: SqlStorage, entry: AuditEntry): Promise<AuditRow> {
  const last = sql.exec<{ seq: number; hash: string }>('SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1').toArray()[0]
  const seq = (last?.seq ?? 0) + 1
  const prevHash = last?.hash ?? GENESIS_HASH
  const hash = await auditHash(seq, entry, prevHash)
  sql.exec(
    'INSERT INTO audit (seq, at, actor, actor_name, operation, host_id, outcome, layer, reason, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    seq, entry.at, entry.actor, entry.actorName, entry.operation, entry.hostId, entry.outcome, entry.layer, entry.reason, prevHash, hash,
  )
  return { ...entry, seq, prevHash, hash }
}

export function listAudit(sql: SqlStorage, limit: number): AuditRow[] {
  return sql.exec<Row>('SELECT * FROM audit ORDER BY seq DESC LIMIT ?', limit).toArray().map(fromRow)
}

/** Recompute the chain; returns the first broken sequence number, or null when intact. */
export async function verifyAuditChain(rows: readonly AuditRow[]): Promise<number | null> {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq)
  let prev = ordered[0]?.prevHash ?? GENESIS_HASH
  for (const row of ordered) {
    const { seq, prevHash, hash, ...entry } = row
    if (prevHash !== prev) return seq
    if ((await auditHash(seq, entry, prevHash)) !== hash) return seq
    prev = hash
  }
  return null
}
