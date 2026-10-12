import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { RequestFrame } from '@dsh-remora/protocol'
import { apply } from '../src/index.ts'
import { JsonDocument } from '../src/core/storage.ts'
import { pairingSpec } from '../src/core/settings.ts'
import { FileRemoteScheduleStore, remoteSchedulesSpec } from '../src/core/remote-schedules.ts'
import { createFake } from './fake-dsh.ts'
import { FakeHub } from './fake-hub.ts'
import { makePasskey, tempDir, until } from './helpers.ts'

function request(id: string, op: string, params: unknown, taskId?: string): RequestFrame {
  return { t: 'request', id, op, params, actor: { clientId: 'test-client', clientName: 'Test' }, scopes: ['dsh.read', 'dsh.content', 'dsh.tasks'], grant: { level: 'request' }, deadline: Date.now() + 10_000, ...(taskId ? { taskId } : {}) }
}

async function fixture() {
  const temp = await tempDir()
  const dsh = createFake()
  dsh.addWorkspace('w1', join(temp.dir, 'work'))
  dsh.addSession('s1', { workspace: 'w1', live: true })
  const hub = new FakeHub({ port: 0, owner: [makePasskey('ed25519').credential] })
  await hub.listen()
  const core = apply(dsh.ctx(), undefined, { dataDir: temp.dir })
  await core.ready
  await core.setPermission({ level: 'request' }, true)
  await core.updateSettings({ scope: { workspaces: ['w1'] } }, true)
  await core.startPairing(hub.origin, true)
  await until(() => core.internals.link.connected, 5000)
  return { ...temp, dsh, hub, core, async close() { await core.dispose(); await hub.close(); await temp.cleanup() } }
}

test('a stop in another instance closes the owner, rejects queued requests, and removes remote schedules', async () => {
  const f = await fixture()
  const second = apply(f.dsh.ctx(), undefined, { dataDir: f.dir })
  try {
    await second.ready
    assert.equal(second.snapshot(true).hub.lock, 'other')
    f.hub.send(request('schedule', 'schedule.create', { sessionId: 's1', title: 'Remote', prompt: 'scheduled', when: { everySeconds: 60 }, idempotencyKey: 'schedule-key' }))
    assert.equal((await f.hub.response('schedule')).ok, true)
    assert.equal(f.dsh.scheduleRows.length, 1)
    await second.setKillSwitch(true, false)
    assert.equal(f.core.internals.link.connected, false, 'the other tab reports success after the owner has stopped')
    assert.equal(f.dsh.scheduleRows.length, 0)
    f.hub.send(request('after-stop', 'task.start', { target: { sessionId: 's1' }, prompt: 'must not run', idempotencyKey: 'stop-key' }, 'after-stop'))
    await until(() => !f.core.internals.link.connected && f.dsh.scheduleRows.length === 0, 5000)
    assert.equal(f.core.snapshot(true).settings.killSwitch, true)
    assert.equal(f.dsh.calls.some(call => call.method === 'prompt'), false)
    await second.updateSettings({ hostName: 'Renamed' }, false)
    await f.core.syncState()
    assert.equal(f.core.snapshot(true).settings.killSwitch, true, 'a stale neutral edit cannot undo the stop')
    assert.equal(f.core.snapshot(true).settings.hostName, 'Renamed')
  } finally { await second.dispose(); await f.close() }
})

test('revoking a host removes its tracked schedules while preserving local schedules', async () => {
  const f = await fixture()
  try {
    f.hub.send(request('schedule', 'schedule.create', { sessionId: 's1', title: 'Remote', prompt: 'scheduled', when: { everySeconds: 60 }, idempotencyKey: 'schedule-key' }))
    assert.equal((await f.hub.response('schedule')).ok, true)
    const remoteId = f.dsh.scheduleRows[0]?.id
    assert.ok(remoteId)
    f.dsh.scheduleRows.push({ ...f.dsh.scheduleRows[0]!, id: 'local-schedule', record: { ...f.dsh.scheduleRows[0]!.record, id: 'local-schedule' } })
    f.hub.send({ t: 'close', reason: 'revoked' })
    await until(() => f.core.internals.pairing().revoked && f.dsh.scheduleRows.length === 1 && f.core.snapshot(true).hub.lock === 'none', 5000)
    assert.deepEqual(f.dsh.scheduleRows.map(row => row.id), ['local-schedule'])
    const store = new FileRemoteScheduleStore(await JsonDocument.open(f.dir, remoteSchedulesSpec))
    assert.deepEqual(store.list(), [])
    assert.equal(f.core.internals.link.status.state, 'stopped')
  } finally { await f.close() }
})

test('a revoked pairing retries persisted schedule cleanup after restart', async () => {
  const f = await fixture()
  let restarted: ReturnType<typeof apply> | undefined
  try {
    f.hub.send(request('schedule', 'schedule.create', { sessionId: 's1', title: 'Remote', prompt: 'scheduled', when: { everySeconds: 60 }, idempotencyKey: 'schedule-key' }))
    assert.equal((await f.hub.response('schedule')).ok, true)
    await f.core.dispose()
    const pairing = await JsonDocument.open(f.dir, pairingSpec)
    await pairing.update(current => ({ ...current, revoked: true }))
    restarted = apply(f.dsh.ctx(), undefined, { dataDir: f.dir })
    await restarted.ready
    assert.equal(restarted.snapshot(true).hub.revoked, true)
    assert.equal(restarted.internals.link.connected, false)
    assert.deepEqual(f.dsh.scheduleRows, [])
  } finally { await restarted?.dispose(); await f.close() }
})
