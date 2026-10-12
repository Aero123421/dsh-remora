import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AUDIT_GENESIS_HASH, auditHash, type AuditExportResult, type AuditRecord, type ConfirmationInfo } from '@dsh-remora/protocol'
import { main } from '../src/main.ts'
import { EXIT } from '../src/errors.ts'
import { FakeHub, seedLogin, testCtx, type TestCtx } from './helpers.ts'

let hub: FakeHub
before(async () => { hub = await new FakeHub(18121).start() })
after(async () => { await hub.stop() })

const ADMIN = 'dsh.read dsh.tasks dsh.admin offline_access'

async function loggedIn(extra: Parameters<typeof testCtx>[0] = {}, scope = ADMIN): Promise<TestCtx> {
  const t = await testCtx(extra)
  await seedLogin(t, hub, { scope })
  hub.calls = []
  return t
}

async function chain(count: number, start = 1): Promise<AuditRecord[]> {
  const records: AuditRecord[] = []
  let prev = start === 1 ? AUDIT_GENESIS_HASH : 'f'.repeat(64)
  for (let seq = start; seq < start + count; seq++) {
    const fields = { at: seq * 1000, actor: 'owner', actorName: 'オーナー', operation: `op.${seq}`, hostId: null, outcome: 'ok' as const, layer: null, reason: null }
    const hash = await auditHash(seq, fields, prev)
    records.push({ seq, ...fields, prevHash: prev, hash })
    prev = hash
  }
  return records
}

function confirmation(operation: string, state: ConfirmationInfo['state'], result?: unknown): ConfirmationInfo {
  return { confirmationId: 'hub-abcdefgh', hostId: '', operation, state, confirmUrl: `${hub.url}/confirm/hub/hub-abcdefgh`, createdAt: 1, expiresAt: 2, ...(result === undefined ? {} : { result }) }
}

