/**
 * The audit hash chain the hub keeps per log (the hub's own and one per
 * host). Each row's hash covers its sequence number, its fields and the
 * previous row's hash, so a changed, removed or reordered row breaks every
 * hash after it. Shared so that `remora audit verify` recomputes the chain
 * outside the hub.
 */
import type { AuditRecord } from './api.ts'
import { canonicalJson, sha256 } from './encoding.ts'

export const AUDIT_GENESIS_HASH = '0'.repeat(64)

export type AuditFields = Omit<AuditRecord, 'seq' | 'prevHash' | 'hash'>

const hex = (bytes: Uint8Array) => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')

/** The hash of one row. */
export async function auditHash(seq: number, fields: AuditFields, prevHash: string): Promise<string> {
  return hex(await sha256(`remora-audit/v1\n${prevHash}\n${canonicalJson({ seq, ...fields })}`))
}

/**
 * Recompute a chain (any order in, checked oldest first). Returns the first
 * sequence number whose link or hash does not match, or null when intact.
 * The oldest row's `prevHash` is trusted as given: older rows may have been
 * pruned, so pin an earlier row (an anchor) to check further back.
 */
export async function verifyAuditRecords(records: readonly AuditRecord[]): Promise<number | null> {
  const ordered = [...records].sort((a, b) => a.seq - b.seq)
  let prev = ordered[0]?.prevHash ?? AUDIT_GENESIS_HASH
  let expectedSeq = ordered[0]?.seq ?? 1
  for (const record of ordered) {
    const { seq, prevHash, hash, ...fields } = record
    if (seq !== expectedSeq || prevHash !== prev) return seq
    if ((await auditHash(seq, fields, prevHash)) !== hash) return seq
    prev = hash
    expectedSeq = seq + 1
  }
  return null
}
