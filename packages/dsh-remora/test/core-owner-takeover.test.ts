import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { RequestFrame } from '@dsh-remora/protocol'
import { apply } from '../src/index.ts'
import { RpcError } from '../src/core/rpc-error.ts'
import { FileRemoteScheduleStore, remoteSchedulesSpec } from '../src/core/remote-schedules.ts'
import { JsonDocument } from '../src/core/storage.ts'
import { createFake } from './fake-dsh.ts'
import { FakeHub } from './fake-hub.ts'
import { makePasskey, tempDir, until } from './helpers.ts'

const restartRequired = (error: unknown) => error instanceof RpcError && error.code === 'restart-required'

test('a cached secondary cannot take over or prune native schedules; a fresh process can clean them', async () => {
  const temp = await tempDir()
  const nativeFile = join(temp.dir, 'native-schedules-fixture.json')
  const firstDsh = createFake()
  firstDsh.addWorkspace('w1', join(temp.dir, 'work'))
  firstDsh.addSession('s1', { workspace: 'w1', live: true })
  const hub = new FakeHub({ port: 0, owner: [makePasskey('ed25519').credential] })
  await hub.listen()
  const first = apply(firstDsh.ctx(), undefined, { dataDir: temp.dir })
  let second: ReturnType<typeof apply> | undefined
  let reloaded: ReturnType<typeof apply> | undefined
  try {
    await first.ready
    await first.setPermission({ level: 'request' }, true)
    await first.updateSettings({ scope: { workspaces: ['w1'] } }, true)
    await first.startPairing(hub.origin, true)
    await until(() => first.internals.link.connected, 5000)

    // DSH loads its native domain once: the secondary exists before the first creates a schedule.
    const cachedDsh = createFake()
    cachedDsh.addWorkspace('w1', join(temp.dir, 'work'))
    cachedDsh.addSession('s1', { workspace: 'w1' })
    second = apply(cachedDsh.ctx(), undefined, { dataDir: temp.dir })
    await second.ready
    assert.equal(second.snapshot(true).hub.lock, 'other')
    let secondaryDeletes = 0
    const cachedDelete = cachedDsh.schedule.delete
    cachedDsh.schedule.delete = async request => {
      secondaryDeletes++
      return cachedDelete(request)
    }
    const create = firstDsh.schedule.create
    firstDsh.schedule.create = async (sessionId, params) => {
      const schedule = await create(sessionId, params)
      await writeFile(nativeFile, JSON.stringify(firstDsh.scheduleRows))
      return schedule
    }
    const frame: RequestFrame = {
      t: 'request', id: 'schedule-before-owner-exit', op: 'schedule.create',
      params: { sessionId: 's1', title: 'Remote schedule', prompt: 'fixture', when: { everySeconds: 3600 }, idempotencyKey: 'stable' },
      actor: { clientId: 'test-client', clientName: 'Test' }, scopes: ['dsh.read', 'dsh.tasks'],
      grant: { level: 'request' }, deadline: Date.now() + 10_000,
    }
    hub.send(frame)
    assert.equal((await hub.response(frame.id)).ok, true)
    assert.equal(firstDsh.scheduleRows.length, 1)
    assert.equal(cachedDsh.scheduleRows.length, 0)
    await first.dispose()
    await until(() => hub.socket === null, 3000)

    await assert.rejects(second.reconnect(), restartRequired)
    await assert.rejects(second.startPairing(hub.origin, true), restartRequired)
    assert.equal(hub.connections, 1, 'a cached secondary never starts a new host connection')
    // Narrowing is still durable, but cannot claim native cleanup without restarting DSH.
    await assert.rejects(second.setKillSwitch(true, false), restartRequired)
    assert.equal(second.snapshot(true).settings.killSwitch, true)
    assert.equal(second.snapshot(true).hub.lock, 'restart')
    await second.updateSettings({ hostName: 'Renamed while stopped' }, false)
    const tracked = new FileRemoteScheduleStore(await JsonDocument.open(temp.dir, remoteSchedulesSpec))
    assert.equal(tracked.list().length, 1, 'the empty secondary catalogue must not prune the durable record')
    assert.equal(secondaryDeletes, 0)

    await second.dispose()
    reloaded = apply(cachedDsh.ctx(), undefined, { dataDir: temp.dir })
    await reloaded.ready
    await assert.rejects(reloaded.reconnect(), restartRequired)
    assert.equal(secondaryDeletes, 0, 'reloading the plugin retains the process-level native cache fence')
    await tracked.refresh()
    assert.equal(tracked.list().length, 1)
    assert.equal((JSON.parse(await readFile(nativeFile, 'utf8')) as unknown[]).length, 1)

    const fixture = fileURLToPath(new URL('./core-owner-takeover.fixture.ts', import.meta.url))
    const { stdout } = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', fixture, temp.dir, nativeFile], { timeout: 10_000, maxBuffer: 16_384 })
    assert.deepEqual(JSON.parse(stdout), { lock: 'none', connected: false, killSwitch: true, remaining: 0 })
    await tracked.refresh()
    assert.equal(tracked.list().length, 0)
    assert.equal((JSON.parse(await readFile(nativeFile, 'utf8')) as unknown[]).length, 0, 'fresh native state really deletes the saved schedule')
    assert.equal(hub.connections, 1)
  } finally {
    await reloaded?.dispose()
    await second?.dispose()
    await first.dispose()
    await hub.close()
    await temp.cleanup()
  }
})

test('delayed plugin startup cannot treat an unobserved native record as deleted', async () => {
  const temp = await tempDir()
  const nativeFile = join(temp.dir, 'native-schedules-fixture.json')
  const cachedDsh = createFake()
  cachedDsh.addWorkspace('w1', join(temp.dir, 'work'))
  cachedDsh.addSession('s1', { workspace: 'w1' })
  // This native context loaded before the former owner wrote the schedule;
  // Remora is enabled only after the owner exited, so lock acquisition never failed.
  const formerOwner = createFake()
  formerOwner.addWorkspace('w1', join(temp.dir, 'work'))
  formerOwner.addSession('s1', { workspace: 'w1' })
  const native = await formerOwner.schedule.create('s1', { title: 'Remote', prompt: 'fixture', every_seconds: 3600 })
  await writeFile(nativeFile, JSON.stringify(formerOwner.scheduleRows))
  const tracked = new FileRemoteScheduleStore(await JsonDocument.open(temp.dir, remoteSchedulesSpec))
  await tracked.put({ scheduleId: native.id, sessionId: 's1', clientId: 'test-client', clientName: 'Test', createdAt: Date.now() })
  let secondaryDeletes = 0
  const cachedDelete = cachedDsh.schedule.delete
  cachedDsh.schedule.delete = async request => {
    secondaryDeletes++
    return cachedDelete(request)
  }
  const core = apply(cachedDsh.ctx(), undefined, { dataDir: temp.dir })
  try {
    await core.ready
    await tracked.refresh()
    assert.equal(tracked.list().length, 1, 'native catalogue absence is not confirmation that the saved schedule was deleted')
    assert.equal(formerOwner.scheduleRows.length, 1)
    assert.equal((JSON.parse(await readFile(nativeFile, 'utf8')) as unknown[]).length, 1)
    assert.equal(cachedDsh.scheduleRows.length, 0)
    assert.equal(secondaryDeletes, 0, 'unconfirmed native authority must fail before calling delete on a stale catalogue')
  } finally {
    await core.dispose()
    await temp.cleanup()
  }
})
