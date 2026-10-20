import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { publishRelease } from './publish-release.mjs'

const repo = 'Aero123421/dsh-remora'
const version = '0.1.7'
const tag = 'v0.1.7'
const names = ['SHA256SUMS', 'dsh-remora-0.1.7.tgz', 'remora.mjs']

function fixture(t, { assets = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'remora-publish-'))
  const assetsDir = join(root, 'dist')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(assetsDir)
  for (const name of names) writeFileSync(join(assetsDir, name), name)
  const notesFile = join(root, 'notes.md')
  writeFileSync(notesFile, 'notes')
  const state = { calls: [], assets: new Set(assets), exists: assets.length > 0 }
  const run = (command, args) => {
    state.calls.push([command, ...args])
    assert.equal(command, 'gh')
    assert.equal(args.includes('--clobber'), false)
    assert.equal(args.includes('--latest'), false)
    assert.equal(args.includes('--draft=false'), false)
    assert.equal(args[0] === 'release' && args[1] === 'edit', false)
    if (args[1] === 'view') {
      if (!state.exists) return { status: 1, stdout: '', stderr: 'release not found' }
      return { status: 0, stdout: `${[...state.assets].sort().join('\n')}${state.assets.size ? '\n' : ''}`, stderr: '' }
    }
    if (args[1] === 'create') {
      state.exists = true
      state.draft = true
      for (const name of names) state.assets.add(name)
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[1] === 'upload') {
      const uploaded = names.filter(name => args.some(arg => arg.endsWith(`/${name}`)))
      for (const name of uploaded) {
        if (state.assets.has(name)) return { status: 1, stdout: '', stderr: `${name} already exists` }
      }
      for (const name of uploaded) state.assets.add(name)
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 1, stdout: '', stderr: `unexpected ${args.join(' ')}` }
  }
  return { assetsDir, notesFile, state, run }
}

function options(f, extra = {}) {
  return { version, repo, assetsDir: f.assetsDir, notesFile: f.notesFile, run: f.run, ...extra }
}

test('a missing Release is created as a draft and does not touch latest', t => {
  const f = fixture(t)
  f.state.exists = false
  assert.equal(publishRelease(options(f)), 0)
  const create = f.state.calls.find(call => call[2] === 'create')
  assert.deepEqual(create, [
    'gh', 'release', 'create', tag,
    join(f.assetsDir, 'SHA256SUMS'),
    join(f.assetsDir, 'dsh-remora-0.1.7.tgz'),
    join(f.assetsDir, 'remora.mjs'),
    '--repo', repo, '--verify-tag', '--draft', '--title', 'Remora 0.1.7', '--notes-file', f.notesFile,
  ])
  assert.equal(f.state.calls.some(call => call[2] === 'upload' || call[2] === 'edit'), false)
  assert.equal(f.state.draft, true)
})

test('a prerelease is still created as a draft', t => {
  const f = fixture(t)
  f.state.exists = false
  assert.equal(publishRelease(options(f, { prerelease: true })), 0)
  const create = f.state.calls.find(call => call[2] === 'create')
  assert.equal(create.includes('--draft'), true)
  assert.equal(create.at(-1), '--prerelease')
  assert.equal(create.includes('--latest'), false)
})

test('an existing Release only receives assets whose names are new', t => {
  const f = fixture(t)
  f.state.exists = true
  f.state.draft = false
  f.state.assets = new Set(['already-there.txt'])
  const before = [...f.state.assets]
  assert.equal(publishRelease(options(f)), 0)
  assert.equal(f.state.draft, false)
  assert.deepEqual(f.state.calls.filter(call => call[2] === 'upload'), [[
    'gh', 'release', 'upload', tag,
    join(f.assetsDir, 'SHA256SUMS'),
    join(f.assetsDir, 'dsh-remora-0.1.7.tgz'),
    join(f.assetsDir, 'remora.mjs'),
    '--repo', repo,
  ]])
  assert.equal(f.state.calls.some(call => call[2] === 'edit' || call[2] === 'create'), false)
  assert.deepEqual([...f.state.assets], [...before, ...names])
})

test('a same-named tarball or SHA256SUMS is left in place and the command exits 1', t => {
  for (const existing of [['dsh-remora-0.1.7.tgz'], ['SHA256SUMS'], ['dsh-remora-0.1.7.tgz', 'SHA256SUMS']]) {
    const f = fixture(t)
    f.state.exists = true
    f.state.draft = true
    f.state.assets = new Set(existing)
    const before = new Set(f.state.assets)
    assert.equal(publishRelease(options(f)), 1)
    assert.equal(f.state.calls.some(call => call[2] === 'upload' || call[2] === 'edit' || call[2] === 'create'), false)
    assert.deepEqual(f.state.assets, before)
    assert.equal(f.state.draft, true)
  }
})

test('the workflow and the script never edit, clobber, or mark latest', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const script = readFileSync(new URL('./publish-release.mjs', import.meta.url), 'utf8')
  for (const source of [workflow, script]) {
    assert.equal(source.includes('--clobber'), false)
    assert.equal(source.includes('--latest'), false)
    assert.equal(source.includes('--draft=false'), false)
    assert.equal(source.includes('release edit'), false)
  }
  assert.match(workflow, /node scripts\/publish-release\.mjs/)
  assert.equal(workflow.includes('gh release'), false)
  assert.match(script, /--draft/)
})
