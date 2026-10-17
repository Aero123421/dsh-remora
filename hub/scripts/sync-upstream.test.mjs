import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compareReleaseTags, syncUpstream } from './sync-upstream.mjs'

test('sync uses forward semver precedence and rejects malformed release tags', () => {
  for (const [a, b] of [['v0.1.10', 'v0.1.9'], ['v0.2.0', 'v0.2.0-rc.2'], ['v0.2.0-rc.10', 'v0.2.0-rc.2'], ['v0.2.0-beta', 'v0.2.0-2']]) {
    assert.equal(compareReleaseTags(a, b), 1)
    assert.equal(compareReleaseTags(b, a), -1)
  }
  assert.equal(compareReleaseTags('v0.1.4+build.1', 'v0.1.4+build.2'), 0)
  for (const tag of ['v0.1.04', 'v0.1.4-rc.02', 'main', 'v0.1.4\n']) assert.throws(() => compareReleaseTags(tag, 'v0.1.4'), /Invalid/)
})

function fixture(t, { current = '0.1.3', latest = 'v0.1.4', unknownBase = false, customized = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'remora-sync-test-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: current }))
  writeFileSync(join(cwd, 'wrangler.jsonc'), customized ? 'my deployment config' : 'old upstream config')
  const state = { branch: false, pr: false, failPr: false, calls: [] }
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
  const run = (cmd, args) => {
    state.calls.push([cmd, ...args])
    if (cmd === 'gh') {
      if (args[0] === 'release') return ok(latest)
      if (args[1] === 'list') return ok(JSON.stringify(state.pr ? [{ number: 1 }] : []))
      if (args[1] === 'create') {
        if (state.failPr) return { status: 1, stderr: 'PR permission denied' }
        state.pr = true
        return ok()
      }
    }
    if (cmd === 'git') {
      if (args[0] === 'ls-remote') return state.branch ? ok() : { status: 2 }
      if (args[0] === 'clone') {
        const tag = args[args.indexOf('--branch') + 1]
        if (tag === `v${current}` && unknownBase) return { status: 128, stderr: 'tag not found' }
        const dir = join(args.at(-1), 'hub')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'wrangler.jsonc'), tag === latest ? 'new upstream config' : 'old upstream config')
        return ok()
      }
      if (args[0] === 'diff') return { status: 1 }
      if (args[0] === 'push') state.branch = true
      return ok()
    }
    if (cmd === 'rsync') {
      writeFileSync(join(cwd, 'wrangler.jsonc'), 'new upstream config')
      return ok()
    }
    throw new Error(`unexpected command: ${cmd} ${args}`)
  }
  return { cwd, run, log: () => {}, state }
}

test('a failed PR creation is retried after a successful branch push', t => {
  const f = fixture(t)
  f.state.failPr = true
  assert.throws(() => syncUpstream(f), /PR permission denied/)
  assert.equal(f.state.branch, true)
  assert.equal(f.state.pr, false)
  const cloneCount = f.state.calls.filter(call => call[1] === 'clone').length
  f.state.failPr = false
  syncUpstream(f)
  assert.equal(f.state.pr, true)
  assert.equal(f.state.calls.filter(call => call[1] === 'clone').length, cloneCount, 'existing branch needs no copy or push')
  syncUpstream(f)
  assert.equal(f.state.calls.filter(call => call[1] === 'pr' && call[2] === 'create').length, 2, 'existing PR is not duplicated')
})

test('a main snapshot ahead of stable and an equal version never create a branch', t => {
  for (const current of ['0.1.5-rc.1', '0.1.4']) {
    const f = fixture(t, { current })
    syncUpstream(f)
    assert.equal(f.state.calls.length, 1)
    assert.equal(f.state.branch, false)
  }
})

test('unknown upstream base preserves deployment configuration', t => {
  const f = fixture(t, { unknownBase: true, customized: false })
  syncUpstream(f)
  assert.equal(readFileSync(join(f.cwd, 'wrangler.jsonc'), 'utf8'), 'old upstream config')
})

test('known customized configuration is kept; untouched configuration follows upstream', t => {
  for (const customized of [true, false]) {
    const f = fixture(t, { customized })
    syncUpstream(f)
    assert.equal(readFileSync(join(f.cwd, 'wrangler.jsonc'), 'utf8'), customized ? 'my deployment config' : 'new upstream config')
  }
})

test('remote lookup failures are not mistaken for an absent branch', t => {
  const f = fixture(t)
  const run = (cmd, args) => args[0] === 'ls-remote' ? { status: 128, stderr: 'network unavailable' } : f.run(cmd, args)
  assert.throws(() => syncUpstream({ ...f, run }), /network unavailable/)
  assert.equal(f.state.branch, false)
})
