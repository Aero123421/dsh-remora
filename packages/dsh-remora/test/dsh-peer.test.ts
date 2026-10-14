import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies } from 'semver'

const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')) as { peerDependencies: Record<string, string> }
const range = manifest.peerDependencies['@deepseek-ai/dsh']

/**
 * DSH `evaluatePluginCompatibility` uses `semver.satisfies(runtime, range, { includePrerelease: true })`
 * for every `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peer. A miss skips the plugin at boot.
 * `<0.2.2-0` is below every 0.2.2 prerelease, so this range is the 0.2.1 line only.
 */
test('the DSH peer range admits alpha.3 and later 0.2.1 prereleases', () => {
  assert.equal(range, '>=0.2.1-alpha.2 <0.2.2-0')
  const admits = (version: string) => satisfies(version, range!, { includePrerelease: true })
  for (const version of ['0.2.1-alpha.2', '0.2.1-alpha.3', '0.2.1-alpha.10', '0.2.1-beta.1', '0.2.1-rc.1', '0.2.1']) {
    assert.equal(admits(version), true, version)
  }
  for (const version of ['0.2.1-alpha.1', '0.2.2-0', '0.2.2-alpha.1', '0.2.2', '0.3.0-alpha.1']) {
    assert.equal(admits(version), false, version)
  }
})
