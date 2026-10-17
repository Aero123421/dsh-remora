import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { main } from '../src/main.ts'
import { Hub } from '../src/hub.ts'
import { MCP_REQUEST_TIMEOUT_MS, McpForwarder, probe, runMcpBridge } from '../src/mcp.ts'
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

test('mcp probe uses 2026-07-28 first and lists tools across pages', async () => {
  const hub = await new FakeHub(18111, { mcpMode: 'sse' }).start()
  try {
    const t = await testCtx()
    await seedLogin(t, hub)
    assert.equal(await main(['mcp', 'probe'], t.ctx), 0, t.stderr())
    assert.match(t.stdout(), /remora-hub 0\.0\.2（プロトコル 2026-07-28）/)
    assert.ok(!hub.mcpCalls.some(c => (c.body as { method?: string }).method === 'initialize'), 'no handshake in the modern era')
    const list = hub.mcpCalls.find(c => (c.body as { method?: string }).method === 'tools/list')
    assert.equal(list?.headers['mcp-method'], 'tools/list')
    assert.equal(list?.headers['mcp-protocol-version'], '2026-07-28')
    assert.match(t.stdout(), /dsh_status\s+読み取り/)
    assert.match(t.stdout(), /dsh_task_start\s+書き込み/)
    const j = await testCtx({ env: t.ctx.env })
    assert.equal(await main(['mcp', 'probe', '--json'], j.ctx), 0)
    assert.equal(JSON.parse(j.stdout()).tools.length, 2)
  } finally {
    await hub.stop()
  }
})

test('mcp probe falls back to 2025-06-18 when the hub refuses 2026-07-28', async () => {
  const hub = await new FakeHub(18115, { legacyOnly: true }).start()
  try {
    const t = await testCtx()
    await seedLogin(t, hub)
    assert.equal(await main(['mcp', 'probe', '--json'], t.ctx), 0, t.stderr())
    const result = JSON.parse(t.stdout())
    assert.equal(result.protocolVersion, '2025-06-18')
    assert.equal(result.tools.length, 2)
  } finally {
    await hub.stop()
  }
})

test('mcp bridge adds the 2026-07-28 headers and passes JSON-RPC errors through', async () => {
  const hub = await new FakeHub(18116).start()
  try {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }
    const t = await testCtx({
      stdinText: lines(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dsh_status', arguments: {}, _meta: meta } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } },
      ),
    })
    await seedLogin(t, hub)
    assert.equal(await main(['mcp'], t.ctx), 0, t.stderr())
    const replies = t.out.map(line => JSON.parse(line))
    assert.ok(replies.find(r => r.id === 1)?.result, 'Mcp-Name / Mcp-Method / MCP-Protocol-Version were derived from the body')
    assert.equal(replies.find(r => r.id === 2)?.error?.code, -32022, "the hub's own JSON-RPC error reaches the client")
    assert.equal(hub.mcpCalls[0]?.headers['mcp-name'], 'dsh_status')
  } finally {
    await hub.stop()
  }
})

function resetResponse(type: string, firstChunk: string): Response {
  let first = true
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (first) { first = false; controller.enqueue(new TextEncoder().encode(firstChunk)) }
      else controller.error(new Error('connection reset with private fixture detail'))
    },
  }, { highWaterMark: 0 })
  return new Response(body, { headers: { 'content-type': type } })
}

test('MCP JSON body reset replies to the request and a later request still works after failed initialize', async t => {
  let calls = 0
  const fixture = await testCtx({
    stdinText: lines({ jsonrpc: '2.0', id: 1, method: 'initialize' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    fetch: async () => ++calls === 1
      ? resetResponse('application/json', '{"jsonrpc":"2.0",')
      : Response.json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }),
  })
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  const hub = new Hub(fixture.ctx, 'https://hub.example.com', null, null, 'fixture-access')
  assert.equal(await runMcpBridge(fixture.ctx, hub), 0)
  const replies = fixture.out.map(line => JSON.parse(line))
  assert.equal(replies.length, 2)
  assert.equal(replies.find(reply => reply.id === 1)?.error?.code, -32000)
  assert.deepEqual(replies.find(reply => reply.id === 2)?.result, { tools: [] })
  assert.ok(!fixture.stdout().includes('private fixture detail'), 'transport errors do not expose raw body failures')
})

test('MCP SSE reset replies only to unanswered batch IDs and preserves notifications', async t => {
  const fixture = await testCtx({
    fetch: async () => resetResponse('text/event-stream', [
      'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n',
    ].join('')),
  })
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  const hub = new Hub(fixture.ctx, 'https://hub.example.com', null, null, 'fixture-access')
  const replies: unknown[] = []
  await new McpForwarder(hub).send([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 'pending', method: 'tools/call' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ], reply => { replies.push(reply) })
  assert.deepEqual(replies, [
    { jsonrpc: '2.0', id: 1, result: { ok: true } },
    { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } },
    { jsonrpc: '2.0', id: 'pending', error: { code: -32000, message: 'Remora: ハブとの接続が応答の途中で切れました' } },
  ])
})

test('MCP notification-only request gets no response on body reset', async t => {
  const fixture = await testCtx({ fetch: async () => resetResponse('application/json', '{') })
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  const replies: unknown[] = []
  await new McpForwarder(new Hub(fixture.ctx, 'https://hub.example.com', null, null, 'fixture-access'))
    .send({ jsonrpc: '2.0', method: 'notifications/initialized' }, reply => { replies.push(reply) })
  assert.deepEqual(replies, [])
})

