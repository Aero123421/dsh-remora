// Official DSH UI primitives (Switch, Button, Modal …) are compiled from the
// pinned DSH source (repository-root upstream.json) so the settings tab looks
// and behaves like DSH's own pages. DSH is MIT licensed; only
// packages/client/ui-primitives is fetched (sparse, blob-less), into
// .cache/upstream-<commit>. Set DSH_UPSTREAM_DIR to use an existing checkout
// of the same commit instead (no network).
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pinned = JSON.parse(await readFile(resolve(root, '../../upstream.json'), 'utf8'))
const PROBE = 'packages/client/ui-primitives/src/Switch.tsx'

async function exists(path) {
  try { await access(path); return true } catch { return false }
}

function git(args) {
  const result = spawnSync('git', args, { stdio: ['ignore', 'inherit', 'inherit'] })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed; set DSH_UPSTREAM_DIR to a DSH checkout of ${pinned.commit} to build offline`)
}

export async function ensureUpstream() {
  if (process.env.DSH_UPSTREAM_DIR) {
    const dir = resolve(process.env.DSH_UPSTREAM_DIR)
    if (!(await exists(join(dir, PROBE)))) throw new Error(`DSH_UPSTREAM_DIR (${dir}) has no ${PROBE}`)
    return dir
  }
  const dir = resolve(root, '.cache', `upstream-${pinned.commit.slice(0, 12)}`)
  if (await exists(join(dir, PROBE))) return dir
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  git(['init', '-q', dir])
  git(['-C', dir, 'remote', 'add', 'origin', pinned.repository])
  git(['-C', dir, 'sparse-checkout', 'set', '--cone', 'packages/client/ui-primitives'])
  git(['-C', dir, 'fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', pinned.commit])
  git(['-C', dir, 'checkout', '-q', '--detach', 'FETCH_HEAD'])
  return dir
}

export { pinned }
