// Native DSH regressions for cross-process emergency stop, Hub revocation,
// and the authenticated HTTP peer used by local-only settings.
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createWorld, installPlugin, removeWorld, startWeb } from './lib/dsh.mjs'
import { startMockLlm } from './lib/mock-llm.mjs'
import { FakeHub } from '../packages/dsh-remora/test/fake-hub.ts'
import { makePasskey } from '../packages/dsh-remora/test/helpers.ts'

async function until(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for native host state')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function rpc(web, method, payload = {}) {
  const auth = await fetch(web.url, { redirect: 'manual' })
  assert.equal(auth.status, 303)
  const cookie = auth.headers.getSetCookie()[0]?.split(';')[0]
  assert.ok(cookie)
  const response = await fetch(`${web.origin}/api/remora/${method}`, {
    method: 'POST', headers: { cookie, origin: web.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'safety', method: `remora/${method}`, payload }),
  })
  const { result } = await response.json()
  assert.equal(result.ok, true, `Native Remora RPC ${method} failed`)
  return result.value
}

function forgedRequest(web, path, { cookie, method = 'GET', payload } = {}) {
  const url = new URL(web.origin)
  const authority = `localhost:${url.port}`
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: url.hostname, port: url.port, path, method,
      headers: { host: authority, ...(cookie ? { cookie } : {}), ...(body ? { origin: `http://${authority}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.setTimeout(10_000, () => request.destroy(new Error('Native HTTP request timed out')))
    request.end(body)
  })
}

export async function nativeHostSafety({ dsh, tarball, artifacts, checkLan = true }) {
  const world = await createWorld()
  const hub = new FakeHub({ port: 0, owner: [makePasskey('ed25519').credential] })
  const mock = await startMockLlm()
  let first, second, lan
  try {
    await hub.listen()
    await installPlugin({ dsh, world, tarball, logFile: join(artifacts, 'safety-install.log') })
    first = await startWeb({ dsh, world, port: 0, mockUrl: mock.url, logFile: join(artifacts, 'safety-first.log') })
    await rpc(first, 'permission', { level: 'request' })
    await rpc(first, 'pairing-start', { hubUrl: hub.origin })
    await until(() => hub.socket !== null)
    const settings = await rpc(first, 'placement-add', { path: world.work })
    const placementId = settings.settings.scope.placements[0].placementId
    const frame = (id, op, params, taskId) => ({ t: 'request', id, op, params, actor: { clientId: 'safety-client', clientName: 'Native safety test' }, scopes: ['dsh.read', 'dsh.content', 'dsh.tasks'], grant: { level: 'request' }, deadline: Date.now() + 15_000, ...(taskId ? { taskId } : {}) })
    hub.send(frame('workspace', 'workspace.create', { placementId, name: 'safety-project', idempotencyKey: 'workspace' }))
    const workspace = await hub.response('workspace', 10_000)
    assert.equal(workspace.ok, true)
    const workspaceId = workspace.result.workspace.workspaceId
    second = await startWeb({ dsh, world, port: 0, mockUrl: mock.url, logFile: join(artifacts, 'safety-second.log') })
    assert.equal((await rpc(second, 'state')).hub.lock, 'other')
    await rpc(second, 'kill-switch', { on: true })
    hub.send(frame('after-stop', 'task.start', { target: { new: { workspaceId } }, prompt: 'Remora E2E nonce=must-not-run', idempotencyKey: 'after-stop' }, 'after-stop'))
    await until(async () => (await rpc(first, 'state')).hub.link.state === 'stopped')
    assert.equal((await rpc(first, 'state')).settings.killSwitch, true)
    assert.equal(mock.requests.some(entry => entry.reply?.includes('must-not-run')), false)
    await second.proc.stop()
    second = undefined
    await rpc(first, 'kill-switch', { on: false })
    await until(() => hub.socket !== null)
    hub.send(frame('live-task', 'task.start', { target: { new: { workspaceId } }, prompt: 'Remora E2E nonce=live-safety', idempotencyKey: 'live-task' }, 'live-task'))
    const task = await hub.response('live-task', 10_000)
    assert.equal(task.ok, true)
    await until(() => mock.requests.some(entry => entry.reply?.includes('live-safety')))
    hub.send(frame('schedule', 'schedule.create', { sessionId: task.result.sessionId, title: 'Revoked schedule', prompt: 'Remora E2E nonce=must-not-schedule', when: { afterSeconds: 2 }, idempotencyKey: 'schedule' }))
    assert.equal((await hub.response('schedule', 10_000)).ok, true)
    hub.send({ t: 'close', reason: 'revoked' })
    await until(async () => (await rpc(first, 'state')).hub.revoked)
    await until(async () => JSON.parse(await readFile(join(world.dshHome, 'storages', 'dsh-remora', 'remote-schedules.json'), 'utf8')).data.schedules.length === 0)
    // The timer is real DSH behavior: wait beyond its due time, then verify no model call.
    await new Promise(resolve => setTimeout(resolve, 2500))
    assert.equal(mock.requests.some(entry => entry.reply?.includes('must-not-schedule')), false)
    assert.equal(mock.requests.some(entry => entry.reply?.includes('must-not-run')), false)

    if (checkLan) {
      const address = Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && !entry.internal)?.address
      if (!address) throw new Error('Native peer regression needs a non-loopback IPv4 interface')
      await first.proc.stop()
      first = undefined
      lan = await startWeb({ dsh, world, host: address, port: 0, mockUrl: mock.url, logFile: join(artifacts, 'safety-lan.log') })
      // A legitimate DSH operator can exchange its launch token under a forged
      // loopback Host. Remora must still see the actual non-loopback socket.
      const auth = await forgedRequest(lan, `/?token=${encodeURIComponent(lan.token)}`)
      assert.equal(auth.status, 303)
      const cookie = auth.headers['set-cookie'][0].split(';')[0]
      const envelope = (method, payload) => ({ type: 'client-request', rpcId: 'safety-lan', method: `remora/${method}`, payload })
      const response = await forgedRequest(lan, '/api/remora/permission', { cookie, method: 'POST', payload: envelope('permission', { level: 'full', confirmFull: true }) })
      assert.equal(response.status, 200)
      assert.equal(JSON.parse(response.text).result.error.code, 'remora/local-only')
      const state = await forgedRequest(lan, '/api/remora/state', { cookie, method: 'POST', payload: envelope('state', {}) })
      assert.equal(JSON.parse(state.text).result.value.local, false)
    }
    return `Two native DSH processes: stop enforced; revoked schedule never ran${checkLan ? '; forged loopback headers refused on a LAN socket' : ''}`
  } finally {
    await lan?.proc.stop()
    await second?.proc.stop()
    await first?.proc.stop()
    await hub.close()
    await mock.close()
    await removeWorld(world)
  }
}
