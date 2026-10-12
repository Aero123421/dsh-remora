import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { apply, name, inject } from '../src/index.ts'
import { isLocalRequest } from '../src/routes.ts'
import type { RemoraSnapshot } from '../src/state.ts'
import { fakeHost, manualClock, rawRpc, rpc, tempDir, until } from './helpers.ts'
import type { Clock } from '../src/core/events.ts'

async function plugin(services: Record<string, unknown> = {}, clock?: Clock) {
  const t = await tempDir()
  const host = fakeHost(services)
  const core = apply(host.ctx, undefined, { dataDir: join(t.dir, 'data'), forbiddenRoots: { home: join(t.dir, 'home'), dshHome: join(t.dir, 'home', '.dsh') }, ...(clock ? { clock } : {}) })
  await core.ready
  return {
    ...host, core, dir: t.dir,
    async close() { host.dispose(); await core.dispose(); await t.cleanup() },
  }
}

const remote = { host: 'pc.tailnet.example:5173', origin: 'https://pc.tailnet.example:5173' }

test('plugin identity', () => {
  assert.equal(name, 'dsh-remora')
  assert.deepEqual(inject, ['connection'])
})

test('state starts unpaired, view-only, kill switch off', async () => {
  const p = await plugin({ sessionController: {} })
  try {
    const response = await rawRpc(p.routes, 'state')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const body = await response.json() as { result: { ok: boolean; value: RemoraSnapshot } }
    assert.equal(body.result.ok, true)
    const state = body.result.value
    assert.equal(state.hub.paired, false)
    assert.equal(state.hub.link.state, 'idle')
    assert.deepEqual(state.settings.ceiling, { level: 'view' })
    assert.equal(state.settings.killSwitch, false)
    assert.equal(state.local, true)
    assert.equal(state.keyStorage, 'file')
    assert.ok(state.operations.find(op => op.id === 'sessions.list')?.allowed)
    assert.equal(state.operations.find(op => op.id === 'task.start')?.allowed, false)
  } finally { await p.close() }
})

test('kill switch toggles and validates its payload; turning it off needs this PC', async () => {
  const p = await plugin()
  try {
    const on = await rpc<RemoraSnapshot>(p.routes, 'kill-switch', { on: true }, remote)
    assert.ok(on.ok && on.value.settings.killSwitch && on.value.local === false)
    const bad = await rpc(p.routes, 'kill-switch', { on: 'yes' })
    assert.deepEqual(bad.ok ? null : bad.error.code, 'remora/invalid-payload')
    const off = await rpc(p.routes, 'kill-switch', { on: false }, remote)
    assert.equal(off.ok ? null : off.error.code, 'remora/local-only')
    assert.ok((await rpc(p.routes, 'kill-switch', { on: false })).ok)
  } finally { await p.close() }
})

test('requests with the wrong media type or method name are refused', async () => {
  const p = await plugin()
  try {
    assert.equal((await rawRpc(p.routes, 'state', {}, { contentType: 'text/plain' })).status, 415)
    assert.equal((await rawRpc(p.routes, 'state', {}, { envelopeMethod: 'remora/kill-switch' })).status, 400)
  } finally { await p.close() }
})

test('a request is local only with a loopback Host and Origin and no proxy headers', () => {
  const request = (headers: Record<string, string>) => new Request('http://dsh.internal/api/remora/state', { method: 'POST', headers })
  assert.equal(isLocalRequest(request({ host: '127.0.0.1:5173' })), true)
  assert.equal(isLocalRequest(request({ host: 'localhost:5173', origin: 'http://localhost:5173' })), true)
  assert.equal(isLocalRequest(request({ host: '[::1]:5173' })), true)
  assert.equal(isLocalRequest(request({ host: '192.168.1.10:5173' })), false)
  assert.equal(isLocalRequest(request({ host: '127.0.0.1:5173', origin: 'https://evil.example' })), false)
  assert.equal(isLocalRequest(request({ host: '127.0.0.1:5173', 'x-forwarded-for': '203.0.113.9' })), false)
  assert.equal(isLocalRequest(request({})), false)
})

