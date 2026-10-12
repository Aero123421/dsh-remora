// Child process bookkeeping for the harness. Every long-running process is
// started in its own process group (POSIX) so stopping it also stops what it
// spawned (pnpm, workerd, esbuild...). Stopping is SIGTERM to the group, then
// SIGKILL after a grace period. An exit hook kills whatever is still alive,
// so a crash or Ctrl-C never leaves orphans listening on the E2E ports.
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'

const isWindows = process.platform === 'win32'
const live = new Set()

function killTree(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* already gone */ }
  }
}

// Last resort: synchronous, so it also runs from process.on('exit').
process.on('exit', () => { for (const proc of live) killTree(proc.child, 'SIGKILL') })

/**
 * Environment for child processes: the parent's, minus the variables a
 * package-manager script runner injects (they would leak into DSH's own pnpm
 * calls), plus `extra`.
 */
export function childEnv(extra = {}) {
  const keep = new Set(['npm_config_registry', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_cafile', 'npm_config_strict_ssl'])
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_/i.test(key) && !keep.has(key.toLowerCase())) continue
    if (key === 'PNPM_SCRIPT_SRC_DIR' || key === 'INIT_CWD') continue
    env[key] = value
  }
  return { ...env, ...extra }
}

/**
 * Start a long-running process. Output goes to `logFile` and to an in-memory
 * tail used for readiness checks and failure reports.
 * @returns {Proc}
 */
export function start(name, command, args, { cwd, env, logFile } = {}) {
  const child = spawn(command, args, { cwd, env, detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : undefined
  log?.write(`$ ${[command, ...args].join(' ')}\n# cwd ${cwd ?? process.cwd()}\n`)
  const proc = new Proc(name, child, log)
  live.add(proc)
  child.once('exit', (code, signal) => {
    live.delete(proc)
    log?.write(`\n# exited code=${code} signal=${signal}\n`)
    log?.end()
  })
  return proc
}

export class Proc {
  constructor(name, child, log) {
    this.name = name
    this.child = child
    this.output = ''
    this.listeners = new Set()
    this.exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    child.once('error', error => { this.append(`\n[spawn error] ${error.message}\n`) })
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', text => { log?.write(text); this.append(text) })
    }
  }

  append(text) {
    this.output = (this.output + text).slice(-200_000)
    for (const listener of this.listeners) listener()
  }

  get running() { return this.child.exitCode === null && this.child.signalCode === null }

  tail(lines = 40) { return this.output.split('\n').slice(-lines).join('\n') }

  /** Resolve with the first match of `pattern` in the output; reject on exit or timeout. */
  waitFor(pattern, timeoutMs, what = String(pattern)) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const match = pattern.exec(this.output)
        if (match) { done(); resolve(match) }
      }
      const timer = setTimeout(() => { done(); reject(new Error(`${this.name}: timed out after ${timeoutMs} ms waiting for ${what}\n--- last output ---\n${this.tail()}`)) }, timeoutMs)
      const onExit = ({ code, signal }) => { done(); reject(new Error(`${this.name} exited (code=${code} signal=${signal}) before ${what}\n--- last output ---\n${this.tail()}`)) }
      const done = () => { clearTimeout(timer); this.listeners.delete(check) }
      this.listeners.add(check)
      void this.exited.then(result => { if (this.listeners.has(check)) onExit(result) })
      check()
    })
  }

  /** SIGTERM the process group, SIGKILL after `graceMs`. */
  async stop(graceMs = 8000) {
    if (!this.running) return this.exited
    killTree(this.child, 'SIGTERM')
    const timer = setTimeout(() => killTree(this.child, 'SIGKILL'), graceMs)
    try { return await this.exited } finally { clearTimeout(timer) }
  }
}

/** Run a command to completion; output is appended to `logFile`. */
export async function run(name, command, args, { cwd, env, logFile, timeoutMs = 300_000 } = {}) {
  const proc = start(name, command, args, { cwd, env, logFile })
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { void proc.stop(2000); reject(new Error(`${name}: timed out after ${timeoutMs} ms\n${proc.tail()}`)) }, timeoutMs)
  })
  try {
    const { code, signal } = await Promise.race([proc.exited, timeout])
    if (code !== 0) throw new Error(`${name} failed (code=${code} signal=${signal})\n--- last output ---\n${proc.tail()}`)
    return proc.output
  } finally { clearTimeout(timer) }
}

/** Stop every process still alive (used by the harness's cleanup). */
export async function stopAll() {
  await Promise.all([...live].map(proc => proc.stop()))
}
