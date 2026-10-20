#!/usr/bin/env node
// Opens a GitHub Release for one tag, or adds assets to a draft that is already there.
//
// A new Release is always a draft. A person publishes it.
// The tag is found with `gh release list --json tagName,isDraft`. Absence is an empty result,
// not an error string. A published Release (isDraft is not true) is left unchanged, assets
// included, and this command exits 1. A draft keeps its notes, draft state, and latest flag.
// Assets are uploaded only when every name is new. A same-named asset, such as the plugin tarball
// or SHA256SUMS, is left in place and this command exits 1. Nothing is overwritten.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const releaseListLimit = 1000

export function publishRelease(options = {}) {
  const version = options.version ?? process.env.VERSION
  const repo = options.repo ?? process.env.GITHUB_REPOSITORY
  const prerelease = options.prerelease ?? process.env.PRERELEASE === 'true'
  const assetsDir = options.assetsDir ?? 'dist'
  const notesFile = options.notesFile ?? 'notes.md'
  const run = options.run ?? defaultRun
  if (!version || !repo) {
    console.error('::error::VERSION and GITHUB_REPOSITORY are required')
    return 1
  }
  const tag = `v${version}`
  const assets = readdirSync(assetsDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort()
  const paths = assets.map(name => resolve(assetsDir, name))
  const listed = run('gh', ['release', 'list', '--repo', repo, '--json', 'tagName,isDraft', '--limit', String(releaseListLimit)])
  if (listed.status !== 0) return 1
  let releases
  try {
    releases = JSON.parse(listed.stdout)
  } catch {
    console.error('::error::release list was not JSON')
    return 1
  }
  if (!Array.isArray(releases)) return 1
  const found = releases.find(release => release?.tagName === tag)
  if (!found) {
    if (releases.length >= releaseListLimit) {
      console.error(`::error::release list is full and ${tag} is not in it; refusing to create`)
      return 1
    }
    const args = ['release', 'create', tag, ...paths, '--repo', repo, '--verify-tag', '--draft', '--title', `Remora ${version}`, '--notes-file', notesFile]
    if (prerelease) args.push('--prerelease')
    const created = run('gh', args)
    return created.status === 0 ? 0 : 1
  }
  if (found.isDraft !== true) {
    console.error(`::error::release ${tag} is already published; leaving it unchanged`)
    return 1
  }
  const viewed = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets', '--jq', '.assets[].name'])
  if (viewed.status !== 0) return 1
  const existing = new Set(viewed.stdout.split('\n').map(name => name.trim()).filter(Boolean))
  const clash = assets.filter(name => existing.has(name))
  if (clash.length) {
    console.error(`::error::release ${tag} already has ${clash.join(', ')}; leaving those assets in place`)
    return 1
  }
  if (paths.length === 0) return 0
  const uploaded = run('gh', ['release', 'upload', tag, ...paths, '--repo', repo])
  return uploaded.status === 0 ? 0 : 1
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(publishRelease())
}
