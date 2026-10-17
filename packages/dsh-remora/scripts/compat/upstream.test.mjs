import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { upstreamIdentity } from './upstream.mjs'

test('local source identity reports its actual commit and dirty state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'remora-upstream-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'apps/cli'), { recursive: true })
  const manifest = join(root, 'apps/cli/package.json')
  writeFileSync(manifest, JSON.stringify({ version: '0.2.1-rc.2' }))
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  git(['init', '-q'])
  git(['add', '.'])
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'])
  const sha = git(['rev-parse', 'HEAD'])
  assert.equal(await upstreamIdentity(root), `0.2.1-rc.2 (${sha.slice(0, 7)}; ${root})`)
  writeFileSync(manifest, JSON.stringify({ version: '0.2.1-rc.3' }))
  assert.match(await upstreamIdentity(root), new RegExp(`0.2.1-rc.3 \\(${sha.slice(0, 7)}, modified working tree;`))
  const nested = join(root, 'unpacked')
  mkdirSync(nested)
  assert.equal(await upstreamIdentity(nested), `unknown version (unversioned source: ${nested})`)
})