for (const [name, scope, flag] of [['dsh_session_read', 'dsh.content', '--content'], ['dsh_terminal_run', 'dsh.admin', '--admin']] as const) {
  test(`MCP stdio preserves OAuth scope step-up for ${name}`, async t => {
    const challenge = `Bearer error="insufficient_scope", scope="dsh.read dsh.tasks ${scope}"`
    const description = `${name} needs the ${scope} scope`
    const fixture = await testCtx({ fetch: async () => Response.json({ error: 'insufficient_scope', error_description: description }, { status: 403, headers: { 'www-authenticate': challenge } }) })
    t.after(() => rm(fixture.dir, { recursive: true, force: true }))
    const replies: any[] = []
    await new McpForwarder(new Hub(fixture.ctx, 'https://hub.example.com', null, null, 'fixture-access'))
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }, reply => replies.push(reply))
    assert.equal(replies.length, 1)
    assert.ok(replies[0].error.message.includes(description))
    assert.ok(replies[0].error.message.includes(`remora login ${flag}`))
    assert.deepEqual(replies[0].error.data, { status: 403, error: 'insufficient_scope', wwwAuthenticate: challenge, error_description: description })
  })
}

function hangUntilAborted(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('MCP times out a stalled fetch once without replaying a mutation', async t => {
  let calls = 0
  let requestSignal: AbortSignal | null = null
  const fixture = await testCtx({ fetch: async (_url, init) => {
    calls++
    requestSignal = init!.signal!
    return hangUntilAborted(requestSignal)
  } })
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  const replies: any[] = []
  await new McpForwarder(new Hub(fixture.ctx, 'https://hub.example.com', null, null, 'fixture-access'))
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dsh_command_run', arguments: { command: '/compact' } } }, reply => replies.push(reply), { timeoutMs: 15 })
  assert.equal(calls, 1)
  assert.equal((requestSignal as AbortSignal | null)?.aborted, true)
  assert.equal(replies.length, 1)
  assert.match(replies[0].error.message, /タイムアウト/)
  assert.match(replies[0].error.message, /実行済みの可能性/)
  assert.ok(MCP_REQUEST_TIMEOUT_MS > 25_000, 'a valid maximum long poll fits within the default deadline')
})

for (const contentType of ['application/json', 'text/event-stream']) {
  test(`MCP timeout also covers a stalled ${contentType} response body`, async t => {
    const fixture = await testCtx({ fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener('abort', () => controller.error(init!.signal!.reason), { once: true }) },
    }), { headers: { 'content-type': contentType } }) })
    t.after(() => rm(fixture.dir, { recursive: true, force: true }))
    const replies: any[] = []
    await new McpForwarder(new Hub(fixture.ctx, 'https://hub.example.com', null, null, 'fixture-access'))
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, reply => replies.push(reply), { timeoutMs: 15 })
    assert.equal(replies.length, 1)
    assert.match(replies[0].error.message, /タイムアウト/)
  })
}

test('MCP cancellation stops waiting without replaying or cancelling a DSH task', async t => {
  const calls: string[] = []
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const fixture = await testCtx({ fetch: async (_url, init) => {
    const message = JSON.parse(init!.body as string)
    calls.push(message.method)
    if (message.method === 'notifications/cancelled') return new Response(null, { status: 202 })
    ready()
    return hangUntilAborted(init!.signal!)
  } })
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  const replies: any[] = []
  const forwarder = new McpForwarder(new Hub(fixture.ctx, 'https://hub.example.com', null, null, 'fixture-access'))
  const pending = forwarder.send({ jsonrpc: '2.0', id: 'request', method: 'tools/call', params: { name: 'dsh_task_start' } }, reply => replies.push(reply))
  await started
  await forwarder.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'request' } }, reply => replies.push(reply))
  await pending
  assert.deepEqual(calls, ['tools/call', 'notifications/cancelled'])
  assert.equal(replies.length, 1)
  assert.equal(replies[0].id, 'request')
  assert.match(replies[0].error.message, /待機を取り消し/)
})

test('MCP probe deadline ends a stalled discovery without a fallback request', async t => {
  let calls = 0
  const fixture = await testCtx({ fetch: async (_url, init) => { calls++; return hangUntilAborted(init!.signal!) } })
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  await assert.rejects(probe(new Hub(fixture.ctx, 'https://hub.example.com', null, null, 'fixture-access'), { timeoutMs: 15 }), /タイムアウト/)
  assert.equal(calls, 1)
})


test('MCP deadline stops waiting for token ownership and never sends the mutation later', async t => {
  let finishToken!: (token: string) => void
  const blockedToken = new Promise<string>(resolve => { finishToken = resolve })
  let calls = 0
  const fixture = await testCtx({ fetch: async () => { calls++; return Response.json({}) } })
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  const hub = new Hub(fixture.ctx, 'https://hub.example.com', null, null)
  // Model a different process holding the token lock (or the refresh persistence).
  hub.token = () => blockedToken
  const replies: any[] = []
  await new McpForwarder(hub).send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dsh_command_run' } }, reply => replies.push(reply), { timeoutMs: 15 })
  assert.equal(replies.length, 1)
  assert.match(replies[0].error.message, /タイムアウト/)
  assert.equal(calls, 0)
  finishToken('rotated-token')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 0, 'completing shared refresh does not launch the timed out operation')
})

test('MCP probe deadline leaves a blocked refresh free to finish or reject safely', async t => {
  let rejectToken!: (error: Error) => void
  const blockedToken = new Promise<string>((_resolve, reject) => { rejectToken = reject })
  const fixture = await testCtx({ fetch: async () => { throw new Error('must not fetch an operation') } })
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  const hub = new Hub(fixture.ctx, 'https://hub.example.com', null, null)
  hub.token = () => blockedToken
  await assert.rejects(probe(hub, { timeoutMs: 15 }), /タイムアウト/)
  rejectToken(new Error('refresh failed after the caller stopped waiting'))
  await new Promise(resolve => setImmediate(resolve))
})
