import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../src/main.ts'
import { configDir, normalizeHubUrl } from '../src/config.ts'
import { parseArgs } from '../src/args.ts'
import { clean, parseDuration, table, truncate, width } from '../src/format.ts'
import { EXIT, fromHttpError } from '../src/errors.ts'
import { testCtx } from './helpers.ts'

test('help, command help and version', async () => {
  const t = await testCtx()
  assert.equal(await main([], t.ctx), 0)
  assert.match(t.stdout(), /login/)
  assert.match(t.stdout(), /終了コード/)
  const h = await testCtx()
  assert.equal(await main(['help', 'run'], h.ctx), 0)
  assert.match(h.stdout(), /remora run --wait/)
  const h2 = await testCtx()
  assert.equal(await main(['tasks', '--help'], h2.ctx), 0)
  assert.match(h2.stdout(), /tasks start/)
  const v = await testCtx()
  assert.equal(await main(['--version'], v.ctx), 0)
  assert.equal(v.out[0], '0.0.0-dev')
})

test('unknown commands and flags are usage errors; JSON errors go to stdout', async () => {
  const t = await testCtx()
  assert.equal(await main(['frobnicate'], t.ctx), EXIT.usage)
  assert.match(t.stderr(), /不明なコマンド/)
  const f = await testCtx()
  assert.equal(await main(['hosts', '--bogus'], f.ctx), EXIT.usage)
  const j = await testCtx()
  assert.equal(await main(['hosts', '--json'], j.ctx), EXIT.auth)
  assert.equal(JSON.parse(j.stdout()).error.code, 'not_logged_in')
})

test('hub maintenance commands need a login (except checking a saved audit file)', async () => {
  for (const argv of [['audit', 'verify'], ['hub', 'export'], ['hosts', 'rotate-key'], ['rotate-key']]) {
    const t = await testCtx()
    assert.equal(await main(argv, t.ctx), EXIT.auth, argv.join(' '))
  }
})

test('doctor without a hub reports what to do', async () => {
  const t = await testCtx()
  assert.equal(await main(['doctor'], t.ctx), 1)
  assert.match(t.stdout(), /remora login/)
  const old = await testCtx({ nodeVersion: 'v22.18.0' })
  await main(['doctor', '--json'], old.ctx)
  const report = JSON.parse(old.stdout())
  assert.equal(report.checks.find((c: { name: string }) => c.name === 'Node.js').ok, false)
})

test('argument parser', () => {
  const p = parseArgs(['start', '--skill', 'a', '--skill=b', '--latest', '-y', '--json', '--', '--not-a-flag'], { skill: 'list', latest: 'bool', yes: 'bool' })
  assert.deepEqual(p.positionals, ['start', '--not-a-flag'])
  assert.deepEqual(p.flags.skill, ['a', 'b'])
  assert.equal(p.flags.latest, true)
  assert.equal(p.flags.yes, true)
  assert.equal(p.flags.json, true)
  assert.throws(() => parseArgs(['--skill'], { skill: 'list' }), /値を指定/)
  assert.throws(() => parseArgs(['--nope'], {}), /不明なオプション/)
})

test('formatting: control characters, widths, tables, durations', () => {
  assert.equal(clean('a\u001b[31mb\u202e\nc'), 'a[31mb c')
  assert.equal(clean('x\ny', true), 'x\ny')
  assert.equal(width('日本a'), 5)
  assert.equal(truncate('日本語のタイトル', 7), '日本語…')
  const lines = table(['ID', '名前'], [['1', '日本'], ['22', 'x']])
  assert.equal(lines[1], '1   日本')
  assert.equal(parseDuration('90'), 90_000)
  assert.equal(parseDuration('10m'), 600_000)
  assert.equal(parseDuration('1h'), 3_600_000)
  assert.equal(parseDuration('soon'), null)
})

test('config directory per platform and hub URL normalization', () => {
  assert.equal(configDir({ REMORA_CONFIG_DIR: '/x' }, 'linux', '/home/a'), '/x')
  assert.equal(configDir({}, 'linux', '/home/a'), '/home/a/.config/remora')
  assert.equal(configDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/a'), '/cfg/remora')
  assert.equal(configDir({}, 'darwin', '/Users/a'), '/Users/a/Library/Application Support/remora')
  assert.match(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'), /remora$/)
  assert.equal(normalizeHubUrl('hub.example.com/'), 'https://hub.example.com')
  assert.equal(normalizeHubUrl('http://127.0.0.1:8787/x'), 'http://127.0.0.1:8787')
  assert.throws(() => normalizeHubUrl('http://hub.example.com'), /https/)
})

test('HTTP error bodies map to exit codes', () => {
  const denied = fromHttpError(403, { error: { code: 'denied', message: 'no', denial: { layer: 'dsh', reason: 'level-too-low' }, fix: 'dsh:settings/remora#permissions' } })
  assert.equal(denied.exitCode, EXIT.denied)
  assert.match(denied.detail.hint ?? '', /DSH 側の上限/)
  assert.equal(fromHttpError(503, { error: { code: 'host_offline', message: 'offline' } }).exitCode, EXIT.unavailable)
  assert.equal(fromHttpError(404, { error: { code: 'not_found', message: 'x' } }).exitCode, EXIT.notFound)
  assert.equal(fromHttpError(400, { error: { code: 'invalid_request', message: 'x' } }).exitCode, EXIT.usage)
  assert.equal(fromHttpError(502, null).exitCode, EXIT.unavailable)
  assert.equal(fromHttpError(401, null).exitCode, EXIT.auth)
})
