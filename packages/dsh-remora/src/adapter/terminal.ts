/**
 * terminal.run: one shell command in a workspace folder, through DSH's own
 * subprocess service (`ctx.subprocess`), so the child gets DSH's scrubbed
 * environment (no credential-shaped variables, no DSH_* names).
 *
 * The core only lets this run with full remote access AND the owner's
 * passkey confirmation of these exact params (see core/dispatch.ts). The
 * command runs as the DSH user, outside DSH's sandbox, like a terminal the
 * owner opened. Output is redacted and capped like every other text Remora
 * sends out.
 */
import type { OperationParams, OperationResults } from '@dsh-remora/protocol'
import type { OperationContext } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redactTruncate } from '../redact.ts'
import type { DshSubprocess } from './dsh-types.ts'
import { SERVICES } from './dsh-types.ts'
import { fromDsh, unavailable } from './errors.ts'
import { realpathOrNull, type Runtime } from './runtime.ts'

type Params<Op extends keyof OperationParams> = OperationParams[Op]
type Result<Op extends keyof OperationResults> = OperationResults[Op]

export const DEFAULT_TERMINAL_TIMEOUT_MS = 60_000
/** Kept per stream in memory, and the most sent back per stream. */
const OUTPUT_MAX_BYTES = 64_000

export function createTerminal(rt: Runtime) {
  async function shellArgv(subprocess: DshSubprocess, command: string, signal: AbortSignal): Promise<string[]> {
    const environment = await subprocess.terminalEnvironment(signal)
    if (environment.platform === 'windows') return [await subprocess.resolveExecutable('cmd.exe', undefined, signal), '/d', '/s', '/c', command]
    const shell = await subprocess.resolveExecutable(environment.defaultShell ?? '/bin/sh', undefined, signal)
    return [shell, '-c', command]
  }

  return {
    async 'terminal.run'(params: Params<'terminal.run'>, context: OperationContext): Promise<Result<'terminal.run'>> {
      const workspace = rt.workspace(params.cwdWorkspaceId)
      const state = rt.workspaceState(workspace.id)
      if (state === 'cloning' || state === 'clone-failed') throw new OperationError('conflict', `workspace ${workspace.id} is not ready (${state})`)
      const cwd = await realpathOrNull(workspace.path)
      if (!cwd) throw unavailable(`the folder of workspace ${workspace.id} no longer exists`)
      const subprocess = rt.get<DshSubprocess>(SERVICES.subprocess)
      if (!subprocess || typeof subprocess.spawn !== 'function') throw unavailable('DSH cannot run commands here (no subprocess service)')
      const timeoutMs = params.timeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS
      const timeout = AbortSignal.timeout(timeoutMs)
      const signal = AbortSignal.any([context.signal, timeout])
      const started = Date.now()
      let outcome: { exitCode: number | null; signal: string | null }
      let stdout = { text: '', lossy: false }
      let stderr = { text: '', lossy: false }
      try {
        const argv = await shellArgv(subprocess, params.command, signal)
        const handle = subprocess.spawn({
          argv,
          cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: OUTPUT_MAX_BYTES }, stderr: { maxBytes: OUTPUT_MAX_BYTES } },
          graceMs: 2_000,
          signal,
        })
        outcome = await handle.done
        stdout = handle.collected.stdout?.readFrom(0) ?? stdout
        stderr = handle.collected.stderr?.readFrom(0) ?? stderr
      } catch (error) {
        if (context.signal.aborted) throw error
        throw fromDsh(error, 'the command could not be run')
      }
      const out = redactTruncate(stdout.text, OUTPUT_MAX_BYTES)
      const errText = redactTruncate(stderr.text, OUTPUT_MAX_BYTES)
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: timeout.aborted,
        stdout: out.text,
        stderr: errText.text,
        truncated: stdout.lossy || stderr.lossy || out.truncated || errText.truncated,
        durationMs: Date.now() - started,
        untrusted: true,
      }
    },
  }
}
