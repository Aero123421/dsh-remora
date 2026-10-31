import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { sha256Hex } from '../../src/util.ts'

describe('recovery code regeneration', () => {
  it('rolls back a failed replacement and coalesces overlapping retries', async () => {
    const hub = env.HUB.get(env.HUB.idFromName('recovery-atomic'))
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO recovery_codes (hash, created_at) VALUES ('old', 1)")
      state.storage.sql.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON recovery_codes BEGIN SELECT RAISE(ABORT, 'test failure'); END")
    })
    await runInDurableObject(hub, async (instance, state) => {
      await expect(instance.regenerateRecoveryCodes()).rejects.toThrow()
      expect(state.storage.sql.exec('SELECT hash FROM recovery_codes').toArray()).toEqual([{ hash: 'old' }])
      state.storage.sql.exec('DROP TRIGGER fail_recovery')
      const [a, b] = await Promise.all([instance.regenerateRecoveryCodes(), instance.regenerateRecoveryCodes()])
      expect(a).toEqual(b)
      expect(a).toHaveLength(10)
      const hashes = await Promise.all(a.map(code => sha256Hex(`remora-recovery/v1\n${code.replaceAll('-', '')}`)))
      const stored = state.storage.sql.exec('SELECT hash FROM recovery_codes').toArray().map(row => row.hash)
      expect(stored.sort()).toEqual(hashes.sort())
    })
  })
})
