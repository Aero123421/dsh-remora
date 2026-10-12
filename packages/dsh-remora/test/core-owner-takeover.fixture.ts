import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import { createFake } from './fake-dsh.ts'

// A new process gets a fresh native catalogue, unlike a plugin reload in the cached secondary.
const dataDir = process.argv[2]
const nativeFile = process.argv[3]
assert.ok(dataDir && nativeFile)
const dsh = createFake()
dsh.addWorkspace('w1', join(dataDir, 'work'))
dsh.addSession('s1', { workspace: 'w1' })
const rows: unknown = JSON.parse(await readFile(nativeFile, 'utf8'))
assert.ok(Array.isArray(rows))
dsh.scheduleRows = rows
const deletion = dsh.schedule.delete
dsh.schedule.delete = async request => {
  const result = await deletion(request)
  await writeFile(nativeFile, JSON.stringify(dsh.scheduleRows))
  return result
}
const core = apply(dsh.ctx(), undefined, { dataDir })
try {
  await core.ready
  assert.equal(core.snapshot(true).fatal, null)
  process.stdout.write(JSON.stringify({ lock: core.snapshot(true).hub.lock, connected: core.internals.link.connected, killSwitch: core.snapshot(true).settings.killSwitch, remaining: dsh.scheduleRows.length }) + '\n')
} finally {
  await core.dispose()
}
