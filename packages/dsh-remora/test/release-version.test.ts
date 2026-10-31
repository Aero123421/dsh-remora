import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const read = (path: string) => readFileSync(join(repo, path), 'utf8')
const json = (path: string) => JSON.parse(read(path)) as { version?: string; packages?: { '': { version?: string } } }

test('release versions stay together and the release note exists', () => {
  const plugin = json('packages/dsh-remora/package.json').version
  const cli = json('packages/cli/package.json').version
  const hub = json('hub/package.json').version
  const lock = json('hub/package-lock.json')
  const hubVersion = /HUB_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(read('hub/src/version.ts'))?.[1]
  assert.equal(plugin, '0.1.8')
  assert.equal(cli, plugin)
  assert.equal(hub, plugin)
  assert.equal(lock.version, plugin)
  assert.equal(lock.packages?.[''].version, plugin)
  assert.equal(hubVersion, plugin)
  readFileSync(join(repo, 'docs/releases', `v${plugin}.md`))
})
