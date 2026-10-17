// Select public DSH releases within the plugin's actual supported peer range.
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { latestSupportedTag, releaseMatrix, supportedVersions } from './releases.mjs'

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const range = manifest.peerDependencies['@deepseek-ai/dsh']
const matrix = process.argv.includes('--matrix')
const result = matrix
  ? spawnSync('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json'], { encoding: 'utf8' })
  : spawnSync('git', ['ls-remote', '--tags', 'https://github.com/deepseek-ai/deepseek-harness.git'], { encoding: 'utf8' })
if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'DSH release lookup failed')
let outputs
if (matrix) {
  const published = JSON.parse(result.stdout)
  const selected = process.env.REMORA_CI_DSH_VERSION?.trim()
  let versions = releaseMatrix(published, range)
  if (selected) {
    if (!supportedVersions(published, range).includes(selected)) throw new Error(`DSH ${selected} is unpublished or outside ${range}; use an exact supported version`)
    versions = [selected]
  } else if (process.argv.includes('--minimum-only')) versions = versions.slice(0, 1)
  outputs = { matrix: JSON.stringify(versions) }
} else outputs = latestSupportedTag(result.stdout, range)
for (const [key, value] of Object.entries(outputs)) {
  console.log(`${key}=${value}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
