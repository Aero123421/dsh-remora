import { createHash } from 'node:crypto'
import { defaultCtx } from '../../src/ctx.ts'
import { openHub } from '../../src/hub.ts'

const ctx = defaultCtx()
ctx.env = { ...process.env, REMORA_CONFIG_DIR: process.argv[3], REMORA_TOKEN_STORE: 'file' }
const hub = await openHub(ctx, process.argv[2])
process.once('message', () => {
  process.send?.({ type: 'started' })
  void hub.token('api').then(token => {
    process.send?.({ type: 'result', hash: createHash('sha256').update(token).digest('hex') }, () => process.disconnect())
  }, () => {
    process.send?.({ type: 'failed' }, () => { process.exitCode = 1; process.disconnect() })
  })
})
process.send?.({ type: 'ready' })
