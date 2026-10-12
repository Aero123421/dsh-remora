import { fork, spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { test } from 'node:test'
import { openHub } from '../src/hub.ts'
import { openTokenStore } from '../src/tokens.ts'
import { withTokenLock } from '../src/token-lock.ts'
import { FakeHub, seedLogin, testCtx } from './helpers.ts'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function childRefresh(url: string, dir: string) {
  const child = fork(new URL('./fixtures/token-child.ts', import.meta.url), [url, dir], {
    execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const ready = deferred<void>()
  const started = deferred<void>()
  const result = deferred<string>()
  const exited = deferred<void>()
  let received = false
  const fail = () => { const error = new Error('token refresh child failed'); ready.reject(error); started.reject(error); result.reject(error) }
  child.on('error', () => { fail(); exited.resolve() })
  child.stderr?.resume()
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return
    if (message.type === 'ready') ready.resolve()
    else if (message.type === 'started') started.resolve()
    else if (message.type === 'result' && 'hash' in message && typeof message.hash === 'string') { received = true; result.resolve(message.hash) }
    else if (message.type === 'failed') fail()
  })
  child.on('exit', (status, signal) => { if (status !== 0 || signal !== null || !received) fail(); exited.resolve() })
  // Rejecting a later phase before the caller awaits it must not become an unhandled rejection.
  void ready.promise.catch(() => {})
  void started.promise.catch(() => {})
  void result.promise.catch(() => {})
  return { child, ready: ready.promise, started: started.promise, result: result.promise, exited: exited.promise }
}

async function stopChild(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill()
  await exited
}

test('parallel token requests share one rotated token and preserve both audiences', async t => {
  const server = await new FakeHub().start()
  const fixture = await testCtx()
  t.after(async () => { await server.stop(); await rm(fixture.dir, { recursive: true, force: true }) })
  await seedLogin(fixture, server, { expiresIn: 0 })
  const hub = await openHub(fixture.ctx, undefined)
  const returned = await Promise.all(Array.from({ length: 8 }, () => hub.token('api')))
  assert.equal(new Set(returned).size, 1)
  assert.equal(server.tokenRequests.filter(request => request.grant_type === 'refresh_token').length, 1)

  const store = await openTokenStore(fixture.ctx)
  const tokens = await store.load(server.url)
  assert.ok(tokens)
  tokens.resources = { api: `${server.url}/api/v1/ops`, mcp: `${server.url}/mcp` }
  tokens.access = {}
  await store.save(tokens)
  const first = await openHub(fixture.ctx, undefined)
  const second = await openHub(fixture.ctx, undefined)
  const [api, mcp] = await Promise.all([first.token('api'), second.token('mcp')])
  const stored = await store.load(server.url)
  assert.equal(stored?.access.api?.token, api)
  assert.equal(stored?.access.mcp?.token, mcp)
  assert.equal(server.tokenRequests.filter(request => request.grant_type === 'refresh_token').length, 3)
  assert.deepEqual(new Set(server.tokenRequests.slice(1).map(request => request.resource)), new Set(Object.values(tokens.resources)))
})

test('two CLI processes serialize rotation and keep the stored successor usable', { timeout: 30_000 }, async t => {
  const server = await new FakeHub().start()
  const fixture = await testCtx()
  const children: ReturnType<typeof childRefresh>[] = []
  t.after(async () => {
    await Promise.all(children.map(child => stopChild(child.child, child.exited)))
    await server.stop()
    await rm(fixture.dir, { recursive: true, force: true })
  })
  await seedLogin(fixture, server, { expiresIn: 0 })
  const original = await (await openTokenStore(fixture.ctx)).load(server.url)
  assert.ok(original)
  children.push(childRefresh(server.url, fixture.dir), childRefresh(server.url, fixture.dir))
  await Promise.all(children.map(child => child.ready))
  // Both have loaded the same expired token before either starts refreshing.
  for (const child of children) child.child.send({ type: 'go' })
  await Promise.all(children.map(child => child.started))
  const hashes = await Promise.all(children.map(child => child.result))
  await Promise.all(children.map(child => child.exited))
  assert.equal(new Set(hashes).size, 1)
  assert.equal(server.tokenRequests.filter(request => request.grant_type === 'refresh_token').length, 1)
  const stored = await (await openTokenStore(fixture.ctx)).load(server.url)
  assert.ok(stored)
  assert.notEqual(stored.refreshToken, original.refreshToken)
  assert.equal(hashes[0], createHash('sha256').update(stored.access.default!.token).digest('hex'))
  assert.ok(server.validAccess.has(await (await openHub(fixture.ctx, undefined)).token('api', true)))
})

test('a late 401 reuses the replacement for the token that request actually sent', async t => {
  const server = await new FakeHub().start()
  const fixture = await testCtx()
  t.after(async () => { await server.stop(); await rm(fixture.dir, { recursive: true, force: true }) })
  await seedLogin(fixture, server)
  const initial = await (await openTokenStore(fixture.ctx)).load(server.url)
  assert.ok(initial)
  const oldAuthorization = `Bearer ${initial.access.default!.token}`
  const bothSent = deferred<void>()
  const refreshed = deferred<void>()
  let requests = 0
  const realFetch = fixture.ctx.fetch
  fixture.ctx.fetch = async (url, init) => {
    if (String(url).endsWith('/oauth/token')) {
      const response = await realFetch(url, init)
      refreshed.resolve()
      return response
    }
    const authorization = new Headers(init?.headers).get('authorization')
    if (authorization !== oldAuthorization) return Response.json({ ok: true })
    const order = ++requests
    if (order === 2) bothSent.resolve()
    await bothSent.promise
    if (order === 2) await refreshed.promise
    return new Response(null, { status: 401 })
  }
  const hub = await openHub(fixture.ctx, undefined)
  const replies = await Promise.all([hub.authorizedFetch('api', `${server.url}/resource`, {}), hub.authorizedFetch('api', `${server.url}/resource`, {})])
  assert.ok(replies.every(response => response.ok))
  assert.equal(server.tokenRequests.filter(request => request.grant_type === 'refresh_token').length, 1)
})

test('logout while a stale hub waits for the lock cannot restore its credentials', async t => {
  const server = await new FakeHub().start()
  const fixture = await testCtx()
  t.after(async () => { await server.stop(); await rm(fixture.dir, { recursive: true, force: true }) })
  await seedLogin(fixture, server, { expiresIn: 0 })
  const hub = await openHub(fixture.ctx, undefined)
  const store = await openTokenStore(fixture.ctx)
  const pending = await withTokenLock(fixture.ctx, server.url, async () => {
    const request = hub.token('api')
    void request.catch(() => {})
    await store.clear(server.url)
    return { request }
  })
  await assert.rejects(pending.request)
  assert.equal(await store.load(server.url), null)
  assert.equal(server.tokenRequests.length, 0)
})

test('a dead process lock is recovered before reading tokens', { timeout: 30_000 }, async t => {
  const fixture = await testCtx()
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  const url = 'https://hub.example.com'
  const id = createHash('sha256').update(url).digest('hex').slice(0, 16)
  const path = join(fixture.dir, `tokens-${id}.lock`)
  // Use a terminated child PID rather than assuming a literal PID is unused.
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (status, signal) => {
      if (status !== 0 || signal !== null) reject(new Error('fixture child did not exit normally'))
      else resolve()
    })
  })
  t.after(() => stopChild(child, exited))
  await exited
  assert.ok(child.pid)
  await mkdir(path)
  await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: child.pid, host: hostname(), token: randomUUID() }))
  assert.equal(await withTokenLock(fixture.ctx, url, async () => 'acquired'), 'acquired')
})
