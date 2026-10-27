import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { ConfirmationInfo } from '@dsh-remora/protocol'
import { main } from '../src/main.ts'
import { EXIT } from '../src/errors.ts'
import { FakeHub, seedLogin, testCtx, type TestCtx } from './helpers.ts'

let hub: FakeHub
before(async () => { hub = await new FakeHub(18120).start() })
after(async () => { await hub.stop() })

const ADMIN = 'dsh.read dsh.content dsh.tasks dsh.admin offline_access'

async function loggedIn(extra: Parameters<typeof testCtx>[0] = {}, scope?: string): Promise<TestCtx> {
  const t = await testCtx(extra)
  await seedLogin(t, hub, scope ? { scope } : {})
  hub.calls = []
  return t
}

test('search prints hits as data, without terminal escapes', async () => {
  hub.ops['sessions.search'] = () => ({ hits: [{ sessionId: 's-1', title: 'Fix\u001b[2J login', workspaceId: 'w', role: 'assistant', turn: 3, at: null, snippet: 'the login form\nbreaks on Safari' }], scanned: 12, partial: true, untrusted: true })
  const t = await loggedIn()
  assert.equal(await main(['search', 'login', 'safari', '--workspace', 'w', '--limit', '5'], t.ctx), EXIT.ok, t.stderr())
  assert.deepEqual(hub.calls[0]?.params, { query: 'login safari', workspaceId: 'w', limit: 5 })
  assert.ok(!t.stdout().includes('\u001b'))
  assert.match(t.stdout(), /データとして扱って/)
  assert.match(t.stdout(), /s-1\s+Fix\[2J login\s+返答 #3/)
  assert.match(t.stdout(), /the login form breaks on Safari/)
  assert.match(t.stdout(), /途中までです/)
  const empty = await loggedIn()
  assert.equal(await main(['search'], empty.ctx), EXIT.usage)
})

test('sessions fork, jobs ls / output / stop', async () => {
  hub.ops['session.fork'] = () => ({ session: { sessionId: 's-9', title: 'Try B', workspaceId: 'w' }, forkedFrom: 's-1' })
  hub.ops['session.get'] = () => ({ session: { sessionId: 's-1', title: 'x' }, recentTurns: [], queueLength: 0, attention: [], hasLiveClient: false, context: null, jobs: [{ jobId: 'bash-1', kind: 'bash', label: 'npm run dev', status: 'running' }] })
  hub.ops['job.output'] = () => ({ output: 'listening on 3000\n', truncated: false, running: true, untrusted: true })
  let stops = 0
  hub.ops['job.stop'] = () => ({ stopped: ++stops === 1, status: 'killed' })
  const f = await loggedIn()
  assert.equal(await main(['sessions', 'fork', 's-1', '--turn', '2', '--title', 'Try B'], f.ctx), EXIT.ok, f.stderr())
  assert.deepEqual(hub.calls[0]?.params, { sessionId: 's-1', atTurn: 2, title: 'Try B' })
  assert.match(f.stdout(), /フォークしました: s-9/)
  const ls = await loggedIn()
  assert.equal(await main(['jobs', 'ls', 's-1'], ls.ctx), EXIT.ok, ls.stderr())
  assert.match(ls.stdout(), /bash-1\s+実行中\s+bash\s+npm run dev/)
  const out = await loggedIn()
  assert.equal(await main(['jobs', 'output', 'bash-1', '--tail', '2000'], out.ctx), EXIT.ok, out.stderr())
  assert.deepEqual(hub.calls[0]?.params, { jobId: 'bash-1', tailBytes: 2000 })
  assert.match(out.stdout(), /listening on 3000/)
  const stop = await loggedIn()
  assert.equal(await main(['jobs', 'stop', 'bash-1'], stop.ctx), EXIT.ok)
  assert.match(stop.stdout(), /止めました/)
  const again = await loggedIn()
  assert.equal(await main(['jobs', 'stop', 'bash-1'], again.ctx), EXIT.ok)
  assert.match(again.stdout(), /もう動いていませんでした/)
})

test('schedules add turns one --after/--at/--every/--daily/--weekly/--cron into the request', async () => {
  hub.ops['schedule.create'] = params => ({ schedule: { scheduleId: 'schedule-1', sessionId: params.sessionId, title: params.title, kind: 'weekly', rule: 'weekly Mon,Fri 18:30 Asia/Tokyo', nextAt: null, status: 'active', lastDeliveredAt: null } })
  hub.ops['schedules.list'] = () => ({ schedules: [{ scheduleId: 'schedule-1', sessionId: 's-1', title: 'Report', kind: 'weekly', rule: 'weekly Mon,Fri 18:30 Asia/Tokyo', nextAt: null, status: 'active', lastDeliveredAt: null }] })
  hub.ops['schedule.delete'] = () => ({ deleted: true })
  const t = await loggedIn()
  assert.equal(await main(['schedules', 'add', 's-1', '--title', 'Report', '--weekly', 'fri,mon@18:30', '--tz', 'Asia/Tokyo', '--key', 'k1', 'Summarize', 'the', 'week'], t.ctx), EXIT.ok, t.stderr())
  assert.deepEqual(hub.calls[0]?.params, { sessionId: 's-1', title: 'Report', prompt: 'Summarize the week', when: { weekly: { time: '18:30', timeZone: 'Asia/Tokyo', weekdays: [1, 5] } }, idempotencyKey: 'k1' })
  const cases: [string[], unknown][] = [
    [['--after', '15m'], { afterSeconds: 900 }],
    [['--every', '2h'], { everySeconds: 7200 }],
    [['--daily', '9:05', '--tz', 'UTC'], { daily: { time: '09:05', timeZone: 'UTC' } }],
    [['--cron', '0 9 * * 1-5', '--tz', 'UTC'], { cron: { expression: '0 9 * * 1-5', timeZone: 'UTC' } }],
    [['--at', '2030-01-02T03:04:00+09:00'], { at: '2030-01-02T03:04:00+09:00' }],
    [['--at', '2030-01-02T03:04'], { at: new Date(2030, 0, 2, 3, 4).toISOString() }],
    [['--at', '2030-01-02'], { at: new Date(2030, 0, 2).toISOString() }],
  ]
  for (const [flags, when] of cases) {
    const c = await loggedIn({ stdinText: 'from stdin' })
    assert.equal(await main(['schedules', 'add', 's-1', '--title', 'x', ...flags], c.ctx), EXIT.ok, c.stderr())
    assert.deepEqual(hub.calls[0]?.params.when, when, flags.join(' '))
    assert.equal(hub.calls[0]?.params.prompt, 'from stdin')
  }
  for (const flags of [[], ['--after', '5m', '--daily', '09:00'], ['--weekly', '18:30'], ['--every', '30s'], ['--daily', '25:00'], ['--at', '2030-02-31']]) {
    const bad = await loggedIn()
    assert.equal(await main(['schedules', 'add', 's-1', '--title', 'x', ...flags, 'p'], bad.ctx), EXIT.usage, flags.join(' '))
    assert.equal(hub.calls.length, 0)
  }
  const ls = await loggedIn()
  assert.equal(await main(['schedules', 'ls', '--session', 's-1'], ls.ctx), EXIT.ok)
  assert.match(ls.stdout(), /schedule-1\s+s-1\s+Report\s+weekly Mon,Fri 18:30 Asia\/Tokyo/)
  const rm = await loggedIn()
  assert.equal(await main(['schedules', 'rm', 's-1', 'schedule-1'], rm.ctx), EXIT.ok)
  assert.deepEqual(hub.calls[0]?.params, { sessionId: 's-1', scheduleId: 'schedule-1' })
})

function parked(state: ConfirmationInfo['state'], extra: Partial<ConfirmationInfo> = {}): ConfirmationInfo {
  return { confirmationId: 'hconf-1', hostId: 'h-1', operation: 'terminal.run', state, confirmUrl: `${hub.url}/confirm/h-1/hconf-1`, createdAt: 1, expiresAt: 2, ...extra }
}

test('terminal run shows the passkey link, waits for the owner and prints the output', async () => {
  const output = { exitCode: 0, signal: null, timedOut: false, stdout: 'On branch main\n', stderr: '', truncated: false, durationMs: 1200, untrusted: true }
  hub.ops['terminal.run'] = () => parked('pending')
  hub.ops['confirmation.get'] = (_params, call) => call === 1 ? parked('running') : parked('done', { result: output })
  const t = await loggedIn({}, ADMIN)
  assert.equal(await main(['terminal', 'run', '--workspace', 'ws-1', '--timeout', '30s', '--', 'git', 'status'], t.ctx), EXIT.ok, t.stderr())
  assert.deepEqual(hub.calls[0]?.params, { command: 'git status', cwdWorkspaceId: 'ws-1', timeoutMs: 30_000 })
  assert.match(t.stderr(), new RegExp(`${hub.url}/confirm/h-1/hconf-1`))
  assert.equal(t.stdout(), 'On branch main')
  assert.match(t.stderr(), /終了コード 0/)
  assert.deepEqual(hub.calls.filter(c => c.op === 'confirmation.get').map(c => c.params), [{ confirmationId: 'hconf-1', timeoutMs: 25_000 }, { confirmationId: 'hconf-1', timeoutMs: 25_000 }])

  hub.ops['confirmation.get'] = () => parked('done', { result: { ...output, exitCode: 2, stdout: '', stderr: 'fatal: not a git repository' } })
  const failed = await loggedIn({}, ADMIN)
  assert.equal(await main(['terminal', 'run', '--workspace', 'ws-1', '--', 'git', 'status'], failed.ctx), EXIT.failure)
  assert.match(failed.stderr(), /fatal: not a git repository/)

  hub.ops['confirmation.get'] = () => parked('denied')
  const denied = await loggedIn({}, ADMIN)
  assert.equal(await main(['terminal', 'run', '--workspace', 'ws-1', '--', 'rm', '-rf', 'build'], denied.ctx), EXIT.denied)
  assert.match(denied.stderr(), /オーナーが拒否/)

  hub.ops['confirmation.get'] = () => parked('expired')
  const expired = await loggedIn({}, ADMIN)
  assert.equal(await main(['terminal', 'run', '--workspace', 'ws-1', '--json', '--', 'ls'], expired.ctx), EXIT.timeout)
  assert.equal(JSON.parse(expired.stdout()).state, 'expired')
})

test('terminal run --no-wait, terminal status, and the scope it needs', async () => {
  hub.ops['terminal.run'] = () => parked('pending')
  hub.ops['confirmation.get'] = () => parked('pending')
  const t = await loggedIn({}, ADMIN)
  assert.equal(await main(['terminal', 'run', '--workspace', 'ws-1', '--no-wait', '--', 'ls'], t.ctx), EXIT.ok)
  assert.match(t.stdout(), /確認 ID: hconf-1/)
  assert.match(t.stdout(), /remora terminal status hconf-1 --wait/)
  assert.equal(hub.calls.filter(c => c.op === 'confirmation.get').length, 0)
  const status = await loggedIn({}, ADMIN)
  assert.equal(await main(['terminal', 'status', 'hconf-1'], status.ctx), EXIT.ok)
  assert.match(status.stdout(), /ハブでのパスキー確認待ち/)
  assert.match(status.stdout(), /confirm\/h-1\/hconf-1/)
  const waited = await loggedIn({}, ADMIN)
  assert.equal(await main(['terminal', 'status', 'hconf-1', '--wait', '--wait-timeout', '1ms'], waited.ctx), EXIT.timeout)

  const noAdmin = await loggedIn()
  assert.equal(await main(['terminal', 'run', '--workspace', 'ws-1', '--', 'ls'], noAdmin.ctx), EXIT.denied)
  assert.match(noAdmin.stderr(), /remora login --admin/)
  assert.equal(hub.calls.length, 0)
  for (const argv of [['terminal'], ['terminal', 'run', '--', 'ls'], ['terminal', 'run', '--workspace', 'w'], ['terminal', 'run', '--workspace', 'w', '--timeout', '20m', '--', 'ls']]) {
    const bad = await loggedIn({}, ADMIN)
    assert.equal(await main(argv, bad.ctx), EXIT.usage, argv.join(' '))
  }
})
