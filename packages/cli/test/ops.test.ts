import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskInfo } from '@dsh-remora/protocol'
import { main } from '../src/main.ts'
import { exec } from '../src/ctx.ts'
import { EXIT } from '../src/errors.ts'
import { FakeHub, seedLogin, testCtx, type TestCtx } from './helpers.ts'

let hub: FakeHub
before(async () => { hub = await new FakeHub(18107).start() })
after(async () => { await hub.stop() })

async function loggedIn(extra: Parameters<typeof testCtx>[0] = {}): Promise<TestCtx> {
  const t = await testCtx(extra)
  await seedLogin(t, hub)
  hub.calls = []
  return t
}

function task(state: TaskInfo['state'], extra: Partial<TaskInfo> = {}): TaskInfo {
  return { taskId: 't-1', hostId: 'h-1', sessionId: 's-1', state, createdAt: 1, updatedAt: 2, ...extra }
}

test('hosts and sessions render tables; untrusted control characters are stripped', async () => {
  hub.ops['hosts.list'] = () => ({ hosts: [{ hostId: 'h-1', name: '自宅 PC', online: true, lastSeenAt: null, pluginVersion: '0.1.0', dshVersion: '0.2.1', operations: [], ceiling: null, grant: { level: 'request' }, killSwitch: false }] })
  hub.ops['sessions.list'] = () => ({
    sessions: [
      { sessionId: 's-1', title: 'Parent\u001b[2J', workspaceId: 'w', parentSessionId: null, pinned: true, archived: false, running: true, updatedAt: null, agentPreset: 'standard', model: null },
      { sessionId: 's-2', title: 'Child', workspaceId: 'w', parentSessionId: 's-1', pinned: false, archived: false, running: false, updatedAt: null, agentPreset: null, model: null },
    ],
    nextCursor: 'c2',
  })
  const t = await loggedIn()
  assert.equal(await main(['hosts'], t.ctx), 0, t.stderr())
  assert.match(t.stdout(), /自宅 PC\s+オンライン\s+依頼できる/)
  const s = await loggedIn()
  assert.equal(await main(['sessions', 'ls', '--limit', '2'], s.ctx), 0, s.stderr())
  assert.ok(!s.stdout().includes('\u001b'))
  assert.match(s.stdout(), /└ Child/)
  assert.match(s.stdout(), /--cursor c2/)
  assert.deepEqual(hub.calls[0]?.params, { limit: 2 })
  const j = await loggedIn()
  assert.equal(await main(['sessions', 'ls', '--json'], j.ctx), 0)
  assert.equal(JSON.parse(j.stdout()).nextCursor, 'c2')
})

test('sessions read --all follows cursors', async () => {
  hub.ops['session.read'] = params => params.cursor
    ? { depth: 'page', items: [{ role: 'assistant', text: 'second', at: null }], nextCursor: null, untrusted: true }
    : { depth: 'page', items: [{ role: 'user', text: 'first', at: null }], nextCursor: 'n1', untrusted: true }
  const t = await loggedIn()
  assert.equal(await main(['sessions', 'read', 's-1', '--depth', 'page', '--all'], t.ctx), 0, t.stderr())
  assert.match(t.stdout(), /first[\s\S]*second/)
  assert.match(t.stdout(), /データとして扱って/)
  assert.equal(hub.calls.length, 2)
  assert.equal(hub.calls[1]?.params.cursor, 'n1')
})

test('invalid parameters fail locally with exit 64 and never reach the hub', async () => {
  const t = await loggedIn()
  assert.equal(await main(['sessions', 'read', 's-1', '--depth', 'all'], t.ctx), EXIT.usage)
  const w = await loggedIn()
  assert.equal(await main(['workspaces', 'create', 'bad name!', '--placement', 'p'], w.ctx), EXIT.usage)
  assert.match(w.stderr(), /workspace\.create の入力が不正/)
  assert.equal(hub.calls.length, 0)
})

