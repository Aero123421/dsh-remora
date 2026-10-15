// Print the newest dsh-v*-alpha.* tag on deepseek-ai/deepseek-harness.
// Writes GitHub Actions outputs when GITHUB_OUTPUT is set.
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { compare, valid } from 'semver'

const remote = 'https://github.com/deepseek-ai/deepseek-harness.git'
const listed = spawnSync('git', ['ls-remote', '--tags', remote], { encoding: 'utf8' })
if (listed.status !== 0) {
  process.stderr.write(listed.stderr || 'git ls-remote failed\n')
  process.exit(listed.status || 1)
}

/** version -> commit. A peeled tag (`^{}`) replaces the tag object. */
const tags = new Map()
for (const line of listed.stdout.split('\n')) {
  if (line === '') continue
  const [sha, ref] = line.split('\t')
  if (!sha || !ref?.startsWith('refs/tags/dsh-v')) continue
  const peeled = ref.endsWith('^{}')
  const name = ref.slice('refs/tags/'.length).replace(/\^\{\}$/, '')
  const version = name.slice('dsh-v'.length)
  if (!version.includes('-alpha.') || valid(version) === null) continue
  if (!tags.has(version) || peeled) tags.set(version, sha)
}

const version = [...tags.keys()].sort(compare).at(-1)
const commit = version === undefined ? undefined : tags.get(version)
if (version === undefined || commit === undefined) {
  process.stderr.write('no dsh-v*-alpha.* tag found\n')
  process.exit(1)
}
process.stdout.write(`${version} ${commit}\n`)
const output = process.env.GITHUB_OUTPUT
if (output) appendFileSync(output, `version=${version}\ncommit=${commit}\n`)
