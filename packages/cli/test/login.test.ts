import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { main } from '../src/main.ts'
import { openTokenStore } from '../src/tokens.ts'
import { openHub } from '../src/hub.ts'
import { EXIT } from '../src/errors.ts'
import { FakeHub, fakeBrowser, seedLogin, testCtx } from './helpers.ts'

test('PKCE login through a simulated browser, then logout revokes', async () => {
  const hub = await new FakeHub(18100).start()
  try {
    const t = await testCtx({ openBrowser: fakeBrowser })
    assert.equal(await main(['login', hub.url], t.ctx), 0, t.stderr())
    const auth = hub.authorizeRequests[0]
    assert.ok(auth)
    assert.equal(auth.get('code_challenge_method'), 'S256')
    assert.equal(auth.get('scope'), 'dsh.read dsh.tasks offline_access', 'dsh.content is opt-in')
    assert.match(auth.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    assert.deepEqual(auth.getAll('resource'), [`${hub.url}/api/v1/ops`, `${hub.url}/mcp`], 'contract resource indicators are the fallback')
    assert.match(t.stderr(), /oauth\/authorize/, 'the URL is always printed')
    assert.match(t.stdout(), /ログインしました/)
    assert.ok(!t.stdout().includes('at-'), 'tokens are never printed')

    const store = await openTokenStore(t.ctx)
    const tokens = await store.load(hub.url)
    assert.ok(tokens?.refreshToken)
    const file = (store as unknown as { file: { path(a: string): string } }).file.path(hub.url)
    assert.equal((await stat(file)).mode & 0o777, 0o600)

    hub.ops['hosts.list'] = () => ({ hosts: [] })
    const h = await testCtx({ env: t.ctx.env })
    assert.equal(await main(['hosts'], h.ctx), 0, h.stderr())
    assert.equal(hub.calls[0]?.auth, tokens.access.api?.token)

    const out = await testCtx({ env: t.ctx.env })
    assert.equal(await main(['logout'], out.ctx), 0)
    assert.ok(hub.revoked.includes(tokens.refreshToken))
    assert.equal(await (await openTokenStore(t.ctx)).load(hub.url), null)
  } finally {
    await hub.stop()
  }
})

test('resource indicators from RFC 9728 metadata win over the contract defaults', async () => {
  const resources = { api: 'https://aud.example/api', mcp: 'https://aud.example/mcp' }
  const hub = await new FakeHub(18101, { resources }).start()
  try {
    const t = await testCtx({ openBrowser: fakeBrowser })
    assert.equal(await main(['login', hub.url, '--scope', 'dsh.read  offline_access'], t.ctx), 0, t.stderr())
    const auth = hub.authorizeRequests[0]!
    assert.deepEqual(auth.getAll('resource'), [resources.api, resources.mcp])
    assert.equal(auth.get('scope'), 'dsh.read offline_access')
    const exchange = hub.tokenRequests.find(r => r.grant_type === 'authorization_code')
    assert.equal(exchange?.resource, resources.api)

    const remora = await openHub(t.ctx, undefined)
    const mcpToken = await remora.token('mcp')
    const refreshReq = hub.tokenRequests.find(r => r.grant_type === 'refresh_token')
    assert.equal(refreshReq?.resource, resources.mcp, 'the MCP token is minted for the MCP resource')
    assert.notEqual(mcpToken, await remora.token('api'))
  } finally {
    await hub.stop()
  }
})

test('a callback with the wrong state is ignored; a timeout ends the login', async () => {
  const hub = await new FakeHub(18102).start()
  try {
    let status = 0
    const t = await testCtx({
      openBrowser: async url => {
        const redirect = new URL(url).searchParams.get('redirect_uri')!
        status = (await fetch(`${redirect}?code=evil&state=wrong`)).status
        return true
      },
    })
    assert.equal(await main(['login', hub.url, '--timeout', '300ms'], t.ctx), EXIT.timeout)
    assert.equal(status, 400)
    assert.equal(hub.tokenRequests.length, 0, 'the forged code was never exchanged')
  } finally {
    await hub.stop()
  }
})

test('issuer mismatch in metadata aborts the login', async () => {
  const hub = await new FakeHub(18103, { issuerOverride: 'https://evil.example' }).start()
  try {
    const t = await testCtx({ openBrowser: fakeBrowser })
    assert.equal(await main(['login', hub.url], t.ctx), EXIT.failure)
    assert.match(t.stderr(), /issuer/)
    assert.equal(hub.authorizeRequests.length, 0)
  } finally {
    await hub.stop()
  }
})

test('device flow handles authorization_pending and slow_down', async () => {
  const hub = await new FakeHub(18104, { devicePolls: ['authorization_pending', 'slow_down', 'authorization_pending', 'ok'] }).start()
  try {
    const t = await testCtx()
    assert.equal(await main(['login', hub.url, '--device'], t.ctx), 0, t.stderr())
    assert.match(t.stderr(), /ABCD-EFGH/)
    assert.match(t.stderr(), /\/device/)
    assert.deepEqual(t.slept, [1000, 1000, 6000, 6000], 'interval grows by 5 s after slow_down')
    const polls = hub.tokenRequests.filter(r => r.grant_type === 'urn:ietf:params:oauth:grant-type:device_code')
    assert.equal(polls.length, 4)
    assert.equal(polls[0]?.device_code, 'dc-1')
    assert.ok(await (await openTokenStore(t.ctx)).load(hub.url))
  } finally {
    await hub.stop()
  }
})

test('device flow: access_denied', async () => {
  const hub = await new FakeHub(18105, { devicePolls: ['access_denied'] }).start()
  try {
    const t = await testCtx()
    assert.equal(await main(['login', hub.url, '--device', '--json'], t.ctx), EXIT.auth)
    assert.equal(JSON.parse(t.stdout()).error.code, 'access_denied')
  } finally {
    await hub.stop()
  }
})

test('expired access tokens refresh automatically, and a 401 triggers one refresh', async () => {
  const hub = await new FakeHub(18106).start()
  try {
    const t = await testCtx()
    await seedLogin(t, hub, { expiresIn: 30 })
    hub.ops['hosts.list'] = () => ({ hosts: [] })
    assert.equal(await main(['hosts'], t.ctx), 0, t.stderr())
    assert.equal(hub.tokenRequests.filter(r => r.grant_type === 'refresh_token').length, 1, 'refreshed because it expires within a minute')
    const stored = await (await openTokenStore(t.ctx)).load(hub.url)
    assert.equal(stored?.refreshToken, 'rt-2', 'rotated refresh token is saved')

    hub.validAccess.clear()
    assert.equal(await main(['hosts'], t.ctx), 0, t.stderr())
    assert.equal(hub.tokenRequests.filter(r => r.grant_type === 'refresh_token').length, 2)

    hub.validAccess.clear()
    hub.validRefresh.clear()
    const e = await testCtx({ env: t.ctx.env })
    assert.equal(await main(['hosts'], e.ctx), EXIT.auth)
    assert.match(e.stderr(), /remora login/)
  } finally {
    await hub.stop()
  }
})

test('a second process that rotated the refresh token does not log the first one out', async () => {
  const hub = await new FakeHub(18113).start()
  try {
    const t = await testCtx()
    await seedLogin(t, hub)
    const first = await openHub(t.ctx, undefined)
    const second = await openHub(t.ctx, undefined)
    const rotated = await second.token('api', true)
    assert.equal(await first.token('api', true), rotated, 'reuses the token the other process just obtained')
    hub.validAccess.clear()
    const again = await first.token('api', true)
    assert.ok(hub.validAccess.has(again), 'refreshes with the rotated refresh token')
  } finally {
    await hub.stop()
  }
})

test('--content adds dsh.content; logout falls back to ENDPOINTS.revocation', async () => {
  const hub = await new FakeHub(18114, { noRevocationMeta: true }).start()
  try {
    const t = await testCtx({ openBrowser: fakeBrowser })
    assert.equal(await main(['login', hub.url, '--content'], t.ctx), 0, t.stderr())
    assert.equal(hub.authorizeRequests[0]?.get('scope'), 'dsh.read dsh.tasks offline_access dsh.content')
    const stored = await (await openTokenStore(t.ctx)).load(hub.url)
    assert.equal(stored?.revocationEndpoint, `${hub.url}/oauth/revoke`)
    assert.equal(await main(['logout'], t.ctx), 0)
    assert.ok(hub.revoked.includes(stored!.refreshToken!))
  } finally {
    await hub.stop()
  }
})
