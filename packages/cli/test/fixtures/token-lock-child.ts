import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { withTokenLock } from '../../src/token-lock.ts'

const [mode, dir, hubUrl] = process.argv.slice(2)
if (!mode || !dir || !hubUrl) throw new Error('missing lock fixture arguments')
const path = join(dir, `tokens-${createHash('sha256').update(hubUrl).digest('hex').slice(0, 16)}.lock`)
const commands = new Map<string, () => void>()
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && typeof message.type === 'string') commands.get(message.type)?.()
})
const wait = (type: string) => new Promise<void>(resolve => { commands.set(type, resolve) })
const notify = (type: string) => { process.send?.({ type }) }

// Barriers live only in this child process. They stop real production rename
// calls at the crash/race boundaries without adding hooks to the lock API.
const originalRename = fs.rename
let observed = false
let blocked = false
fs.rename = async (source, destination) => {
  const claiming = String(source).startsWith(`${path}.candidate-`) && String(destination) === path
  const retiring = String(source) === path && String(destination).startsWith(`${path}.stale-`)
  if (mode === 'prepared' && claiming) {
    const proceed = wait('claim')
    notify('prepared')
    await proceed
  }
  if (mode === 'reaper' && retiring && !observed) {
    observed = true
    const proceed = wait('recover')
    notify('observed')
    await proceed
  }
  try {
    await originalRename(source, destination)
  } catch (error) {
    if (!blocked && ((mode === 'reaper' && observed && retiring) || (mode === 'contend' && claiming))) {
      blocked = true
      notify('blocked')
    }
    throw error
  }
  if (mode === 'retired' && retiring) {
    const proceed = wait('claim')
    notify('retired')
    await proceed
  }
}
syncBuiltinESMExports()

try {
  await withTokenLock({ env: { REMORA_CONFIG_DIR: dir }, platform: process.platform }, hubUrl, async () => {
    const marker = join(dir, 'critical-section')
    const handle = await fs.open(marker, 'wx', 0o600)
    try {
      const release = wait('release')
      notify('entered')
      await release
    } finally {
      await handle.close()
      await fs.rm(marker)
    }
  })
  process.send?.({ type: 'completed' }, () => process.disconnect())
} catch {
  process.exitCode = 1
  process.send?.({ type: 'failed' }, () => process.disconnect())
}
