#!/usr/bin/env node
// Checks that everything Remora releases carries one version number.
//
//   node scripts/check-version.mjs              all versions agree with each other
//   node scripts/check-version.mjs --tag v1.2.3 ...and with the tag (default: $GITHUB_REF_NAME when it is a v* tag)
//
// Compared: packages/dsh-remora, packages/cli, hub/package.json, the root
// entry of hub/package-lock.json and HUB_VERSION in hub/src/version.ts.
// Prints the version; with $GITHUB_OUTPUT set, also writes `version=<v>` and
// `prerelease=true|false` there for later workflow steps.
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: { tag: { type: 'string' } } })
const refName = process.env.GITHUB_REF_TYPE === 'tag' || /^v\d/.test(process.env.GITHUB_REF_NAME ?? '') ? process.env.GITHUB_REF_NAME : undefined
const tag = values.tag ?? refName

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const json = path => JSON.parse(readFileSync(join(repo, path), 'utf8'))
const sources = []
const add = (label, read) => {
  try { sources.push({ label, version: read() }) } catch (error) { sources.push({ label, error: error.message }) }
}
add('packages/dsh-remora/package.json', () => json('packages/dsh-remora/package.json').version)
add('packages/cli/package.json', () => json('packages/cli/package.json').version)
add('hub/package.json', () => json('hub/package.json').version)
add('hub/package-lock.json', () => {
  const lock = json('hub/package-lock.json')
  return lock.packages?.['']?.version ?? lock.version
})
add('hub/src/version.ts (HUB_VERSION)', () => {
  const match = /HUB_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(readFileSync(join(repo, 'hub/src/version.ts'), 'utf8'))
  if (!match) throw new Error('HUB_VERSION not found')
  return match[1]
})

const problems = []
for (const source of sources) {
  if (source.error) problems.push(`${source.label}: ${source.error}`)
  else if (!SEMVER.test(source.version)) problems.push(`${source.label}: "${source.version}" is not a semantic version`)
}
const version = sources.find(source => source.version)?.version
for (const source of sources) {
  if (source.version && source.version !== version) problems.push(`${source.label} is ${source.version}, expected ${version} (${sources[0].label})`)
}
if (tag !== undefined) {
  if (!/^v/.test(tag)) problems.push(`tag "${tag}" does not start with "v"`)
  else if (tag.slice(1) !== version) problems.push(`tag ${tag} does not match the package version ${version}`)
}

for (const source of sources) console.log(`${source.error ? '✘' : source.version === version ? '✔' : '✘'} ${source.label.padEnd(36)} ${source.version ?? source.error}`)
if (tag !== undefined) console.log(`${tag.slice(1) === version ? '✔' : '✘'} ${'tag'.padEnd(36)} ${tag}`)

if (problems.length > 0) {
  console.error(`\nversion check failed:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
  console.error('\nBump every file above to the same version (and tag v<version>) before releasing.')
  process.exit(1)
}
const prerelease = version.includes('-')
console.log(`\nversion ${version}${prerelease ? ' (prerelease)' : ''}`)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nprerelease=${prerelease}\n`)
