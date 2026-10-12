/**
 * workspace.create: make a folder under an allowed placement (置き場所),
 * optionally clone an https Git URL into it, then register it with DSH.
 *
 * The folder is created by the plugin itself, never through a shell:
 * - the name is one path segment (`[A-Za-z0-9._-]+`, not `.`/`..`),
 * - the realpath of the new folder must stay inside the realpath of the placement,
 * - git runs through `spawn` without a shell, with hooks, file protocol,
 *   submodules, credential helpers, redirects and the user's global/system
 *   config disabled, a timeout and a size cap.
 */
import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir, realpath, rm, rmdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { OperationParams, OperationResults, WorkspaceSummary } from '@dsh-remora/protocol'
import type { OperationContext, WorkspaceCreationRecord } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redactLine } from '../redact.ts'
import type { DshWorkspace } from './dsh-types.ts'
import { denied, fromDsh, invalid, notFound, unavailable } from './errors.ts'
import type { Runtime } from './runtime.ts'

type Params<Op extends keyof OperationParams> = OperationParams[Op]
type Result<Op extends keyof OperationResults> = OperationResults[Op]

export interface CloneLimits {
  timeoutMs: number
  maxBytes: number
  /** Executable to run (tests point this at a fake). */
  git: string
}

export const DEFAULT_CLONE_LIMITS: CloneLimits = { timeoutMs: 10 * 60_000, maxBytes: 2 * 1024 ** 3, git: 'git' }

const NAME = /^[A-Za-z0-9._-]{1,100}$/

export function checkFolderName(name: string): void {
  if (!NAME.test(name) || name === '.' || name === '..' || /^\.+$/.test(name)) throw invalid('name must be one folder name made of letters, digits, ".", "_" or "-"')
}

/** Validate a clone URL: https only, no credentials, host on the allow-list. Returns the normalized URL. */
export function checkGitUrl(raw: string, allowedHosts: readonly string[]): string {
  if (/[\s\x00-\x1f\x7f]/.test(raw)) throw invalid('gitUrl contains whitespace or control characters')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalid('gitUrl is not a URL')
  }
  if (url.protocol !== 'https:') throw invalid('only https Git URLs are allowed')
  if (url.username !== '' || url.password !== '') throw invalid('gitUrl must not contain credentials')
  if (url.port !== '' && url.port !== '443') throw invalid('gitUrl must use the default https port')
  const host = url.hostname.toLowerCase()
  if (!allowedHosts.some(allowed => allowed.toLowerCase() === host)) {
    throw denied(`cloning from ${host} is not allowed; add the host on the DSH settings tab`)
  }
  if (url.search !== '' || url.hash !== '') throw invalid('gitUrl must not have a query or fragment')
  return url.toString()
}

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

export function gitCloneArgs(url: string): string[] {
  return [
    '-c', `core.hooksPath=${NULL_DEVICE}`,
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false',
    '-c', 'submodule.recurse=false',
    '-c', 'core.fsmonitor=false',
    'clone', '--no-recurse-submodules', '--quiet', '--', url, '.',
  ]
}

export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  // Keep only what git needs to find itself and a proxy; drop credentials and config overrides.
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO']) {
    const value = base[key]
    if (value !== undefined) env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_ASKPASS = ''
  env.SSH_ASKPASS = ''
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = NULL_DEVICE
  env.GIT_LFS_SKIP_SMUDGE = '1'
  return env
}

async function folderSize(path: string, limit: number): Promise<number> {
  let total = 0
  const stack = [path]
  while (stack.length > 0 && total <= limit) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        try {
          total += (await lstat(full)).size
        } catch {
          // file vanished while cloning
        }
      }
    }
  }
  return total
}

/** Run `git clone` into `dir` (which must exist and be empty). Rejects on failure, timeout or size overflow. */
export function runClone(url: string, dir: string, limits: CloneLimits, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // Own process group on POSIX so a kill also stops git's helpers (git-remote-https).
    const group = process.platform !== 'win32'
    const child = spawn(limits.git, gitCloneArgs(url), { cwd: dir, env: gitEnv(), shell: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: group })
    let stderr = ''
    let failure: OperationError | null = null
    const stop = (error: OperationError): void => {
      if (failure) return
      failure = error
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 4000) stderr += chunk.toString('utf8') })
    const timer = setTimeout(() => stop(new OperationError('unavailable', 'git clone timed out')), limits.timeoutMs)
    let sizing = false
    const sizer = setInterval(() => {
      if (sizing) return
      sizing = true
      folderSize(dir, limits.maxBytes).then((size) => {
        if (size > limits.maxBytes) stop(invalid(`the repository is larger than the ${Math.round(limits.maxBytes / 1024 ** 2)} MiB limit`))
      }).finally(() => { sizing = false })
    }, 1000)
    const onAbort = (): void => stop(new OperationError('unavailable', 'git clone was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    const done = (error: Error | null): void => {
      clearTimeout(timer)
      clearInterval(sizer)
      signal.removeEventListener('abort', onAbort)
      if (failure) reject(failure)
      else if (error) reject(error)
      else resolvePromise()
    }
    child.on('error', error => done(new OperationError('unavailable', `git could not be started: ${error.message}`)))
    child.on('close', (code) => {
      if (code === 0 || failure) done(null)
      else done(new OperationError('invalid_request', `git clone failed: ${redactLine(stderr || `exit code ${code}`, 500)}`))
    })
  })
}

