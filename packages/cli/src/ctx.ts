/**
 * Everything the CLI touches in the outside world goes through `Ctx`, so the
 * tests can run every command against a fake hub without a real terminal,
 * browser, keychain or clock.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface ExecOptions { input?: string; cwd?: string; timeoutMs?: number }

export interface Ctx {
  /** One line to stdout. */
  out(line: string): void
  /** One line to stderr. */
  err(line: string): void
  /** Raw text to stderr (progress lines with `\r`). */
  errWrite(text: string): void
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: string
  nodeVersion: string
  cwd: string
  /** Path of the running executable (the binary when `isSea`). */
  execPath: string
  /** True when running as a Node single executable application. */
  isSea: boolean
  stdin: NodeJS.ReadableStream
  stdinIsTTY: boolean
  stderrIsTTY: boolean
  fetch: typeof fetch
  now(): number
  sleep(ms: number): Promise<void>
  /** Try to open a URL in the user's browser. Resolves false when it could not. */
  openBrowser(url: string): Promise<boolean>
  /** Run a program without a shell. A missing program resolves with code 127. */
  exec(command: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>
  /** Ask a yes/no question on the terminal. */
  confirm(question: string): Promise<boolean>
}

export function exec(command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let timer: NodeJS.Timeout | undefined
    if (options.timeoutMs) timer = setTimeout(() => child.kill(), options.timeoutMs)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', error => { if (timer) clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr || String(error) }) })
    child.on('close', code => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }) })
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })
}

export async function openBrowser(url: string, platform: NodeJS.Platform, run = exec): Promise<boolean> {
  // No shell anywhere: the URL contains `&`.
  const attempt = platform === 'darwin' ? ['open', [url]] as const
    : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] as const
    : ['xdg-open', [url]] as const
  const result = await run(attempt[0], attempt[1], { timeoutMs: 10_000 })
  return result.code === 0
}

function isSea(): boolean {
  try {
    // Works from both the ESM bundle and the CommonJS SEA build.
    const sea = process.getBuiltinModule('node:sea') as { isSea?: () => boolean } | undefined
    return sea?.isSea?.() === true
  } catch {
    return false
  }
}

export function defaultCtx(): Ctx {
  return {
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
    errWrite: text => process.stderr.write(text),
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    cwd: process.cwd(),
    execPath: process.execPath,
    isSea: isSea(),
    stdin: process.stdin,
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    openBrowser: url => openBrowser(url, process.platform),
    exec,
    confirm: question => new Promise(resolve => {
      if (process.stdin.isTTY !== true) { resolve(false); return }
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      rl.question(`${question} [y/N] `, answer => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())) })
    }),
  }
}

export async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let text = ''
  stream.setEncoding('utf8')
  for await (const chunk of stream) text += chunk as string
  return text
}
