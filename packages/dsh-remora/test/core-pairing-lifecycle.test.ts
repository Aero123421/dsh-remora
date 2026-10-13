import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { apply } from '../src/index.ts'
import { createAdapter } from '../src/adapter/index.ts'
import type { Adapter } from '../src/ops/types.ts'
import { HOST_KEY_RECORD, HostKeyStore, type CredentialsLike } from '../src/core/hostkey.ts'
import { InstanceLock } from '../src/core/lock.ts'
import { JsonDocument } from '../src/core/storage.ts'
import { pairingSpec } from '../src/core/settings.ts'
import { createFake } from './fake-dsh.ts'
import { FakeHub } from './fake-hub.ts'
import { makePasskey, tempDir, until } from './helpers.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(modify: (adapter: Adapter) => Adapter = adapter => adapter) {
  const temp = await tempDir('remora-pairing-lifecycle-')
  const records = new Map<string, { kind: 'grant'; payload: unknown }>()
  let nextGate: { entered: ReturnType<typeof deferred>; resume: ReturnType<typeof deferred> } | null = null
  const gates: ReturnType<typeof deferred>[] = []
  const credentials: CredentialsLike = {
    readRecord: async key => records.get(key),
    modifyRecord: async (key, change) => {
      const next = await change(records.get(key))
      if (key === HOST_KEY_RECORD && nextGate) {
        const gate = nextGate
        nextGate = null
        gate.entered.resolve()
        await gate.resume.promise
      }
      if (next) records.set(key, next)
      return next
    },
    deleteRecord: async key => { records.delete(key) },
  }
  const dsh = createFake()
  const base = dsh.ctx()
  const ctx = { ...base, get: (service: string) => service === 'credentials' ? credentials : base.get(service) }
  const owner = [makePasskey('ed25519').credential]
  const hubs: FakeHub[] = []
  const newHub = async () => {
    const hub = new FakeHub({ port: 0, owner })
    await hub.listen()
    hubs.push(hub)
    return hub
  }
  const core = apply(ctx, undefined, { dataDir: temp.dir, createAdapter: (host, deps) => modify(createAdapter(host, deps)) })
  await core.ready
  return {
    ...temp, core, records, credentials, ctx, newHub,
    gateSave() {
      const entered = deferred()
      const resume = deferred()
      gates.push(resume)
      nextGate = { entered, resume }
      return { entered: entered.promise, release: resume.resolve }
    },
    async close() {
      for (const gate of gates) gate.resolve()
      await core.dispose()
      await Promise.all(hubs.map(hub => hub.close()))
      await temp.cleanup()
    },
  }
}

for (const action of ['cancel', 'unpair', 'dispose'] as const) {
  test(`${action} drains an approved pairing write before reporting completion`, { timeout: 10_000 }, async () => {
    const f = await fixture()
    try {
      const hub = await f.newHub()
      const gate = f.gateSave()
      await f.core.startPairing(hub.origin, true)
      await gate.entered
      let settled = false
      const stopping = action === 'cancel' ? f.core.cancelPairing() : action === 'unpair' ? f.core.unpair(true) : f.core.dispose()
      void stopping.then(() => { settled = true })
      await nextTurn()
      assert.equal(settled, false, 'the outstanding credential write must be drained')
      gate.release()
      await stopping
      assert.equal(f.core.snapshot(true).hub.paired, false)
      assert.equal(f.core.internals.link.connected, false)
      assert.equal(f.core.snapshot(true).pairing.phase, action === 'cancel' ? 'cancelled' : 'idle')
      assert.equal(f.records.has(HOST_KEY_RECORD), false)
      assert.equal((await JsonDocument.open(f.dir, pairingSpec)).value.paired, null)
      assert.equal(await new HostKeyStore(f.dir, f.credentials).load(), null)
      assert.equal(hub.connections, 0, 'cancelled approval never authenticates a socket')
    } finally { await f.close() }
  })
}

