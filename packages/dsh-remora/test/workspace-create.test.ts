import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAdapter } from '../src/adapter/index.ts'
import { checkFolderName, checkGitUrl, gitCloneArgs, gitEnv } from '../src/adapter/workspace-create.ts'
import { OperationError } from '../src/ops/types.ts'
import { context, createFake, harness } from './fake-dsh.ts'

async function code(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
  } catch (error) {
    assert.ok(error instanceof OperationError, String(error))
    return error.code
  }
  return 'ok'
}

test('folder names are one safe path segment', async () => {
  for (const bad of ['..', '.', '...', 'a/b', 'a\\b', '', 'x y', 'a\u0000']) assert.equal(await code(() => checkFolderName(bad)), 'invalid_request', bad)
  for (const good of ['repo', 'my-app_2', 'v1.0']) assert.equal(await code(() => checkFolderName(good)), 'ok', good)
})

test('git URLs: https only, no credentials, allowed hosts only', async () => {
  const hosts = ['github.com']
  assert.equal(checkGitUrl('https://github.com/o/r.git', hosts), 'https://github.com/o/r.git')
  assert.equal(await code(() => checkGitUrl('http://github.com/o/r', hosts)), 'invalid_request')
  assert.equal(await code(() => checkGitUrl('ssh://git@github.com/o/r', hosts)), 'invalid_request')
  assert.equal(await code(() => checkGitUrl('file:///etc', hosts)), 'invalid_request')
  assert.equal(await code(() => checkGitUrl('https://user:pw@github.com/o/r', hosts)), 'invalid_request')
  assert.equal(await code(() => checkGitUrl('https://evil.example/o/r', hosts)), 'denied')
  assert.equal(await code(() => checkGitUrl('https://github.com.evil.example/o/r', hosts)), 'denied')
  assert.equal(await code(() => checkGitUrl('https://github.com/o/r --upload-pack=x', hosts)), 'invalid_request')
})

test('git runs with hooks, file protocol, credentials and global config disabled', () => {
  const args = gitCloneArgs('https://github.com/o/r')
  for (const flag of ['protocol.file.allow=never', 'credential.helper=', 'http.followRedirects=false']) assert.ok(args.includes(flag), flag)
  assert.ok(args.some(arg => arg.startsWith('core.hooksPath=')))
  assert.ok(args.includes('--no-recurse-submodules'))
  assert.deepEqual(args.slice(-3), ['--', 'https://github.com/o/r', '.'])
  const env = gitEnv({ PATH: '/bin', GITHUB_TOKEN: 'secret', GIT_DIR: '/x' })
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.GITHUB_TOKEN, undefined)
  assert.equal(env.GIT_DIR, undefined)
})

async function fixture(script: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'remora-ws-')))
  const placement = join(root, 'place')
  await (await import('node:fs/promises')).mkdir(placement)
  const git = join(root, 'fake-git.sh')
  await writeFile(git, `#!/bin/sh\n${script}\n`)
  await chmod(git, 0o755)
  const dsh = createFake()
  const h = harness(dsh, { placements: [{ placementId: 'p1', path: placement }], gitHosts: ['github.com'] })
  const adapter = buildAdapter(dsh.ctx(), h.deps, { clone: { git, timeoutMs: 5000, maxBytes: 1000 } })
  return { root, placement, dsh, ...h, handlers: adapter.handlers as Required<typeof adapter.handlers> }
}

test('workspace.create makes the folder under the placement, registers it, and is idempotent per key', async () => {
  const { placement, dsh, handlers } = await fixture('exit 0')
  const result = await handlers['workspace.create']({ placementId: 'p1', name: 'fresh', idempotencyKey: 'k' }, context())
  assert.equal(result.workspace.path, join(placement, 'fresh'))
  assert.equal(result.workspace.untrusted, false)
  const again = await handlers['workspace.create']({ placementId: 'p1', name: 'fresh', idempotencyKey: 'k' }, context())
  assert.equal(again.workspace.workspaceId, result.workspace.workspaceId)
  assert.equal(dsh.workspaces.length, 1)
  assert.equal(await code(handlers['workspace.create']({ placementId: 'p1', name: 'fresh', idempotencyKey: 'other' }, context())), 'conflict')
  assert.equal(await code(handlers['workspace.create']({ placementId: 'nope', name: 'x', idempotencyKey: 'k2' }, context())), 'not_found')
})

test('workspace.create refuses a name that resolves outside the placement', async () => {
  const { root, placement, handlers } = await fixture('exit 0')
  await symlink(root, join(placement, 'escape'))
  // mkdir fails on an existing symlink: conflict, never a write outside.
  assert.equal(await code(handlers['workspace.create']({ placementId: 'p1', name: 'escape', idempotencyKey: 'k' }, context())), 'conflict')
})

test('workspace.create clones with git and marks the workspace untrusted', async () => {
  const { placement, handlers, policy } = await fixture('printf "%s\\n" "$@" > ../args.txt; mkdir .git; echo hi > README')
  const result = await handlers['workspace.create']({ placementId: 'p1', name: 'cloned', gitUrl: 'https://github.com/o/r.git', idempotencyKey: 'k' }, context())
  assert.equal(result.workspace.untrusted, true)
  assert.deepEqual(policy.marked, [result.workspace.workspaceId])
  const args = (await readFile(join(placement, 'args.txt'), 'utf8')).trim().split('\n')
  assert.deepEqual(args.slice(-3), ['--', 'https://github.com/o/r.git', '.'])
})

test('a failed or oversized clone removes the folder', async () => {
  const failing = await fixture('echo "fatal: repository not found" >&2; exit 128')
  assert.equal(await code(failing.handlers['workspace.create']({ placementId: 'p1', name: 'bad', gitUrl: 'https://github.com/o/missing', idempotencyKey: 'k' }, context())), 'invalid_request')
  assert.deepEqual(await readdir(failing.placement), [])
  const huge = await fixture('head -c 5000 /dev/zero > big.bin; sleep 3')
  assert.equal(await code(huge.handlers['workspace.create']({ placementId: 'p1', name: 'big', gitUrl: 'https://github.com/o/big', idempotencyKey: 'k' }, context())), 'invalid_request')
  assert.deepEqual(await readdir(huge.placement), [])
})