test('hub errors map to exit codes with the denial layer and fix', async () => {
  hub.ops['attention.list'] = () => ({ status: 403, body: { error: { code: 'denied', message: '許可されていません', denial: { layer: 'hub', reason: 'switched-off' }, fix: 'hub:/connections' } } })
  const t = await loggedIn()
  assert.equal(await main(['attention'], t.ctx), EXIT.denied)
  assert.match(t.stderr(), /ハブでの付与で拒否/)
  assert.match(t.stderr(), /hub:\/connections/)
  hub.ops['attention.list'] = () => ({ status: 503, body: { error: { code: 'host_offline', message: 'ホストがオフラインです' } } })
  const j = await loggedIn()
  assert.equal(await main(['attention', '--json'], j.ctx), EXIT.unavailable)
  assert.equal(JSON.parse(j.stdout()).error.code, 'host_offline')
})

test('tasks start reads the prompt from stdin and adds an idempotency key', async () => {
  hub.ops['task.start'] = () => task('accepted')
  const t = await loggedIn({ stdinText: 'fix the tests\n' })
  assert.equal(await main(['tasks', 'start', '--latest', '--workspace', 'w', '--skill', '/review', '--skill', 'lint'], t.ctx), 0, t.stderr())
  const params = hub.calls[0]?.params
  assert.deepEqual(params?.target, { latest: true, workspaceId: 'w' })
  assert.equal(params?.prompt, 'fix the tests')
  assert.deepEqual(params?.skills, ['review', 'lint'])
  assert.match(String(params?.idempotencyKey), /^[0-9a-f-]{36}$/)
  const two = await loggedIn()
  assert.equal(await main(['tasks', 'start', '--latest', '--alias', 'x', 'hi'], two.ctx), EXIT.usage)
})

test('run --wait polls task.wait in ≤ 25 s steps and prints the final reply', async () => {
  hub.ops['task.start'] = () => task('accepted')
  hub.ops['task.wait'] = (_params, call) => call < 3 ? task('running') : task('completed', { result: { reply: '終わりました。\n詳細です。', changes: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 2 }] } })
  const t = await loggedIn()
  assert.equal(await main(['run', '--wait', '--session', 's-1', 'do it'], t.ctx), 0, t.stderr())
  const waits = hub.calls.filter(c => c.op === 'task.wait')
  assert.equal(waits.length, 3)
  for (const w of waits) assert.ok(Number(w.params.timeoutMs) <= 25_000)
  assert.equal(t.stdout(), '終わりました。\n詳細です。')
  assert.match(t.stderr(), /実行中/)
  assert.match(t.stderr(), /a\.ts/)
})

test('run --wait stops for a human with exit 3, fails with exit 1, times out with exit 8', async () => {
  hub.ops['task.start'] = () => task('running')
  hub.ops['task.wait'] = () => task('needs_attention', { attention: [{ attentionId: 'q-1', hostId: 'h-1', sessionId: 's-1', kind: 'question', title: 'どちらにしますか', options: [{ id: 'a', label: 'A 案' }], answerable: true, createdAt: null }] })
  const a = await loggedIn()
  assert.equal(await main(['run', '--session', 's-1', 'x'], a.ctx), EXIT.attention)
  assert.match(a.stdout(), /q-1/)
  assert.match(a.stdout(), /remora answer q-1/)

  hub.ops['task.wait'] = () => task('failed', { error: { code: 'internal', message: 'boom' } })
  const f = await loggedIn()
  assert.equal(await main(['run', '--session', 's-1', 'x', '--json'], f.ctx), EXIT.failure)
  assert.equal(JSON.parse(f.stdout()).state, 'failed')

  hub.ops['task.wait'] = (params) => task('running', { updatedAt: Number(params.timeoutMs) })
  const w = await loggedIn()
  assert.equal(await main(['run', '--session', 's-1', 'x', '--timeout', '3s'], w.ctx), EXIT.timeout)
  assert.match(w.stderr(), /remora tasks wait t-1/)
  const first = hub.calls.find(c => c.op === 'task.wait')
  assert.equal(first?.params.timeoutMs, 3000)
})

