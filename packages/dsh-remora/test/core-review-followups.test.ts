import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import type { RequestFrame } from '@dsh-remora/protocol'
import { createAdapter } from '../src/adapter/index.ts'
import { InstanceLock } from '../src/core/lock.ts'
import { FileRemoteScheduleStore, remoteSchedulesSpec } from '../src/core/remote-schedules.ts'
import { RpcError } from '../src/core/rpc-error.ts'
import { settingsSpec } from '../src/core/settings.ts'
import { JsonDocument, writeAtomic } from '../src/core/storage.ts'
import { apply } from '../src/index.ts'
import type { Adapter } from '../src/ops/types.ts'
import { createFake } from './fake-dsh.ts'
import { FakeHub } from './fake-hub.ts'
import { makePasskey, tempDir, until } from './helpers.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function stopGate() {
  const released = deferred()
  return {
    active: false,
    entered: false,
    release: released.resolve,
    async wait() { if (this.active) { this.entered = true; await released.promise } },
  }
}

async function fixture(modify: (adapter: Adapter) => Adapter = adapter => adapter, paired = true) {
  const temp = await tempDir('remora-core-followup-')
  const dsh = createFake()
  dsh.addWorkspace('w1', join(temp.dir, 'work'))
  dsh.addSession('s1', { workspace: 'w1', live: true })
  const hub = new FakeHub({ port: 0, owner: [makePasskey('ed25519').credential] })
  let core: ReturnType<typeof apply> | undefined
  const close = async () => { await core?.dispose(); await hub.close(); await temp.cleanup() }
  try {
    await hub.listen()
    core = apply(dsh.ctx(), undefined, { dataDir: temp.dir, createAdapter: (ctx, deps) => modify(createAdapter(ctx, deps)) })
    await core.ready
    await core.setPermission({ level: 'request' }, true)
    await core.updateSettings({ scope: { workspaces: ['w1'] } }, true)
    if (paired) {
      await core.startPairing(hub.origin, true)
      await until(() => core!.internals.link.connected, 5000)
    }
    await core.syncState()
    return { ...temp, dsh, hub, core, close }
  } catch (error) { await close(); throw error }
}

async function trackedSchedule(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const request: RequestFrame = {
    t: 'request', id: 'followup-schedule', op: 'schedule.create',
    params: { sessionId: 's1', title: 'Remote', prompt: 'scheduled', when: { everySeconds: 60 }, idempotencyKey: 'followup-key' },
    actor: { clientId: 'test-client', clientName: 'Test' }, scopes: ['dsh.read', 'dsh.content', 'dsh.tasks'],
    grant: { level: 'request' }, deadline: Date.now() + 10_000,
  }
  f.hub.send(request)
  assert.equal((await f.hub.response(request.id)).ok, true)
  const scheduleId = f.dsh.scheduleRows[0]?.id
  assert.ok(scheduleId)
  return scheduleId
}

async function tracking(dir: string) {
  return new FileRemoteScheduleStore(await JsonDocument.open(dir, remoteSchedulesSpec))
}

async function pairingWriteSettled(dir: string): Promise<void> {
  const deadline = Date.now() + 5000
  for (;;) {
    const names = await readdir(dir)
    if (!names.some(name => name === 'pairing.json.lock' || name.startsWith('pairing.json.lock.candidate-') || name.startsWith('pairing.json.lock.released-'))) return
    if (Date.now() >= deadline) throw new Error('pairing document write did not finish')
    await nextTurn()
  }
}

test('protocol mismatch keeps ownership until background teardown finishes', { timeout: 15_000 }, async () => {
  const gate = stopGate()
  const f = await fixture(adapter => ({ ...adapter, stopClones: async () => { await gate.wait(); await adapter.stopClones?.() } }))
  try {
    gate.active = true
    f.hub.send({ t: 'close', reason: 'protocol_mismatch' })
    await until(() => gate.entered || f.core.snapshot(true).hub.lock === 'none', 5000)
    assert.equal(gate.entered, true, 'fatal shutdown invokes background teardown')
    assert.equal(f.core.snapshot(true).hub.lock, 'held')
    assert.equal(f.core.internals.link.connected, false)
    gate.release()
    await f.core.syncState()
    assert.equal(f.core.snapshot(true).hub.lock, 'none')
  } finally { gate.release(); await f.close() }
})

