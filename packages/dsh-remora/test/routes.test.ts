import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, inject } from '../src/index.ts'
import type { FetchRoute, HostContext } from '../src/dsh.ts'

function fakeHost(services: string[] = []) {
  const routes = new Map<string, FetchRoute>()
  const ctx: HostContext = {
    connection: { fetch: { register: route => { routes.set(route.path, route) } } },
    get: service => (services.includes(service) ? {} : undefined),
    effect: () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx)
  return routes
}

async function rpc(routes: Map<string, FetchRoute>, method: string, payload: unknown = {}, init: { contentType?: string; envelopeMethod?: string } = {}) {
  const route = routes.get(`/api/remora/${method}`)
  assert.ok(route, `route for ${method}`)
  const body = JSON.stringify({ type: 'client-request', rpcId: 'r1', method: init.envelopeMethod ?? `remora/${method}`, payload })
  return route.fetch(new Request(`http://localhost/api/remora/${method}`, { method: 'POST', headers: { 'content-type': init.contentType ?? 'application/json' }, body }))
}

test('plugin identity', () => {
  assert.equal(name, 'dsh-remora')
  assert.deepEqual(inject, ['connection'])
})

test('state starts disconnected, view-only, kill switch off', async () => {
  const response = await rpc(fakeHost(['sessionController']), 'state')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json() as { result: { ok: boolean; value: { hub: { connected: boolean }; permission: { level: string }; killSwitch: boolean } } }
  assert.equal(body.result.ok, true)
  assert.equal(body.result.value.hub.connected, false)
  assert.equal(body.result.value.permission.level, 'view')
  assert.equal(body.result.value.killSwitch, false)
})

test('kill switch toggles and validates its payload', async () => {
  const routes = fakeHost()
  const on = await (await rpc(routes, 'kill-switch', { on: true })).json() as { result: { ok: boolean; value: { killSwitch: boolean } } }
  assert.equal(on.result.value.killSwitch, true)
  const bad = await (await rpc(routes, 'kill-switch', { on: 'yes' })).json() as { result: { ok: boolean; error: { code: string } } }
  assert.deepEqual([bad.result.ok, bad.result.error.code], [false, 'remora/invalid-payload'])
})

test('requests with the wrong media type or method name are refused', async () => {
  const routes = fakeHost()
  assert.equal((await rpc(routes, 'state', {}, { contentType: 'text/plain' })).status, 415)
  assert.equal((await rpc(routes, 'state', {}, { envelopeMethod: 'remora/kill-switch' })).status, 400)
})
