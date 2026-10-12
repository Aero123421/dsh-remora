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
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { OperationParams, OperationResults, WorkspaceSummary } from '@dsh-remora/protocol'
import type { OperationContext } from '../ops/types.ts'
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

export function createWorkspaceCreate(rt: Runtime, limits: CloneLimits = DEFAULT_CLONE_LIMITS) {
  /** idempotencyKey (+client) -> workspace id, for the life of the process. */
  const done = new Map<string, string>()
  const running = new Map<string, Promise<Result<'workspace.create'>>>()

  function summary(workspace: DshWorkspace): WorkspaceSummary {
    return {
      workspaceId: workspace.id,
      name: redactLine(workspace.title, 200),
      path: workspace.path,
      pinned: false,
      archived: false,
      untrusted: rt.deps.scope.isUntrustedWorkspace(workspace.id),
    }
  }

  async function create(params: Params<'workspace.create'>, context: OperationContext): Promise<Result<'workspace.create'>> {
    const registry = rt.workspaces
    if (!registry) throw unavailable('DSH workspace registry is not available')
    const key = `${context.actor.clientId}\u0000${params.idempotencyKey}`
    const previous = done.get(key)
    if (previous) {
      const workspace = registry.get(previous)
      if (workspace) return { workspace: summary(workspace) }
    }
    checkFolderName(params.name)
    const placement = rt.deps.scope.placements().find(item => item.placementId === params.placementId)
    if (!placement) throw notFound(`placement ${params.placementId} is not configured on DSH`)
    const url = params.gitUrl === undefined ? undefined : checkGitUrl(params.gitUrl, rt.deps.scope.gitHosts())
    let root: string
    try {
      root = await realpath(placement.path)
    } catch {
      throw unavailable('the placement folder does not exist')
    }
    const target = join(root, params.name)
    if (!isInside(target, root)) throw denied('the folder would be outside the placement')
    try {
      await mkdir(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new OperationError('conflict', `${params.name} already exists in this placement`)
      throw new OperationError('unavailable', `could not create the folder: ${(error as Error).message}`)
    }
    let real: string
    try {
      real = await realpath(target)
      if (!isInside(real, root)) throw denied('the folder resolved outside the placement')
      if (url) await runClone(url, real, limits, context.signal)
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined)
      throw error instanceof OperationError ? error : new OperationError('internal', `creating the workspace failed: ${(error as Error).message}`)
    }
    let workspace: DshWorkspace
    try {
      workspace = (await registry.resolveByPath(real)) ?? await registry.create(real)
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined)
      throw fromDsh(error, 'registering the workspace with DSH failed')
    }
    if (url) await rt.deps.scope.markUntrustedWorkspace(workspace.id)
    done.set(key, workspace.id)
    return { workspace: summary(workspace) }
  }

  return {
    'workspace.create'(params: Params<'workspace.create'>, context: OperationContext): Promise<Result<'workspace.create'>> {
      const key = `${context.actor.clientId}\u0000${params.idempotencyKey}`
      const inFlight = running.get(key)
      if (inFlight) return inFlight
      const promise = create(params, context).finally(() => running.delete(key))
      running.set(key, promise)
      return promise
    },
  }
}
