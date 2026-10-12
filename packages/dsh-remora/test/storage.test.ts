import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonDocument, StorageError, remoraDataDir, resolveDshHome, type DocumentSpec } from '../src/core/storage.ts'
import { adoptNewOperations, defaultSettings, parseSettings, settingsSpec, tasksSpec } from '../src/core/settings.ts'
import { FileTaskStore, prune, TASK_RETENTION_MS } from '../src/core/tasks.ts'
import { AuditLog, verifyChain } from '../src/core/audit.ts'
import { tempDir } from './helpers.ts'

interface V3 { name: string; tags: string[]; count: number }
const spec: DocumentSpec<V3> = {
  file: 'doc.json',
  version: 3,
  migrations: [
    data => ({ name: (data as { title: string }).title, tags: [] }),
    data => ({ ...(data as object), count: 0 }),
  ],
  initial: () => ({ name: 'new', tags: [], count: 0 }),
  parse: data => {
    const value = data as V3
    if (typeof value.name !== 'string') throw new Error('name')
    return value
  },
}

test('a missing document starts from its initial value and is written atomically on update', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const doc = await JsonDocument.open(dir, spec)
    assert.deepEqual(doc.value, { name: 'new', tags: [], count: 0 })
    await doc.update(v => ({ ...v, count: 1 }))
    const stored = JSON.parse(await readFile(join(dir, 'doc.json'), 'utf8'))
    assert.deepEqual(stored, { version: 3, data: { name: 'new', tags: [], count: 1 } })
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [])
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'doc.json'))).mode & 0o777, 0o600)
  } finally { await cleanup() }
})

test('old documents are migrated step by step and rewritten at the current version', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    await writeFile(join(dir, 'doc.json'), JSON.stringify({ version: 1, data: { title: 'old' } }))
    const doc = await JsonDocument.open(dir, spec)
    assert.deepEqual(doc.value, { name: 'old', tags: [], count: 0 })
    assert.equal(JSON.parse(await readFile(join(dir, 'doc.json'), 'utf8')).version, 3)
  } finally { await cleanup() }
})

test('documents from a newer plugin and malformed files are refused', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    await writeFile(join(dir, 'doc.json'), JSON.stringify({ version: 4, data: {} }))
    await assert.rejects(JsonDocument.open(dir, spec), (error: unknown) => error instanceof StorageError && error.code === 'newer-version')
    await writeFile(join(dir, 'doc.json'), '{not json')
    await assert.rejects(JsonDocument.open(dir, spec), (error: unknown) => error instanceof StorageError && error.code === 'malformed')
  } finally { await cleanup() }
})

test('concurrent updates are serialized', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const doc = await JsonDocument.open(dir, spec)
    await Promise.all(Array.from({ length: 20 }, () => doc.update(v => ({ ...v, count: v.count + 1 }))))
    assert.equal(doc.value.count, 20)
    const reopened = await JsonDocument.open(dir, spec)
    assert.equal(reopened.value.count, 20)
  } finally { await cleanup() }
})

test('the data folder follows DSH_HOME and the dshHomePath service', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/srv/dsh' }), '/srv/dsh')
  assert.match(resolveDshHome({ DSH_HOME: '  ' }), /\.dsh$/)
  assert.equal(remoraDataDir((...s) => ['/h', ...s].join('/')), '/h/storages/dsh-remora')
})

test('settings parse rejects bad ceilings and new operations start switched off', () => {
  assert.throws(() => parseSettings({ ceiling: { level: 'root' } }))
  const settings = { ...defaultSettings(), knownOperations: ['status'], ceiling: { level: 'request' as const } }
  const adopted = adoptNewOperations(settings)
  assert.equal(adopted.ceiling.overrides?.['task.start'], false)
  assert.equal(adopted.ceiling.overrides?.['status'], undefined)
  const full = adoptNewOperations({ ...settings, ceiling: { level: 'full' } })
  assert.equal(full.ceiling.overrides, undefined)
  assert.equal(adoptNewOperations(adopted), adopted)
  assert.equal(settingsSpec('x').version, 1)
})

test('task records are durable when put resolves and old finished tasks are pruned', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const doc = await JsonDocument.open(dir, tasksSpec)
    const store = new FileTaskStore(doc, () => 1_000)
    await store.put({ taskId: 't1', clientId: 'c', sessionId: null, requestId: 'remora:c:t1', state: 'accepted', createdAt: 1, updatedAt: 1 })
    const reopened = new FileTaskStore(await JsonDocument.open(dir, tasksSpec))
    assert.equal(reopened.get('t1')?.requestId, 'remora:c:t1')
    const now = TASK_RETENTION_MS + 10
    const kept = prune([
      { taskId: 'old', clientId: 'c', sessionId: null, requestId: 'r', state: 'completed', createdAt: 0, updatedAt: 1 },
      { taskId: 'running', clientId: 'c', sessionId: null, requestId: 'r', state: 'running', createdAt: 0, updatedAt: 1 },
    ], now)
    assert.deepEqual(kept.map(t => t.taskId), ['running'])
  } finally { await cleanup() }
})

test('the audit log is hash-chained and detects tampering', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    const log = await AuditLog.open(dir)
    await log.append({ kind: 'request', action: 'sessions.list', outcome: 'ok', clientId: 'c1', clientName: 'Claude' })
    await log.append({ kind: 'request', action: 'task.start', outcome: 'denied', clientId: 'c1', layer: 'dsh', reason: 'level-too-low' })
    assert.equal(verifyChain(log.entries()), -1)
    const reopened = await AuditLog.open(dir)
    assert.equal(reopened.intact, true)
    assert.equal(reopened.entries().length, 2)
    const path = join(dir, 'audit.jsonl')
    const text = await readFile(path, 'utf8')
    await writeFile(path, text.replace('"denied"', '"ok"'))
    assert.equal((await AuditLog.open(dir)).intact, false)
  } finally { await cleanup() }
})

test('audit rotation keeps the chain going across files', async () => {
  const { dir, cleanup } = await tempDir()
  try {
    let t = 0
    const log = await AuditLog.open(dir, { maxBytes: 400, now: () => ++t })
    for (let i = 0; i < 6; i++) await log.append({ kind: 'connection', action: `e${i}`, outcome: 'ok' })
    const files = (await readdir(dir)).filter(name => name.startsWith('audit'))
    assert.ok(files.length > 1)
    assert.equal(verifyChain(log.entries()), -1)
  } finally { await cleanup() }
})
