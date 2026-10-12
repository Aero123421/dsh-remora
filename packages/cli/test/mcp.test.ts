import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../src/main.ts'
import { FakeHub, seedLogin, testCtx } from './helpers.ts'

const lines = (...messages: unknown[]) => messages.map(m => (typeof m === 'string' ? m : JSON.stringify(m))).join('\n') + '\n'

for (const [mode, port] of [['json', 18108], ['sse', 18109]] as const) {
  test(`mcp bridge forwards stdio JSON-RPC to the hub (${mode} replies)`, async () => {
    const hub = await new FakeHub(port, { mcpMode: mode }).start()
    try {
      const t = await testCtx({
        stdinText: lines(
          { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
          'not json',
          { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dsh_status', arguments: {} } },
        ),
      })
      await seedLogin(t, hub)
      hub.validAccess.clear() // force the 401 → refresh → retry path on the first message
      assert.equal(await main(['mcp'], t.ctx), 0, t.stderr())
      const replies = t.out.map(line => JSON.parse(line) as { id?: number | null; result?: { tools?: unknown[]; protocolVersion?: string }; error?: { code: number }; method?: string })
      const byId = (id: number) => replies.find(r => r.id === id)
      assert.equal(byId(1)?.result?.protocolVersion, '2025-06-18')
      assert.equal(byId(2)?.result?.tools?.length, 1)
      assert.ok(byId(3)?.result)
      assert.ok(replies.some(r => r.id === null && r.error?.code === -32700), 'parse error for the bad line')
      if (mode === 'sse') assert.ok(replies.some(r => r.method === 'notifications/progress'), 'server notifications in the stream are passed through')
      const later = hub.mcpCalls.filter(c => (c.body as { method?: string }).method === 'tools/list')
      assert.equal(later[0]?.headers['mcp-protocol-version'], '2025-06-18')
      assert.match(String(later[0]?.headers.accept), /text\/event-stream/)
      assert.ok(String(hub.mcpCalls.at(-1)?.headers.authorization).startsWith('Bearer at-'))
      assert.equal(hub.tokenRequests.filter(r => r.grant_type === 'refresh_token').length, 1)
      assert.ok(t.out.every(line => !line.includes('rt-')), 'stdout has JSON-RPC only')
    } finally {
      await hub.stop()
    }
  })
}

test('mcp bridge answers requests with JSON-RPC errors when the hub is unreachable', async () => {
  const t = await testCtx({ stdinText: lines({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' }) })
  const hub = await new FakeHub(18110).start()
  await seedLogin(t, hub)
  await hub.stop()
  assert.equal(await main(['mcp'], t.ctx), 0)
  assert.equal(t.out.length, 1)
  const reply = JSON.parse(t.out[0]!)
  assert.equal(reply.id, 7)
  assert.match(reply.error.message, /接続できません/)
})

test('mcp probe lists tools across pages', async () => {
  const hub = await new FakeHub(18111, { mcpMode: 'sse' }).start()
  try {
    const t = await testCtx()
    await seedLogin(t, hub)
    assert.equal(await main(['mcp', 'probe'], t.ctx), 0, t.stderr())
    assert.match(t.stdout(), /remora-hub/)
    assert.match(t.stdout(), /dsh_status\s+読み取り/)
    assert.match(t.stdout(), /dsh_task_start\s+書き込み/)
    const j = await testCtx({ env: t.ctx.env })
    assert.equal(await main(['mcp', 'probe', '--json'], j.ctx), 0)
    assert.equal(JSON.parse(j.stdout()).tools.length, 2)
  } finally {
    await hub.stop()
  }
})
