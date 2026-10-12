import { fork, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withTokenLock } from '../src/token-lock.ts'
import { testCtx } from './helpers.ts'

const HUB_URL = 'https://hub.example.com'
const lockPath = (dir: string) => join(dir, `tokens-${createHash('sha256').update(HUB_URL).digest('hex').slice(0, 16)}.lock`)

function childLock(mode: string, dir: string) {
  const child = fork(new URL('./fixtures/token-lock-child.ts', import.meta.url), [mode, dir, HUB_URL], {
    execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const seen = new Set<string>()
  const waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  let closed = false
  const fail = () => { for (const waiter of waiting.values()) waiter.reject(new Error('token lock child stopped')); waiting.clear() }
  child.stderr?.resume()
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') return
    if (message.type === 'failed') { fail(); return }
    seen.add(message.type)
    waiting.get(message.type)?.resolve()
    waiting.delete(message.type)
  })
  child.on('error', fail)
  const exited = new Promise<void>(resolve => { child.once('close', () => { closed = true; fail(); resolve() }) })
  const wait = (type: string): Promise<void> => {
    if (seen.has(type)) return Promise.resolve()
    if (closed) return Promise.reject(new Error('token lock child already stopped'))
    const pending = new Promise<void>((resolve, reject) => { waiting.set(type, { resolve, reject }) })
    void pending.catch(() => {})
    return pending
  }
  const stop = async () => {
    if (!closed) child.kill('SIGKILL')
    await exited
  }
  return { child, wait, exited, stop, send: (type: string) => { child.send({ type }) } }
}

async function deadOwner(dir: string): Promise<string> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (status, signal) => {
      if (status !== 0 || signal !== null) reject(new Error('fixture process did not exit normally'))
      else resolve()
    })
  })
  assert.ok(child.pid)
  const token = randomUUID()
  await mkdir(lockPath(dir))
  await writeFile(join(lockPath(dir), 'owner.json'), JSON.stringify({ pid: child.pid, host: hostname(), token }), { mode: 0o600 })
  return token
}

test('a process killed before claim leaves no ownerless lock', { timeout: 30_000 }, async t => {
  const fixture = await testCtx()
  const child = childLock('prepared', fixture.dir)
  t.after(async () => { await child.stop(); await rm(fixture.dir, { recursive: true, force: true }) })
  await child.wait('prepared')
  await child.stop()
  await assert.rejects(access(lockPath(fixture.dir)), { code: 'ENOENT' })
  assert.equal((await readdir(fixture.dir)).filter(name => name.includes('.candidate-')).length, 1)
  assert.equal(await withTokenLock(fixture.ctx, HUB_URL, async () => 'acquired'), 'acquired')
})

test('a process killed after retiring a stale generation cannot block recovery', { timeout: 30_000 }, async t => {
  const fixture = await testCtx()
  const token = await deadOwner(fixture.dir)
  const child = childLock('retired', fixture.dir)
  t.after(async () => { await child.stop(); await rm(fixture.dir, { recursive: true, force: true }) })
  await child.wait('retired')
  await child.stop()
  await access(join(`${lockPath(fixture.dir)}.stale-${token}`, 'owner.json'))
  assert.equal(await withTokenLock(fixture.ctx, HUB_URL, async () => 'acquired'), 'acquired')
})

test('a delayed competing reaper cannot retire the live replacement', { timeout: 30_000 }, async t => {
  const fixture = await testCtx()
  const token = await deadOwner(fixture.dir)
  const first = childLock('reaper', fixture.dir)
  const late = childLock('reaper', fixture.dir)
  t.after(async () => { await Promise.all([first.stop(), late.stop()]); await rm(fixture.dir, { recursive: true, force: true }) })
  // Both have read the same dead owner, before either can retire it.
  await Promise.all([first.wait('observed'), late.wait('observed')])
  first.send('recover')
  await first.wait('entered')
  late.send('recover')
  await late.wait('blocked')
  const owner = JSON.parse(await readFile(join(lockPath(fixture.dir), 'owner.json'), 'utf8')) as { pid: number }
  assert.equal(owner.pid, first.child.pid)
  await access(join(`${lockPath(fixture.dir)}.stale-${token}`, 'owner.json'))
  first.send('release')
  await first.wait('completed')
  await late.wait('entered')
  late.send('release')
  await late.wait('completed')
  await Promise.all([first.exited, late.exited])
  assert.equal(first.child.exitCode, 0)
  assert.equal(late.child.exitCode, 0)
})

test('a contender preserves a live owner until its atomic release', { timeout: 30_000 }, async t => {
  const fixture = await testCtx()
  const holder = childLock('hold', fixture.dir)
  let contender: ReturnType<typeof childLock> | undefined
  t.after(async () => { await holder.stop(); await contender?.stop(); await rm(fixture.dir, { recursive: true, force: true }) })
  await holder.wait('entered')
  contender = childLock('contend', fixture.dir)
  await contender.wait('blocked')
  const owner = JSON.parse(await readFile(join(lockPath(fixture.dir), 'owner.json'), 'utf8')) as { pid: number }
  assert.equal(owner.pid, holder.child.pid)
  assert.ok(!(await readdir(fixture.dir)).some(name => name.includes('.stale-')))
  holder.send('release')
  await holder.wait('completed')
  await contender.wait('entered')
  contender.send('release')
  await contender.wait('completed')
  await Promise.all([holder.exited, contender.exited])
})