test('cancelling a re-pair restores the established pairing and key', { timeout: 12_000 }, async () => {
  const f = await fixture()
  try {
    const original = await f.newHub()
    await f.core.startPairing(original.origin, true)
    await until(() => f.core.internals.link.connected, 5000)
    const oldKey = (await new HostKeyStore(f.dir, f.credentials).load())!.publicKey
    const replacement = await f.newHub()
    const gate = f.gateSave()
    await f.core.startPairing(replacement.origin, true)
    await gate.entered
    const cancelled = f.core.cancelPairing()
    gate.release()
    await cancelled
    await until(() => f.core.internals.link.connected, 5000)
    assert.equal(f.core.snapshot(true).pairing.phase, 'cancelled')
    assert.equal(f.core.snapshot(true).hub.hubOrigin, original.origin)
    assert.equal((await new HostKeyStore(f.dir, f.credentials).load())?.publicKey, oldKey)
    assert.equal((await JsonDocument.open(f.dir, pairingSpec)).value.paired?.publicKey, oldKey)
    assert.equal(replacement.connections, 0)
  } finally { await f.close() }
})

test('a newer pairing wins after a superseded approval finishes its credential write', { timeout: 12_000 }, async () => {
  const f = await fixture()
  try {
    const old = await f.newHub()
    const replacement = await f.newHub()
    const gate = f.gateSave()
    await f.core.startPairing(old.origin, true)
    await gate.entered
    const starting = f.core.startPairing(replacement.origin, true)
    gate.release()
    await starting
    await until(() => f.core.internals.link.connected && f.core.snapshot(true).pairing.phase === 'approved', 5000)
    assert.equal(f.core.snapshot(true).hub.hubOrigin, replacement.origin)
    assert.equal((await new HostKeyStore(f.dir, f.credentials).load())?.publicKey, replacement.publicKey)
    assert.equal(old.connections, 0)
  } finally { await f.close() }
})

test('cancellation rolls back a pairing published before the final settings save', { timeout: 10_000 }, async () => {
  const f = await fixture()
  const settingsLock = new InstanceLock(f.dir, 'settings.json.lock')
  try {
    const hub = await f.newHub()
    const gate = f.gateSave()
    await f.core.startPairing(hub.origin, true)
    await gate.entered
    assert.equal(await settingsLock.acquire(), true)
    gate.release()
    await until(() => f.core.internals.pairing().paired !== null, 3000)
    const cancelled = f.core.cancelPairing()
    await settingsLock.release()
    await cancelled
    assert.equal(f.core.snapshot(true).pairing.phase, 'cancelled')
    assert.equal(f.core.internals.pairing().paired, null)
    assert.equal((await JsonDocument.open(f.dir, pairingSpec)).value.paired, null)
    assert.equal(await new HostKeyStore(f.dir, f.credentials).load(), null)
    assert.equal(hub.connections, 0)
  } finally { await settingsLock.release(); await f.close() }
})

for (const action of ['cancel', 'dispose'] as const) {
  test(`${action} rolls back a published pairing while connection preparation is pending`, { timeout: 10_000 }, async () => {
    const entered = deferred()
    const resume = deferred()
    let active = false
    const f = await fixture(adapter => ({ ...adapter, prepare: async () => {
      if (active) { entered.resolve(); await resume.promise }
      await adapter.prepare?.()
    } }))
    try {
      const hub = await f.newHub()
      active = true
      await f.core.startPairing(hub.origin, true)
      await entered.promise
      assert.ok(f.core.internals.pairing().paired, 'approval has reached durable publication')
      const stopping = action === 'cancel' ? f.core.cancelPairing() : f.core.dispose()
      resume.resolve()
      await stopping
      assert.equal(f.core.snapshot(true).pairing.phase, action === 'cancel' ? 'cancelled' : 'idle')
      assert.equal(f.core.internals.pairing().paired, null)
      assert.equal((await JsonDocument.open(f.dir, pairingSpec)).value.paired, null)
      assert.equal(await new HostKeyStore(f.dir, f.credentials).load(), null)
      assert.equal(f.core.internals.link.connected, false)
    } finally { resume.resolve(); await f.close() }
  })
}

