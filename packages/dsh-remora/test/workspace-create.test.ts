import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAdapter } from '../src/adapter/index.ts'
import { checkFolderName, checkGitUrl, gitCloneArgs, gitEnv } from '../src/adapter/workspace-create.ts'
import { OperationError, type WorkspaceCreationRecord } from '../src/ops/types.ts'
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
  const creations = new Map<string, WorkspaceCreationRecord>()
  const deps = { ...h.deps, workspaceCreations: { list: () => [...creations.values()], put: async (record: WorkspaceCreationRecord) => { creations.set(record.key, { ...record }) } } }
  const adapter = buildAdapter(dsh.ctx(), deps, { clone: { git, timeoutMs: 5000, maxBytes: 1000 } })
  const handlers = adapter.handlers as Required<typeof adapter.handlers>
  const settle = async (workspaceId: string) => {
    for (let i = 0; i < 200; i++) {
      const listed = (await handlers['workspaces.list']({}, context())).workspaces.find(w => w.workspaceId === workspaceId)
      if (listed && listed.state !== 'cloning') return listed
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('clone did not settle')
  }
  return { root, placement, dsh, ...h, deps, adapter, creations, git, handlers, settle }
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

test('workspace.create returns at once while git clones in the background, and marks the workspace untrusted', async () => {
  const f = await fixture('sleep 0.3; printf "%s\\n" "$@" > ../args.txt; mkdir .git; echo hi > README')
  const request = new AbortController()
  const result = await f.handlers['workspace.create']({ placementId: 'p1', name: 'cloned', gitUrl: 'https://github.com/o/r.git', idempotencyKey: 'k' }, { ...context(), signal: request.signal })
  request.abort() // the request finishing (or timing out at the hub) must not stop the clone
  assert.equal(result.workspace.state, 'cloning')
  assert.equal(result.workspace.untrusted, true)
  assert.deepEqual(f.policy.marked, [result.workspace.workspaceId])
  f.dsh.addSession('s1', { workspace: result.workspace.workspaceId })
  assert.equal(await code(f.handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'x', idempotencyKey: 't' }, context({ taskId: 't1' }))), 'conflict', 'no prompts while cloning')
  const done = await f.settle(result.workspace.workspaceId)
  assert.equal(done.state, 'ready')
  const args = (await readFile(join(f.placement, 'args.txt'), 'utf8')).trim().split('\n')
  assert.deepEqual(args.slice(-3), ['--', 'https://github.com/o/r.git', '.'])
  // Ready but untrusted: prompts stay refused until the owner trusts it (skills can be named in prose).
  const refused = await f.handlers['task.start']({ target: { sessionId: 's1' }, prompt: 'x', idempotencyKey: 't' }, context({ taskId: 't2' })).catch((error: OperationError) => error)
  assert.ok(refused instanceof OperationError)
  assert.equal(refused.code, 'denied')
  assert.equal(refused.details.fix, 'dsh:settings/remora#scope')
  assert.equal(f.dsh.calls.filter(call => call.method === 'prompt').length, 0)
})

test('a failed or oversized clone removes the folder and the registration, and reports clone-failed', async () => {
  const failing = await fixture('echo "fatal: repository not found" >&2; exit 128')
  const created = await failing.handlers['workspace.create']({ placementId: 'p1', name: 'bad', gitUrl: 'https://github.com/o/missing', idempotencyKey: 'k' }, context())
  const failed = await failing.settle(created.workspace.workspaceId)
  assert.equal(failed.state, 'clone-failed')
  assert.match(failed.stateMessage ?? '', /repository not found/)
  assert.deepEqual(await readdir(failing.placement), [])
  assert.equal(failing.dsh.workspaces.length, 0)
  const retried = await failing.handlers['workspace.create']({ placementId: 'p1', name: 'bad', gitUrl: 'https://github.com/o/missing', idempotencyKey: 'k' }, context())
  assert.equal(retried.workspace.state, 'clone-failed')
  const huge = await fixture('head -c 5000 /dev/zero > big.bin; sleep 3')
  const big = await huge.handlers['workspace.create']({ placementId: 'p1', name: 'big', gitUrl: 'https://github.com/o/big', idempotencyKey: 'k' }, context())
  assert.equal((await huge.settle(big.workspace.workspaceId)).state, 'clone-failed')
  assert.deepEqual(await readdir(huge.placement), [])
})

test('workspace.create idempotency and clone recovery survive a restart', async () => {
  const f = await fixture('exit 0')
  const first = await f.handlers['workspace.create']({ placementId: 'p1', name: 'kept', idempotencyKey: 'k' }, context())
  // A clone that was running when DSH stopped.
  await (await import('node:fs/promises')).mkdir(join(f.placement, 'half'))
  f.dsh.addWorkspace('ws-half', join(f.placement, 'half'))
  f.creations.set('client-1\u0000k2', { key: 'client-1\u0000k2', workspaceId: 'ws-half', path: join(f.placement, 'half'), name: 'half', state: 'cloning', createdAt: 1, updatedAt: 1 })
  const restarted = buildAdapter(f.dsh.ctx(), f.deps, { clone: { git: f.git, timeoutMs: 5000, maxBytes: 1000 } })
  restarted.start()
  const again = await restarted.handlers['workspace.create']!({ placementId: 'p1', name: 'kept', idempotencyKey: 'k' }, context())
  assert.equal(again.workspace.workspaceId, first.workspace.workspaceId)
  for (let i = 0; i < 100 && f.creations.get('client-1\u0000k2')?.state === 'cloning'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.creations.get('client-1\u0000k2')?.state, 'clone-failed')
  assert.deepEqual((await readdir(f.placement)).sort(), ['kept'])
  assert.ok(!f.dsh.workspaces.some(w => w.id === 'ws-half'))
  restarted.dispose()
})