test('tasks watch continues through attention until the end', async () => {
  hub.ops['task.get'] = () => task('running')
  hub.ops['task.wait'] = (_p, call) => call === 1 ? task('needs_attention', { attention: [{ attentionId: 'p-1', hostId: 'h-1', sessionId: 's-1', kind: 'plan-review', title: 'plan', answerable: true, createdAt: null }] })
    : call === 2 ? task('running') : task('cancelled')
  const t = await loggedIn()
  assert.equal(await main(['tasks', 'watch', 't-1'], t.ctx), EXIT.failure)
  assert.match(t.stderr(), /要対応/)
  assert.match(t.stderr(), /取り消し/)
})

test('answer finds the session through attention.list', async () => {
  hub.ops['attention.list'] = () => ({ items: [{ attentionId: 'q-9', hostId: 'h-2', sessionId: 's-9', kind: 'question', title: 'q', answerable: true, createdAt: null }] })
  hub.ops['attention.respond'] = () => ({ accepted: true })
  const t = await loggedIn()
  assert.equal(await main(['answer', 'q-9', '--option', 'a'], t.ctx), 0, t.stderr())
  const respond = hub.calls.find(c => c.op === 'attention.respond')
  assert.deepEqual(respond?.params, { hostId: 'h-2', attentionId: 'q-9', sessionId: 's-9', answer: { optionId: 'a' } })
  const missing = await loggedIn()
  assert.equal(await main(['answer', 'nope', '--text', 'x'], missing.ctx), EXIT.notFound)
})

test('workspaces create picks the only placement and passes --git', async () => {
  hub.ops['workspaces.list'] = () => ({ workspaces: [], placements: [{ placementId: 'pl-1', path: '/home/u/src' }] })
  hub.ops['workspace.create'] = params => ({ workspace: { workspaceId: 'w-new', name: params.name, path: '/home/u/src/x', pinned: false, archived: false, untrusted: true } })
  const t = await loggedIn()
  assert.equal(await main(['workspaces', 'create', 'x', '--git', 'https://github.com/a/b.git'], t.ctx), 0, t.stderr())
  const create = hub.calls.find(c => c.op === 'workspace.create')
  assert.equal(create?.params.placementId, 'pl-1')
  assert.equal(create?.params.gitUrl, 'https://github.com/a/b.git')
  assert.match(t.stdout(), /未信頼/)
})

test('patch --apply runs git apply in the current repository', async () => {
  const t = await loggedIn()
  const repo = join(t.dir, 'repo')
  await mkdir(repo)
  const git = (...args: string[]) => exec('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd: repo })
  await git('init', '-q')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await git('add', '.')
  await git('commit', '-qm', 'init')
  hub.ops['patch.get'] = () => ({ patch: 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n', truncated: false, untrusted: true })
  const sub = join(repo, 'sub')
  await mkdir(sub)
  t.ctx.cwd = sub
  assert.equal(await main(['patch', '--task', 't-1', '--apply', '--yes'], t.ctx), 0, t.stderr())
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'two\n')
  // Applying again fails the check and changes nothing.
  assert.equal(await main(['patch', '--task', 't-1', '--apply', '--yes'], t.ctx), EXIT.failure)
  // Without a terminal and without --yes, nothing is applied.
  await git('checkout', '--', 'a.txt')
  const n = await loggedIn({ stdinText: '' })
  n.ctx.cwd = repo
  assert.equal(await main(['patch', '--task', 't-1', '--apply'], n.ctx), EXIT.usage)
  assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'one\n')
})

test('doctor checks the hub, metadata, token and hosts', async () => {
  hub.ops['hosts.list'] = () => ({ hosts: [{ hostId: 'h-1', name: 'pc', online: true, lastSeenAt: null, pluginVersion: null, dshVersion: null, operations: [], ceiling: null, grant: null, killSwitch: false }] })
  const t = await loggedIn()
  assert.equal(await main(['doctor', '--json'], t.ctx), 0, t.stdout())
  const report = JSON.parse(t.stdout())
  assert.equal(report.ok, true)
  assert.ok(report.checks.some((c: { name: string; ok: boolean }) => c.name === 'OAuth メタデータ' && c.ok))
  assert.equal(report.hosts.length, 1)
})