test('unpairing from another instance waits for the owner and tracked schedule cleanup', { timeout: 15_000 }, async () => {
  const gate = stopGate()
  const f = await fixture(adapter => ({ ...adapter, stopClones: async () => { await gate.wait(); await adapter.stopClones?.() } }))
  const second = apply(f.dsh.ctx(), undefined, { dataDir: f.dir })
  let unpair: Promise<void> | undefined
  let finished = false
  try {
    await second.ready
    assert.equal(second.snapshot(true).hub.lock, 'other')
    await trackedSchedule(f)
    gate.active = true
    unpair = second.unpair(false)
    void unpair.then(() => { finished = true }, () => { finished = true })
    await until(() => gate.entered || finished, 5000)
    assert.equal(gate.entered, true)
    await until(() => !second.snapshot(true).hub.paired, 5000)
    await pairingWriteSettled(f.dir)
    // Drain the turn after the reset's actual lock release. The old API had
    // no awaited work left, even though the other owner's teardown was blocked.
    await nextTurn()
    assert.equal(finished, false, 'unpair cannot report success while owner teardown is blocked')
    assert.equal(f.core.snapshot(true).hub.lock, 'held')
    assert.equal((await tracking(f.dir)).list().length, 1)
    gate.release()
    await unpair
    assert.equal(await new InstanceLock(f.dir).occupied(), false, 'the actual owner lease is released before unpair returns')
    await f.core.syncState()
    assert.equal(f.core.snapshot(true).hub.lock, 'none')
    assert.deepEqual(f.dsh.scheduleRows, [])
    assert.deepEqual((await tracking(f.dir)).list(), [])
  } finally {
    gate.release()
    await unpair?.catch(() => undefined)
    await second.dispose()
    await f.close()
  }
})

for (const outcome of ['unchanged', 'rejected'] as const) {
  test(`a queued ${outcome} setting preserves notification of an external scope change`, async () => {
    let notified = 0
    const f = await fixture(adapter => ({ ...adapter, settingsChanged: () => { notified++; adapter.settingsChanged?.() } }), false)
    const lock = new InstanceLock(f.dir, 'settings.json.lock')
    let noOp: Promise<void> | undefined
    let synced: Promise<void> | undefined
    try {
      const before = notified
      assert.equal(await lock.acquire(), true)
      noOp = f.core.setAnswers({ waitMinutes: outcome === 'unchanged' ? 10 : 'invalid' }, false)
      void noOp.catch(() => undefined)
      // Represent the other writer's atomic commit while it owns the document
      // lock; the queued setter must read this value when the lock is released.
      const external = structuredClone(f.core.internals.settings())
      external.scope.workspaces = []
      await writeAtomic(join(f.dir, 'settings.json'), JSON.stringify({ version: settingsSpec('other').version, data: external }))
      synced = f.core.syncState()
      void synced.catch(() => undefined)
      await lock.release()
      if (outcome === 'rejected') await assert.rejects(noOp, error => error instanceof RpcError && error.code === 'invalid-payload')
      else await noOp
      await synced
      assert.deepEqual(f.core.snapshot(true).settings.scope.workspaces, [])
      assert.equal(notified - before, 1, 'the newly observed scope revocation reaches adapter waits and attention')
    } finally {
      await lock.release()
      await noOp?.catch(() => undefined)
      await synced?.catch(() => undefined)
      await f.close()
    }
  })
}

for (const operation of ['kill-switch', 'unpair'] as const) {
  test(`${operation} reports a failed deletion, retains tracking, and retries cleanup`, { timeout: 15_000 }, async () => {
    const f = await fixture()
    try {
      const scheduleId = await trackedSchedule(f)
      const originalDelete = f.dsh.schedule.delete
      let fail = true
      f.dsh.schedule.delete = async request => {
        if (fail) throw new Error('fixture schedule deletion failed')
        return originalDelete(request)
      }
      const stop = () => operation === 'kill-switch' ? f.core.setKillSwitch(true, false) : f.core.unpair(false)
      await assert.rejects(stop(), error => error instanceof RpcError && error.code === 'schedule-cleanup-pending')
      assert.equal(f.core.internals.link.connected, false)
      assert.deepEqual((await tracking(f.dir)).list().map(row => row.scheduleId), [scheduleId])
      assert.deepEqual(f.dsh.scheduleRows.map(row => row.id), [scheduleId])
      if (operation === 'kill-switch') assert.equal(f.core.snapshot(true).settings.killSwitch, true)
      else assert.equal(f.core.snapshot(true).hub.paired, false)
      fail = false
      await stop()
      assert.deepEqual((await tracking(f.dir)).list(), [])
      assert.deepEqual(f.dsh.scheduleRows, [])
    } finally { await f.close() }
  })
}
