import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendAudit, verifyAuditChain, type AuditSql } from '../../src/audit.ts'

const entry = (at: number) => ({ at, actor: 'a', actorName: 'a', operation: 'op', hostId: null, outcome: 'ok' as const, layer: null, reason: null })

function memorySql(): AuditSql & { rows: { seq: number; hash: string; prev_hash: string }[] } {
  const rows: { seq: number; hash: string; prev_hash: string; at: number }[] = []
  return {
    rows,
    exec(query: string, ...args: unknown[]) {
      if (query.startsWith('SELECT')) {
        const last = rows.at(-1)
        return { toArray: () => (last ? [{ seq: last.seq, hash: last.hash }] : []) }
      }
      if (query.startsWith('INSERT')) {
        const seq = args[0] as number
        if (rows.some(row => row.seq === seq)) throw new Error('UNIQUE constraint failed: audit.seq')
        rows.push({ seq, hash: args[10] as string, prev_hash: args[9] as string, at: args[1] as number })
        return { toArray: () => [] }
      }
      return { toArray: () => [] }
    },
  }
}

test('two overlapping appends take successive sequence numbers', async () => {
  const sql = memorySql()
  const [first, second] = await Promise.all([appendAudit(sql, entry(1)), appendAudit(sql, entry(2))])
  const ordered = [first, second].sort((a, b) => a.seq - b.seq)
  assert.deepEqual(ordered.map(row => row.seq), [1, 2])
  assert.equal(ordered[1]?.prevHash, ordered[0]?.hash)
  assert.equal(await verifyAuditChain(ordered), null)
  assert.equal(sql.rows.length, 2)
})