test('audit verify: approved on the hub, recomputed here, pinned for next time; tampering and truncation fail', async () => {
  let exported: AuditExportResult = { exportedAt: Date.now(), hubOrigin: hub.url, logs: [{ log: 'hub', name: 'hub', records: await chain(5) }, { log: 'h-1', name: '自宅 PC', records: await chain(3) }] }
  hub.ops['audit.export'] = () => confirmation('audit.export', 'pending')
  hub.ops['confirmation.get'] = (_params, call) => (call === 1 ? confirmation('audit.export', 'pending') : confirmation('audit.export', 'done', exported))
  const t = await loggedIn()
  assert.equal(await main(['audit', 'verify', '--out', 'saved.json'], t.ctx), EXIT.ok, t.stderr())
  assert.match(t.stderr(), /confirm\/hub\/hub-abcdefgh/)
  assert.match(t.stdout(), /ハブ\s+ハブ\s+5\s+#1〜#5\s+正常\s+前回の確認なし/)
  assert.match(t.stdout(), /h-1\s+自宅 PC\s+3\s+#1〜#3\s+正常/)
  const anchors = JSON.parse(await readFile(join(t.dir, 'audit-anchors.json'), 'utf8'))
  assert.equal(anchors[hub.url].hub.seq, 5)
  assert.ok(JSON.parse(await readFile(join(t.dir, 'saved.json'), 'utf8')).logs)

  // Grown since: the pinned row is still there.
  exported = { ...exported, logs: [{ log: 'hub', name: 'hub', records: await chain(8) }, exported.logs[1]!] }
  const again = await testCtx({ envExtra: {} })
  Object.assign(again.ctx.env, t.ctx.env)
  await seedLogin(again, hub, { scope: ADMIN })
  hub.calls = []
  assert.equal(await main(['audit', 'verify', '--json'], again.ctx), EXIT.ok, again.stderr())
  const report = JSON.parse(again.stdout())
  assert.equal(report.ok, true)
  assert.equal(report.logs[0].anchor, 'ok')

  // Rewritten history: same length, other hashes from row 2 on.
  const rewritten = await chain(8)
  rewritten[1] = { ...rewritten[1]!, actorName: 'someone else' }
  exported = { ...exported, logs: [{ log: 'hub', name: 'hub', records: rewritten }] }
  const tampered = await testCtx()
  Object.assign(tampered.ctx.env, t.ctx.env)
  await seedLogin(tampered, hub, { scope: ADMIN })
  assert.equal(await main(['audit', 'verify'], tampered.ctx), EXIT.failure)
  assert.match(tampered.stdout(), /#2 で途切れ/)
  assert.match(tampered.stderr(), /改ざんか欠落の疑い/)

  // A consistent but shorter chain than last time.
  exported = { ...exported, logs: [{ log: 'hub', name: 'hub', records: await chain(4) }] }
  const shorter = await testCtx()
  Object.assign(shorter.ctx.env, t.ctx.env)
  await seedLogin(shorter, hub, { scope: ADMIN })
  assert.equal(await main(['audit', 'verify'], shorter.ctx), EXIT.failure)
  assert.match(shorter.stdout(), /前回より短くなっている/)
})

test('audit verify --file checks a saved export without the hub; refused and missing-scope requests say why', async () => {
  const t = await testCtx()
  const file = join(t.dir, 'export.json')
  await writeFile(file, JSON.stringify({ exportedAt: 1, hubOrigin: 'https://hub.example', logs: [{ log: 'hub', name: 'hub', records: await chain(3, 10) }] }))
  assert.equal(await main(['audit', 'verify', '--file', 'export.json', '--no-anchor'], t.ctx), EXIT.ok, t.stderr())
  assert.match(t.stdout(), /#10〜#12\s+正常/)
  const broken = await testCtx()
  const records = await chain(3)
  await writeFile(join(broken.dir, 'export.json'), JSON.stringify({ exportedAt: 1, hubOrigin: '', logs: [{ log: 'hub', name: 'hub', records: [records[0], records[2]] }] }))
  assert.equal(await main(['audit', 'verify', '--file', 'export.json'], broken.ctx), EXIT.failure)

  hub.ops['hub.export'] = () => confirmation('hub.export', 'pending')
  hub.ops['confirmation.get'] = () => confirmation('hub.export', 'denied')
  const denied = await loggedIn()
  assert.equal(await main(['hub', 'export'], denied.ctx), EXIT.denied)
  assert.match(denied.stderr(), /オーナーが拒否/)

  const noAdmin = await loggedIn({}, 'dsh.read dsh.tasks offline_access')
  assert.equal(await main(['hub', 'export'], noAdmin.ctx), EXIT.denied)
  assert.match(noAdmin.stderr(), /remora login --admin/)
  assert.equal(hub.calls.length, 0)
})

test('hub export prints or saves the settings; rotate-key picks the only host and reports the new fingerprint', async () => {
  const settings = { format: 'remora-hub-export/v1', exportedAt: 1, hubOrigin: hub.url, hubVersion: '0.1.0', settings: { allowOtherClients: false, dynamicClientRegistration: false }, hosts: [{ hostId: 'h-1' }], clients: [], personalTokens: [], passkeys: [], pushDevices: [] }
  hub.ops['hub.export'] = () => confirmation('hub.export', 'pending')
  hub.ops['confirmation.get'] = () => confirmation('hub.export', 'done', settings)
  const printed = await loggedIn()
  assert.equal(await main(['hub', 'export'], printed.ctx), EXIT.ok, printed.stderr())
  assert.equal(JSON.parse(printed.stdout()).format, 'remora-hub-export/v1')
  const saved = await loggedIn()
  assert.equal(await main(['hub', 'export', '--out', 'hub.json'], saved.ctx), EXIT.ok)
  assert.equal(JSON.parse(await readFile(join(saved.dir, 'hub.json'), 'utf8')).hosts[0].hostId, 'h-1')

  hub.ops['hosts.list'] = () => ({ hosts: [{ hostId: 'h-1', name: 'PC', online: true, lastSeenAt: null, pluginVersion: null, dshVersion: null, operations: [], ceiling: null, grant: null, killSwitch: false }] })
  hub.ops['host.rotate-key'] = () => ({ ...confirmation('host.rotate-key', 'pending'), confirmationId: 'h-1-rot', hostId: 'h-1' })
  hub.ops['confirmation.get'] = () => ({ ...confirmation('host.rotate-key', 'done', { hostId: 'h-1', publicKeyFingerprint: '0123456789abcdef', rotatedAt: 5 }), confirmationId: 'h-1-rot' })
  const rotated = await loggedIn()
  assert.equal(await main(['rotate-key'], rotated.ctx), EXIT.ok, rotated.stderr())
  assert.deepEqual(hub.calls.find(call => call.op === 'host.rotate-key')?.params, { hostId: 'h-1' })
  assert.match(rotated.stdout(), /0123456789abcdef/)
  const viaHosts = await loggedIn()
  assert.equal(await main(['hosts', 'rotate-key', 'h-1', '--json'], viaHosts.ctx), EXIT.ok)
  assert.equal(JSON.parse(viaHosts.stdout()).publicKeyFingerprint, '0123456789abcdef')

  // --resume picks up the earlier request without asking again.
  const resumed = await loggedIn()
  assert.equal(await main(['rotate-key', '--resume', 'h-1-rot'], resumed.ctx), EXIT.ok, resumed.stderr())
  assert.ok(!hub.calls.some(call => call.op === 'host.rotate-key'))
})
