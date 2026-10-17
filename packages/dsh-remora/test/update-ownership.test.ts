import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpdateInstallation } from '../src/core/updates.ts'
import type { RemoraSnapshot } from '../src/core/remora.ts'
import { tempDir } from './helpers.ts'

type Reply = { ok: boolean; value?: unknown; error?: { code: string } }
type Message = { event?: string; id?: number; value?: Reply; requestId?: string; enabled?: boolean }

function updateHost(dir: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/update-host.ts', import.meta.url)), [dir], { execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const messages: Message[] = []
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  child.on('message', message => messages.push(message as Message))
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  let nextId = 0
  async function waitFor<T>(read: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 10_000
    while (true) {
      const result = read()
      if (result !== undefined) return result
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`update Host exited: ${stderr}`)
      if (Date.now() >= deadline) throw new Error(`update Host barrier timed out: ${stderr}`)
      await delay(10)
    }
  }
  const callResult = async (method: string): Promise<Reply> => {
    const id = ++nextId
    child.send({ id, method })
    return waitFor(() => messages.find(message => message.id === id)?.value)
  }
  return {
    child, messages, closed, waitFor,
    ready: () => waitFor(() => messages.find(message => message.event === 'ready')),
    callResult,
    call: async <T>(method: string): Promise<T> => {
      const reply = await callResult(method)
      assert.equal(reply.ok, true, JSON.stringify(reply))
      return reply.value as T
    },
    release: () => child.send({ method: 'release' }),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await closed
    },
  }
}

test('a live process owns its download; another process observes it, then recovers the actual crash lock', async () => {
  const temp = await tempDir()
  const a = updateHost(temp.dir)
  const b = updateHost(temp.dir)
  try {
    await Promise.all([a.ready(), b.ready()])
    // Keep A's RPC outstanding until its process is killed.
    a.child.send({ id: 100, method: 'update-install' })
    await a.waitFor(() => a.messages.find(message => message.event === 'download'))
    const original = await b.call<UpdateInstallation>('update-reconcile')
    assert.equal(original.phase, 'downloading')
    assert.deepEqual(await b.call<UpdateInstallation>('update-install'), original)
    const state = await b.call<RemoraSnapshot>('state')
    assert.equal(state.ready, true)
    assert.equal(state.updateInstallation?.requestId, original.requestId)
    assert.equal(b.messages.filter(message => message.event === 'download').length, 0)
    assert.equal(a.messages.filter(message => message.event === 'manager').length, 0)
    const lockPath = join(temp.dir, '.dsh-remora-updates', 'update-operation.lock', 'owner.json')
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, a.child.pid)
    await a.stop()
    const interrupted = await b.call<UpdateInstallation>('update-reconcile')
    assert.equal(interrupted.phase, 'failed')
    assert.equal(interrupted.error, 'interrupted-before-install')
    const pending = b.call<UpdateInstallation>('update-install')
    await b.waitFor(() => b.messages.find(message => message.event === 'download'))
    b.release()
    const result = await pending
    assert.equal(result.phase, 'restart-required')
    assert.equal(result.attempt, original.attempt + 1)
    assert.notEqual(result.requestId, original.requestId)
    assert.equal(b.messages.filter(message => message.event === 'manager').length, 1)
    assert.equal(b.messages.find(message => message.event === 'manager')?.enabled, false)
  } finally { await a.stop(); await b.stop(); await temp.cleanup() }
})

test('simultaneous update RPCs across processes claim only one download and one manager installation', async () => {
  const temp = await tempDir()
  const a = updateHost(temp.dir)
  const b = updateHost(temp.dir)
  try {
    await Promise.all([a.ready(), b.ready()])
    const results = Promise.all([a.callResult('update-install'), b.callResult('update-install')])
    await a.waitFor(() => [...a.messages, ...b.messages].find(message => message.event === 'download'))
    a.release()
    b.release()
    const replies = await results
    // A loser can observe ownership before the winner's receipt is durable.
    // It must return busy or that receipt, and must never submit another install.
    for (const reply of replies) if (!reply.ok) assert.equal(reply.error?.code, 'remora/update-in-progress')
    const operations = replies.filter(reply => reply.ok).map(reply => reply.value as UpdateInstallation)
    assert.ok(operations.length >= 1)
    assert.ok(operations.every(operation => operation.requestId === operations[0]!.requestId))
    assert.equal([...a.messages, ...b.messages].filter(message => message.event === 'download').length, 1)
    assert.equal([...a.messages, ...b.messages].filter(message => message.event === 'manager').length, 1)
    const completed = await a.call<UpdateInstallation>('update-reconcile')
    assert.equal(completed.phase, 'restart-required')
    assert.equal((await b.call<UpdateInstallation>('update-install')).requestId, completed.requestId)
    assert.equal([...a.messages, ...b.messages].filter(message => message.event === 'manager').length, 1)
  } finally { await a.stop(); await b.stop(); await temp.cleanup() }
})
