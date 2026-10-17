import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { readFile, readdir, rename, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AuditLog, verifyChain, type AuditEntry } from '../src/core/audit.ts'
import { tempDir } from './helpers.ts'

test('cached audit validation detects same-size edits even when mtime is restored', async () => {
  const temp = await tempDir()
  try {
    const log = await AuditLog.open(temp.dir)
    await log.append({ kind: 'settings', action: 'before', outcome: 'ok' })
    const path = join(temp.dir, 'audit.jsonl')
    const original = await readFile(path, 'utf8')
    const before = await stat(path)
    await writeFile(path, original.replace('before', 'edited'))
    await utimes(path, before.atime, before.mtime)
    await log.append({ kind: 'settings', action: 'after', outcome: 'ok' })
    assert.equal(log.intact, false)
    assert.notEqual(verifyChain(log.entries()), -1)
  } finally { await temp.cleanup() }
})

test('an uncooperative edit between validation and append cannot be cached as intact', async () => {
  const temp = await tempDir()
  try {
    const log = await AuditLog.open(temp.dir)
    await log.append({ kind: 'settings', action: 'before', outcome: 'ok' })
    const path = join(temp.dir, 'audit.jsonl')
    const refresh = Reflect.get(log, 'refresh').bind(log) as () => Promise<void>
    let edit = true
    Reflect.set(log, 'refresh', async () => {
      await refresh()
      if (!edit) return
      edit = false
      await writeFile(path, (await readFile(path, 'utf8')).replace('before', 'edited'))
    })
    await log.append({ kind: 'settings', action: 'after', outcome: 'ok' })
    await log.append({ kind: 'settings', action: 'later', outcome: 'ok' })
    assert.equal(log.intact, false)
    const entries = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as AuditEntry)
    assert.equal(verifyChain(entries), 0)
  } finally { await temp.cleanup() }
})

test('file replacement, truncation and malformed audit rows invalidate cached state safely', async t => {
  for (const text of ['null\n{}\nnot-json\n', '', '{"seq":1,"hash":"invalid"}\n']) await t.test(JSON.stringify(text), async () => {
    const temp = await tempDir()
    try {
      const log = await AuditLog.open(temp.dir)
      await log.append({ kind: 'settings', action: 'old', outcome: 'ok' })
      await writeFile(join(temp.dir, 'replacement'), text)
      await rename(join(temp.dir, 'replacement'), join(temp.dir, 'audit.jsonl'))
      const appended = await log.append({ kind: 'settings', action: 'new', outcome: 'ok' })
      assert.equal(appended.seq, 1)
      assert.equal(log.intact, text === '')
      assert.equal(log.entries().at(-1)?.action, 'new')
    } finally { await temp.cleanup() }
  })
})

test('cached and independent audit writers keep sequence and hash continuity through rotation', async () => {
  const temp = await tempDir()
  try {
    let now = 1_000
    const a = await AuditLog.open(temp.dir, { maxBytes: 700, now: () => ++now })
    const b = await AuditLog.open(temp.dir, { maxBytes: 700, now: () => ++now })
    for (let i = 0; i < 12; i++) await (i % 2 ? b : a).append({ kind: 'settings', action: `entry:${i}:日本語`, outcome: 'ok' })
    const entries: AuditEntry[] = []
    for (const file of (await readdir(temp.dir)).filter(name => name.endsWith('.jsonl'))) {
      entries.push(...(await readFile(join(temp.dir, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as AuditEntry))
    }
    entries.sort((x, y) => x.seq - y.seq)
    assert.deepEqual(entries.map(entry => entry.seq), Array.from({ length: 12 }, (_, i) => i + 1))
    assert.equal(verifyChain(entries), -1)
    assert.equal(a.intact, true)
    assert.equal(b.intact, true)
  } finally { await temp.cleanup() }
})

test('real audit processes serialize appends into one verified sequence', async () => {
  const temp = await tempDir()
  const children: ReturnType<typeof fork>[] = []
  const exits: Promise<number | null>[] = []
  try {
    for (let i = 0; i < 2; i++) {
      const child = fork(fileURLToPath(new URL('./fixtures/audit-writer.ts', import.meta.url)), [temp.dir], { execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      children.push(child)
      const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)))
      exits.push(closed)
      await Promise.race([once(child, 'message'), closed.then(() => { throw new Error('audit writer exited before ready') })])
    }
    for (const child of children) child.send('start')
    assert.deepEqual(await Promise.all(exits), [0, 0])
    const stored = await AuditLog.open(temp.dir)
    assert.equal(stored.intact, true)
    assert.deepEqual(stored.entries().map(entry => entry.seq), Array.from({ length: 40 }, (_, i) => i + 1))
    assert.equal(verifyChain(stored.entries()), -1)
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    await Promise.all(exits)
    await temp.cleanup()
  }
})
