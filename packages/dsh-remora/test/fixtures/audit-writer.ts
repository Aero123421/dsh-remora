import { once } from 'node:events'
import { AuditLog } from '../../src/core/audit.ts'

const dir = process.argv[2]
if (!dir) throw new Error('missing audit folder')
const log = await AuditLog.open(dir)
const start = once(process, 'message')
process.send?.('ready')
await start
for (let i = 0; i < 20; i++) await log.append({ kind: 'settings', action: `writer:${process.pid}:${i}`, outcome: 'ok' })
await log.flush()
process.disconnect()
