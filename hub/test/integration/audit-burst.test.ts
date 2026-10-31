import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { appendAudit, listAudit, verifyAuditChain } from '../../src/audit.ts'

describe('audit bursts', () => {
  it('serializes overlapping appends on real Durable Object SQLite', async () => {
    const hub = env.HUB.get(env.HUB.idFromName('audit-burst'))
    await runInDurableObject(hub, async (_instance, state) => {
      const sql = state.storage.sql
      const entry = { at: Date.now(), actor: 'owner', actorName: 'owner', operation: 'test', hostId: null, outcome: 'ok' as const, layer: null, reason: null }
      await Promise.all(Array.from({ length: 32 }, () => appendAudit(sql, entry)))
      const rows = listAudit(sql, 32).reverse()
      expect(rows.map(row => row.seq)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1))
      expect(await verifyAuditChain(rows)).toBeNull()
    })
  })

  it('records concurrent Durable Object RPCs without losing audit entries', async () => {
    const hub = env.HUB.get(env.HUB.idFromName('audit-burst-rpc'))
    const results = await Promise.all(Array.from({ length: 32 }, () => hub.regenerateRecoveryCodes()))
    expect(results).toHaveLength(32)
    await runInDurableObject(hub, async (_instance, state) => {
      const rows = listAudit(state.storage.sql, 32).reverse()
      expect(rows.map(row => row.seq)).toEqual(Array.from({ length: 32 }, (_, i) => i + 1))
      expect(await verifyAuditChain(rows)).toBeNull()
    })
  })
})
