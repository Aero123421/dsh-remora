import { once } from 'node:events'
import { JsonDocument } from '../../src/core/storage.ts'
import { settingsSpec } from '../../src/core/settings.ts'

const dir = process.argv[2]
if (!dir) throw new Error('missing test folder')
const doc = await JsonDocument.open(dir, settingsSpec('0'))
const start = once(process, 'message')
process.send?.('ready')
await start
for (let i = 0; i < 10; i++) await doc.update(current => ({ ...current, hostName: String(Number(current.hostName) + 1) }))
process.disconnect()