test('unpair in another core waits for an already-writing approval and removes its pairing', { timeout: 12_000 }, async () => {
  const f = await fixture()
  const second = apply(f.ctx, undefined, { dataDir: f.dir })
  try {
    await second.ready
    const hub = await f.newHub()
    const gate = f.gateSave()
    await f.core.startPairing(hub.origin, true)
    await gate.entered
    let done = false
    const stopping = second.unpair(true)
    void stopping.then(() => { done = true })
    await nextTurn()
    assert.equal(done, false)
    gate.release()
    await stopping
    await f.core.syncState()
    assert.equal((await JsonDocument.open(f.dir, pairingSpec)).value.paired, null)
    assert.equal(await new HostKeyStore(f.dir, f.credentials).load(), null)
    assert.equal(f.core.internals.link.connected, false)
    assert.equal(second.internals.link.connected, false)
    assert.equal(hub.unpaired, true)
  } finally { await second.dispose(); await f.close() }
})

test('unpair in another core invalidates an approval that has not reached the mutation lock', { timeout: 12_000 }, async () => {
  const entered = deferred()
  const resume = deferred()
  let active = false
  const f = await fixture(adapter => ({ ...adapter, stopClones: async () => {
    if (active) { entered.resolve(); await resume.promise }
    await adapter.stopClones?.()
  } }))
  const second = apply(f.ctx, undefined, { dataDir: f.dir })
  try {
    await second.ready
    const old = await f.newHub()
    active = true
    await f.core.startPairing(old.origin, true)
    await entered.promise
    await second.unpair(true)
    active = false
    resume.resolve()
    await f.core.syncState()
    assert.equal((await JsonDocument.open(f.dir, pairingSpec)).value.paired, null)
    assert.equal(await new HostKeyStore(f.dir, f.credentials).load(), null)
    assert.equal(old.connections, 0)
    // The durable fence rejects old approvals, while a fresh explicit attempt
    // remains usable after unpairing.
    const replacement = await f.newHub()
    await second.startPairing(replacement.origin, true)
    await until(() => second.internals.link.connected || f.core.internals.link.connected, 5000)
    assert.equal((await JsonDocument.open(f.dir, pairingSpec)).value.paired?.hubOrigin, replacement.origin)
    assert.equal((await new HostKeyStore(f.dir, f.credentials).load())?.publicKey, replacement.publicKey)
  } finally { active = false; resume.resolve(); await second.dispose(); await f.close() }
})

test('a superseded approval reloads the newer pairing key after its owner exits', { timeout: 12_000 }, async () => {
  const entered = deferred()
  const resume = deferred()
  let active = false
  const f = await fixture(adapter => ({ ...adapter, stopClones: async () => {
    if (active) { entered.resolve(); await resume.promise }
    await adapter.stopClones?.()
  } }))
  const second = apply(f.ctx, undefined, { dataDir: f.dir })
  try {
    await second.ready
    const original = await f.newHub()
    const replacement = await f.newHub()
    active = true
    await f.core.startPairing(original.origin, true)
    await entered.promise
    await second.startPairing(replacement.origin, true)
    await until(() => second.internals.link.connected, 5000)
    await second.dispose()
    active = false
    resume.resolve()
    await f.core.syncState()
    await f.core.reconnect()
    await until(() => f.core.internals.link.connected, 3000)
    assert.equal(f.core.snapshot(true).hub.hubOrigin, replacement.origin)
    assert.equal(original.connections, 0)
  } finally { active = false; resume.resolve(); await second.dispose(); await f.close() }
})