function isInside(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/** Failed clones stay visible in workspaces.list this long. */
const FAILED_VISIBLE_MS = 24 * 60 * 60_000

export function failedSummary(record: WorkspaceCreationRecord): WorkspaceSummary {
  return {
    workspaceId: record.workspaceId ?? '',
    name: redactLine(record.name, 200),
    path: record.path,
    pinned: false,
    archived: false,
    untrusted: true,
    state: 'clone-failed',
    ...(record.message ? { stateMessage: record.message } : {}),
  }
}


/** Recent failed clones (no longer registered with DSH), for workspaces.list. */
export function failedClones(records: readonly WorkspaceCreationRecord[], now = Date.now()): WorkspaceSummary[] {
  return records.filter(record => record.state === 'clone-failed' && record.updatedAt >= now - FAILED_VISIBLE_MS).map(failedSummary)
}


export function createWorkspaceCreate(rt: Runtime, limits: CloneLimits = DEFAULT_CLONE_LIMITS) {
  const running = new Map<string, Promise<Result<'workspace.create'>>>()
  /** Background clones, so dispose() can stop them. */
  const clones = new Map<string, { controller: AbortController; done: Promise<void> }>()

  function summary(workspace: DshWorkspace, record?: WorkspaceCreationRecord): WorkspaceSummary {
    return {
      workspaceId: workspace.id,
      name: redactLine(workspace.title, 200),
      path: workspace.path,
      pinned: false,
      archived: false,
      untrusted: rt.deps.scope.isUntrustedWorkspace(workspace.id),
      state: record?.state ?? 'ready',
      ...(record?.message ? { stateMessage: record.message } : {}),
    }
  }

  async function save(record: WorkspaceCreationRecord, change: Partial<WorkspaceCreationRecord>): Promise<WorkspaceCreationRecord> {
    const next: WorkspaceCreationRecord = { ...record, ...change, updatedAt: Date.now() }
    await rt.creations.put(next)
    return next
  }

  /** Remove the folder and the DSH registration of a clone that did not finish. */
  async function cleanUp(record: WorkspaceCreationRecord, message: string): Promise<void> {
    const directory = record.directory
    let owned = false
    if (directory) {
      try {
        const placement = rt.deps.scope.resolvePlacement
          ? await rt.deps.scope.resolvePlacement(directory.placementId)
          : rt.deps.scope.placements().find(item => item.placementId === directory.placementId)
        if (placement?.path === directory.placementPath && await realpath(placement.path) === placement.path
          && record.path === join(placement.path, record.name) && await realpath(record.path) === record.path) {
          const current = await lstat(record.path, { bigint: true })
          owned = current.isDirectory() && current.dev.toString() === directory.dev && current.ino.toString() === directory.ino
        }
      } catch {
        // No destructive cleanup when the current placement or directory cannot be proved.
      }
    }
    if (owned) await rm(record.path, { recursive: true, force: true }).catch(() => undefined)
    if (record.workspaceId) await rt.workspaces?.delete(record.workspaceId).catch(() => false)
    await save(record, { state: 'clone-failed', message: redactLine(owned ? message : `${message}; the folder was kept because its ownership could not be verified`, 500) })
  }

  function startClone(record: WorkspaceCreationRecord, url: string): void {
    const controller = new AbortController()
    // Not tied to the request: the clone outlives the hub's request timeout.
    const done = runClone(url, record.path, limits, controller.signal)
      .then(async () => { await save(record, { state: 'ready' }) })
      .catch((error: unknown) => cleanUp(record, error instanceof Error ? error.message : String(error)))
      .catch((error: unknown) => rt.deps.logger.warn('Remora: recording the clone result failed', error))
      .finally(() => clones.delete(record.key))
    clones.set(record.key, { controller, done })
  }

  async function create(params: Params<'workspace.create'>, context: OperationContext): Promise<Result<'workspace.create'>> {
    const registry = rt.workspaces
    if (!registry) throw unavailable('DSH workspace registry is not available')
    const key = `${context.actor.clientId}\u0000${params.idempotencyKey}`
    const previous = rt.creations.list().find(record => record.key === key)
    if (previous) {
      if (previous.state === 'clone-failed') return { workspace: failedSummary(previous) }
      const workspace = previous.workspaceId ? registry.get(previous.workspaceId) : undefined
      if (workspace) return { workspace: summary(workspace, previous) }
      throw new OperationError('gone', 'the workspace created with this idempotencyKey was removed from DSH')
    }
    checkFolderName(params.name)
    const placement = rt.deps.scope.placements().find(item => item.placementId === params.placementId)
    if (!placement) throw notFound(`placement ${params.placementId} is not configured on DSH`)
    const url = params.gitUrl === undefined ? undefined : checkGitUrl(params.gitUrl, rt.deps.scope.gitHosts())
    let root: string
    try {
      root = rt.deps.scope.resolvePlacement
        ? (await rt.deps.scope.resolvePlacement(placement.placementId)).path
        : await realpath(placement.path)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'forbidden') throw denied('the placement folder is no longer allowed; check it on the DSH settings tab')
      throw unavailable('the placement folder is not available')
    }
    if (root !== placement.path) throw denied('the placement folder now resolves to a different folder; register its new location on the DSH settings tab')
    if (context.signal.aborted) throw unavailable('creating the workspace was cancelled')
    const target = join(root, params.name)
    if (!isInside(target, root)) throw denied('the folder would be outside the placement')
    try {
      await mkdir(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OperationError('conflict', `${params.name} already exists in this placement`)
      throw new OperationError('unavailable', `could not create the folder: ${(error as Error).message}`)
    }
    let real: string
    let workspace: DshWorkspace
    try {
      real = await realpath(target)
      if (rt.deps.scope.resolvePlacement) {
        try {
          if ((await rt.deps.scope.resolvePlacement(placement.placementId)).path !== root) throw new Error('changed placement')
        } catch {
          throw denied('the placement is no longer allowed; check it on the DSH settings tab')
        }
      }
      if (await realpath(placement.path) !== root) throw denied('the placement folder changed while creating the workspace')
      if (!isInside(real, root)) throw denied('the folder resolved outside the placement')
      try {
        workspace = (await registry.resolveByPath(real)) ?? await registry.create(real)
      } catch (error) {
        throw fromDsh(error, 'registering the workspace with DSH failed')
      }
    } catch (error) {
      // A replaced parent must not make cleanup remove an unrelated folder.
      if (await realpath(placement.path).catch(() => null) === root) await rmdir(target).catch(() => undefined)
      throw error instanceof OperationError ? error : new OperationError('internal', `creating the workspace failed: ${(error as Error).message}`)
    }
    // Untrusted before anyone can see it, so no prompt reaches a half-cloned repository.
    if (url) await rt.deps.scope.markUntrustedWorkspace(workspace.id)
    const identity = await lstat(real, { bigint: true })
    const now = Date.now()
    const record: WorkspaceCreationRecord = {
      key, workspaceId: workspace.id, path: real, name: params.name, state: url ? 'cloning' : 'ready', createdAt: now, updatedAt: now,
      directory: { placementId: placement.placementId, placementPath: root, dev: identity.dev.toString(), ino: identity.ino.toString() },
    }
    await rt.creations.put(record)
    if (url) {
      if (context.signal.aborted) {
        await cleanUp(record, 'creating the workspace was cancelled')
        throw unavailable('creating the workspace was cancelled')
      }
      startClone(record, url)
    }
    return { workspace: summary(workspace, record) }
  }

  return {
    handlers: {
      'workspace.create'(params: Params<'workspace.create'>, context: OperationContext): Promise<Result<'workspace.create'>> {
        const key = `${context.actor.clientId}\u0000${params.idempotencyKey}`
        const inFlight = running.get(key)
        if (inFlight) return inFlight
        const promise = create(params, context).finally(() => running.delete(key))
        running.set(key, promise)
        return promise
      },
    },
    /** A clone that was running when DSH stopped cannot resume: clean it up. */
    async recover(): Promise<void> {
      for (const record of rt.creations.list()) {
        if (record.state === 'cloning' && !clones.has(record.key)) await cleanUp(record, 'DSH stopped while the clone was running').catch(() => undefined)
      }
    },
    dispose(): void {
      for (const clone of clones.values()) clone.controller.abort()
    },
    async stop(): Promise<void> {
      await Promise.allSettled([...running.values()])
      const pending = [...clones.values()]
      for (const clone of pending) clone.controller.abort()
      await Promise.allSettled(pending.map(clone => clone.done))
    },
  }
}
