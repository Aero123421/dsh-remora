import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main, type Io } from '../src/main.ts'
import { configDir } from '../src/config.ts'

function io(nodeVersion = 'v22.22.0') {
  const out: string[] = [], err: string[] = []
  const value: Io = { out: line => out.push(line), err: line => err.push(line), env: {}, platform: 'linux', nodeVersion }
  return { value, out, err }
}

test('help lists the planned commands with their phase', async () => {
  const t = io()
  assert.equal(await main([], t.value), 0)
  assert.ok(t.out.some(line => line.includes('login') && line.includes('P0')))
})

test('version and doctor', async () => {
  const v = io()
  assert.equal(await main(['--version'], v.value), 0)
  assert.equal(v.out[0], '0.0.0-dev')
  assert.equal(await main(['doctor'], io().value), 0)
  assert.equal(await main(['doctor'], io('v22.18.0').value), 1)
})

test('planned and unknown commands fail with distinct codes', async () => {
  const planned = io()
  assert.equal(await main(['tasks', 'start'], planned.value), 2)
  assert.match(planned.err[0] ?? '', /P0/)
  assert.equal(await main(['frobnicate'], io().value), 64)
})

test('config directory per platform', () => {
  assert.equal(configDir({ REMORA_CONFIG_DIR: '/x' }, 'linux', '/home/a'), '/x')
  assert.equal(configDir({}, 'linux', '/home/a'), '/home/a/.config/remora')
  assert.equal(configDir({ XDG_CONFIG_HOME: '/cfg' }, 'linux', '/home/a'), '/cfg/remora')
  assert.equal(configDir({}, 'darwin', '/Users/a'), '/Users/a/Library/Application Support/remora')
  assert.match(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'), /remora$/)
})