test('scope settings: widening needs this PC, validation, and placements', async () => {
  const p = await plugin()
  try {
    const widen = await rpc(p.routes, 'settings', { scope: { workspaces: ['w1'], commands: ['compact'] } }, remote)
    assert.equal(widen.ok ? null : widen.error.code, 'remora/local-only')
    const saved = await rpc<RemoraSnapshot>(p.routes, 'settings', { hostName: 'Desk', scope: { workspaces: ['w1'], commands: ['compact'], gitHosts: ['GitHub.com'], aliases: { main: 's1' } } })
    assert.ok(saved.ok)
    assert.equal(saved.value.settings.hostName, 'Desk')
    assert.deepEqual(saved.value.settings.scope.commands, ['/compact'])
    assert.deepEqual(saved.value.settings.scope.gitHosts, ['github.com'])
    const narrowed = await rpc<RemoraSnapshot>(p.routes, 'settings', { scope: { workspaces: [] } }, remote)
    assert.ok(narrowed.ok && narrowed.value.settings.scope.workspaces.length === 0)
    const invalid = await rpc(p.routes, 'settings', { scope: { aliases: { 'bad alias': 's' } } })
    assert.equal(invalid.ok ? null : invalid.error.code, 'remora/invalid-payload')
    const projects = join(p.dir, 'home', 'projects')
    await mkdir(projects, { recursive: true })
    const remoteAdd = await rpc(p.routes, 'placement-add', { path: projects }, remote)
    assert.equal(remoteAdd.ok ? null : remoteAdd.error.code, 'remora/local-only')
    const homeAdd = await rpc(p.routes, 'placement-add', { path: join(p.dir, 'home') })
    assert.equal(homeAdd.ok ? null : homeAdd.error.code, 'remora/placement-forbidden')
    const added = await rpc<RemoraSnapshot>(p.routes, 'placement-add', { path: projects })
    assert.ok(added.ok)
    const placement = added.value.settings.scope.placements[0]
    assert.ok(placement)
    const removed = await rpc<RemoraSnapshot>(p.routes, 'placement-remove', { placementId: placement.placementId }, remote)
    assert.ok(removed.ok && removed.value.settings.scope.placements.length === 0)
  } finally { await p.close() }
})

test('catalogs are read from DSH services when present', async () => {
  const p = await plugin({
    workspaceRegistry: { list: () => [{ id: 'w1', title: 'app', path: '/src/app' }] },
    agentPresets: { list: async () => [{ id: 'standard', name: 'Standard' }] },
    skills: { list: async () => [{ name: 'review', description: 'Review code' }] },
    commands: { list: (agent: unknown) => (agent === undefined ? [{ name: 'compact', description: 'Compact' }] : []) },
  })
  try {
    const catalog = await rpc<{ workspaces: { id: string }[]; agentPresets: { id: string }[]; skills: { id: string }[]; commands: { id: string }[]; unavailable: string[] }>(p.routes, 'catalog')
    assert.ok(catalog.ok)
    assert.deepEqual(catalog.value.workspaces.map(w => w.id), ['w1'])
    assert.deepEqual(catalog.value.agentPresets.map(w => w.id), ['standard'])
    assert.deepEqual(catalog.value.skills.map(w => w.id), ['review'])
    assert.deepEqual(catalog.value.commands.map(w => w.id), ['/compact'])
    assert.deepEqual(catalog.value.unavailable, [])
  } finally { await p.close() }
})

test('full access expires into 依頼できる after 24 hours unless extended', async () => {
  const { clock, advance } = manualClock()
  const p = await plugin({}, clock)
  try {
    const full = await rpc<RemoraSnapshot>(p.routes, 'permission', { level: 'full', confirmFull: true })
    assert.ok(full.ok && full.value.fullAccess.active)
    assert.equal(full.value.fullAccess.expiresAt, clock.now() + 24 * 60 * 60_000)
    advance(12 * 60 * 60_000)
    const extendRemote = await rpc(p.routes, 'full-access-extend', {}, remote)
    assert.equal(extendRemote.ok ? null : extendRemote.error.code, 'remora/local-only')
    assert.ok((await rpc(p.routes, 'full-access-extend', {})).ok)
    advance(23 * 60 * 60_000)
    assert.equal(p.core.internals.settings().ceiling.level, 'full')
    advance(60 * 60_000)
    await until(() => p.core.internals.settings().ceiling.level === 'request', 2000, 'expiry')
    assert.equal(p.core.internals.settings().ceiling.fullAccessExpiresAt, undefined)
  } finally { await p.close() }
})
