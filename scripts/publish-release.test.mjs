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

function fixture(t, { release } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'remora-publish-'))
  const assetsDir = join(root, 'dist')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(assetsDir)
  for (const name of names) writeFileSync(join(assetsDir, name), name)
  const notesFile = join(root, 'notes.md')
  writeFileSync(notesFile, 'notes')
  const state = {
    calls: [],
    release: release ? { isDraft: release.isDraft, assets: new Set(release.assets ?? []) } : null,
    listResult: null,
  }
  const run = (command, args) => {
    state.calls.push([command, ...args])
    assert.equal(command, 'gh')
    assert.equal(args.includes('--clobber'), false)
    assert.equal(args.includes('--latest'), false)
    assert.equal(args.includes('--draft=false'), false)
    assert.equal(args[0] === 'release' && args[1] === 'edit', false)
    if (args[1] === 'list') {
      if (state.listResult) return state.listResult
      const rows = state.release ? [{ tagName: 'v0.1.6', isDraft: false }, { tagName: tag, isDraft: state.release.isDraft }] : [{ tagName: 'v0.1.6', isDraft: false }]
      return { status: 0, stdout: JSON.stringify(rows), stderr: '' }
    }
    if (args[1] === 'view') {
      const assets = state.release?.assets ?? new Set()
      return { status: 0, stdout: `${[...assets].sort().join('\n')}${assets.size ? '\n' : ''}`, stderr: '' }
    }
    if (args[1] === 'create') {
      state.release = { isDraft: true, assets: new Set(names) }
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args[1] === 'upload') {
      const uploaded = names.filter(name => args.some(arg => arg.endsWith(`/${name}`)))
      for (const name of uploaded) {
        if (state.release.assets.has(name)) return { status: 1, stdout: '', stderr: `${name} already exists` }
      }
      for (const name of uploaded) state.release.assets.add(name)
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
  assert.equal(publishRelease(options(f)), 0)
  assert.deepEqual(f.state.calls[0], ['gh', 'release', 'list', '--repo', repo, '--json', 'tagName,isDraft', '--limit', '1000'])
  const create = f.state.calls.find(call => call[2] === 'create')
  assert.deepEqual(create, [
    'gh', 'release', 'create', tag,
    join(f.assetsDir, 'SHA256SUMS'),
    join(f.assetsDir, 'dsh-remora-0.1.7.tgz'),
    join(f.assetsDir, 'remora.mjs'),
    '--repo', repo, '--verify-tag', '--draft', '--title', 'Remora 0.1.7', '--notes-file', f.notesFile,
  ])
  assert.equal(f.state.calls.some(call => call[2] === 'upload' || call[2] === 'edit'), false)
  assert.equal(f.state.release.isDraft, true)
})

test('a prerelease is still created as a draft', t => {
  const f = fixture(t)
  assert.equal(publishRelease(options(f, { prerelease: true })), 0)
  const create = f.state.calls.find(call => call[2] === 'create')
  assert.equal(create.includes('--draft'), true)
  assert.equal(create.at(-1), '--prerelease')
  assert.equal(create.includes('--latest'), false)
})

test('a draft receives assets whose names are new', t => {
  const f = fixture(t, { release: { isDraft: true, assets: ['already-there.txt'] } })
  const before = [...f.state.release.assets]
  assert.equal(publishRelease(options(f)), 0)
  assert.equal(f.state.release.isDraft, true)
  assert.deepEqual(f.state.calls.filter(call => call[2] === 'upload'), [[
    'gh', 'release', 'upload', tag,
    join(f.assetsDir, 'SHA256SUMS'),
    join(f.assetsDir, 'dsh-remora-0.1.7.tgz'),
    join(f.assetsDir, 'remora.mjs'),
    '--repo', repo,
  ]])
  assert.equal(f.state.calls.some(call => call[2] === 'edit' || call[2] === 'create'), false)
  assert.deepEqual([...f.state.release.assets], [...before, ...names])
})

test('a published Release is left unchanged, assets included, and the command exits 1', t => {
  for (const isDraft of [false, null, undefined]) {
    const f = fixture(t, { release: { isDraft, assets: ['dsh-remora-0.1.7.tgz', 'SHA256SUMS'] } })
    const before = new Set(f.state.release.assets)
    assert.equal(publishRelease(options(f)), 1)
    assert.deepEqual(f.state.calls.map(call => call[2]), ['list'])
    assert.deepEqual(f.state.release.assets, before)
    assert.equal(f.state.release.isDraft, isDraft)
  }
})

test('a failed release list is not treated as a missing Release', t => {
  const f = fixture(t)
  f.state.listResult = { status: 1, stdout: '', stderr: 'release not found' }
  assert.equal(publishRelease(options(f)), 1)
  assert.deepEqual(f.state.calls.map(call => call[2]), ['list'])
  assert.equal(f.state.release, null)
})

test('a same-named tarball or SHA256SUMS on a draft is left in place and the command exits 1', t => {
  for (const existing of [['dsh-remora-0.1.7.tgz'], ['SHA256SUMS'], ['dsh-remora-0.1.7.tgz', 'SHA256SUMS']]) {
    const f = fixture(t, { release: { isDraft: true, assets: existing } })
    const before = new Set(f.state.release.assets)
    assert.equal(publishRelease(options(f)), 1)
    assert.equal(f.state.calls.some(call => call[2] === 'upload' || call[2] === 'edit' || call[2] === 'create'), false)
    assert.deepEqual(f.state.release.assets, before)
    assert.equal(f.state.release.isDraft, true)
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
  assert.match(script, /release list/)
  assert.match(script, /tagName,isDraft/)
  assert.equal(script.includes('not found'), false)
})
