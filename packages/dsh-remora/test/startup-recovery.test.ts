import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import type { RemoraSnapshot } from '../src/core/remora.ts'
import { fakeHost, rpc, tempDir } from './helpers.ts'

test('partial storage initialization remains diagnosable without exposing raw parser input or changing files', async t => {
  for (const file of ['settings.json', 'pairing.json', 'confirmations.json', 'tasks.json', 'workspace-creations.json', 'remote-schedules.json']) {
    for (const failure of ['newer-version', 'malformed']) await t.test(`${file}: ${failure}`, async () => {
      const temp = await tempDir()
      const secret = 'credential-secret-must-never-appear'
      const text = failure === 'newer-version' ? JSON.stringify({ version: 999, data: { secret } }) : `{"version":1,"data":${secret}}`
      await writeFile(join(temp.dir, file), text)
      const host = fakeHost()
      const core = apply(host.ctx, undefined, { dataDir: temp.dir })
      try {
        await core.ready
        const response = await rpc<RemoraSnapshot>(host.routes, 'state')
        assert.equal(response.ok, true)
        if (!response.ok) return
        const state = response.value
        assert.equal(state.ready, false)
        assert.match(state.fatal ?? '', new RegExp(`${file}: ${failure}`))
        assert.match(state.fatal ?? '', failure === 'newer-version' ? /Update Remora.*keep/ : /back up.*restore/)
        assert.equal(JSON.stringify(state).includes(secret), false)
        assert.equal(JSON.stringify(host.warnings).includes(secret), false)
        assert.equal(state.hub.link.state, 'stopped')
        assert.equal(state.canInstallUpdate, false)
        assert.ok(state.operations.every(operation => !operation.allowed && !operation.available))
        assert.equal(core.snapshot(true).fatal, state.fatal)
        for (const method of ['settings', 'pairing-start', 'update-install', 'reconnect']) {
          const denied = await rpc(host.routes, method, {})
          assert.equal(denied.ok, false)
          if (!denied.ok) assert.equal(denied.error.code, 'remora/storage-failed')
        }
        assert.equal((await rpc(host.routes, 'audit')).ok, true)
        assert.equal((await rpc(host.routes, 'clients')).ok, true)
        assert.equal(await readFile(join(temp.dir, file), 'utf8'), text)
      } finally { await core.dispose(); await temp.cleanup() }
    })
  }
})
