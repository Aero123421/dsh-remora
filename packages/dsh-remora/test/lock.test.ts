import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { InstanceLock } from '../src/core/lock.ts'
import { tempDir } from './helpers.ts'

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  await once(child, 'close')
  assert.ok(pid)
  return pid
}

test('only one contender acquires a dead owner generation, including after an interrupted claim', async () => {
  const { dir, cleanup } = await tempDir()
  const contenders = Array.from({ length: 8 }, () => new InstanceLock(dir))
  try {
    const token = randomUUID()
    const body = { pid: await deadPid(), host: hostname(), token, at: 0 }
    // A candidate interrupted before its atomic claim does not block the final path.
    await mkdir(join(dir, 'hub.lock.candidate-orphan'))
    assert.equal(await contenders[0]!.acquire(), true)
    await contenders[0]!.release()
    await mkdir(join(dir, 'hub.lock'))
    await writeFile(join(dir, 'hub.lock', 'owner.json'), JSON.stringify(body))
    const acquired = await Promise.all(contenders.map(lock => lock.acquire()))
    assert.equal(acquired.filter(Boolean).length, 1)
    assert.ok((await readdir(dir)).includes(`hub.lock.stale-${token}`), 'the fenced dead generation survives interrupted recovery')
    await Promise.all(contenders.map(lock => lock.release()))
    assert.equal(await contenders[0]!.acquire(), true)
  } finally { await Promise.all(contenders.map(lock => lock.release())); await cleanup() }
})

test('an older live lock is respected and a dead file lock can be taken over', async () => {
  const { dir, cleanup } = await tempDir()
  const lock = new InstanceLock(dir)
  try {
    const token = randomUUID()
    await writeFile(lock.path, JSON.stringify({ pid: process.pid, host: hostname(), token, at: 0 }))
    assert.equal(await lock.acquire(), false)
    await writeFile(lock.path, JSON.stringify({ pid: await deadPid(), host: hostname(), token, at: 0 }))
    assert.equal(await lock.acquire(), true)
  } finally { await lock.release(); await cleanup() }
})

test('overlapping acquire calls on one instance share the same claim', async () => {
  const { dir, cleanup } = await tempDir()
  const lock = new InstanceLock(dir)
  const other = new InstanceLock(dir)
  try {
    assert.deepEqual(await Promise.all([lock.acquire(), lock.acquire()]), [true, true])
    assert.equal(await other.acquire(), false)
    await lock.release()
    assert.equal(await other.acquire(), true)
  } finally { await lock.release(); await other.release(); await cleanup() }
})
