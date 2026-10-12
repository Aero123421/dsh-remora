/**
 * Requests the hub parks until the owner confirms them on the hub
 * (terminal.run, and the maintenance commands): show where to confirm, then
 * poll confirmation.get in ≤ 25 s steps until it settles.
 */
import { TASK_WAIT_MAX_MS, type ConfirmationInfo } from '@dsh-remora/protocol'
import { str } from './args.ts'
import { hubLink } from './attention.ts'
import type { Cmd } from './command.ts'
import { CliError, EXIT, exitCodeForError, usageError } from './errors.ts'
import { clean, parseDuration } from './format.ts'
import type { Hub } from './hub.ts'

export const CONFIRMATION_STATE_LABEL: Readonly<Record<string, string>> = {
  pending: 'ハブでのパスキー確認待ち', running: '実行中', done: '完了', failed: '失敗', denied: 'オーナーが拒否', expired: '確認されないまま期限切れ',
}

export const settled = (info: ConfirmationInfo) => info.state !== 'pending' && info.state !== 'running'

/** A ConfirmationInfo from the hub, or a clear error for a hub too old to park requests. */
export function asConfirmation(value: unknown): ConfirmationInfo {
  const info = value as Partial<ConfirmationInfo> | null
  if (!info || typeof info.confirmationId !== 'string' || typeof info.state !== 'string') throw new CliError('ハブの応答に確認 ID がありません。ハブを更新してください。', EXIT.failure, { code: 'bad_response' })
  return info as ConfirmationInfo
}

/** `--wait-timeout 15m`, or no limit. */
export function waitLimit(cmd: Cmd): number | null {
  const raw = str(cmd.args, 'wait-timeout')
  if (raw === undefined) return null
  const ms = parseDuration(raw)
  if (ms === null) throw usageError('--wait-timeout は 90s、10m のように指定してください。')
  return ms
}

/** Tell the user where to confirm (stderr, so stdout stays the result). */
export function showConfirmUrl(cmd: Cmd, hub: Hub, info: ConfirmationInfo, what: string): void {
  if (cmd.json) return
  const url = hubLink(hub.url, info.confirmUrl)
  cmd.ctx.err(`${what}には、ハブでオーナーの承認が要ります（10 分以内）:`)
  cmd.ctx.err(`  ${url ?? `${hub.url}/attention`}`)
}

/** Poll until the request settles, the wait runs out, or Ctrl-C (which leaves it waiting on the hub). */
export async function waitForConfirmation(cmd: Cmd, hub: Hub, first: ConfirmationInfo, limitMs: number | null, resume: string): Promise<{ info: ConfirmationInfo; timedOut: boolean }> {
  const { ctx } = cmd
  const started = ctx.now()
  let info = first
  let last = ''
  const report = () => {
    if (!cmd.json && info.state !== last) ctx.err(`${CONFIRMATION_STATE_LABEL[info.state] ?? info.state}…`)
    last = info.state
  }
  report()
  const onInterrupt = () => {
    ctx.err(`待機をやめました。ハブ側では続いています: ${resume}`)
    process.exit(130)
  }
  process.once('SIGINT', onInterrupt)
  try {
    for (;;) {
      if (settled(info)) return { info, timedOut: false }
      const elapsed = ctx.now() - started
      if (limitMs !== null && elapsed >= limitMs) return { info, timedOut: true }
      const step = Math.min(TASK_WAIT_MAX_MS, limitMs === null ? TASK_WAIT_MAX_MS : limitMs - elapsed)
      const callStarted = ctx.now()
      info = asConfirmation(await hub.op('confirmation.get', { confirmationId: info.confirmationId, timeoutMs: Math.max(0, Math.round(step)) }, step + 20_000))
      report()
      if (!settled(info) && ctx.now() - callStarted < 1000) await ctx.sleep(2000)
    }
  } finally {
    process.off('SIGINT', onInterrupt)
  }
}

/**
 * For requests that are not done: say what happened and pick the exit code
 * (denied 5, expired or wait cut 8, failed by its error). Null when done.
 */
export function unsettledExit(cmd: Cmd, info: ConfirmationInfo, timedOut: boolean, resume: string): number | null {
  if (timedOut) {
    if (cmd.json) cmd.ctx.out(JSON.stringify({ ...info, timedOut: true }, null, 2))
    else cmd.ctx.err(`待機を打ち切りました（${CONFIRMATION_STATE_LABEL[info.state] ?? info.state}）。続けて待つ: ${resume}`)
    return EXIT.timeout
  }
  if (info.state === 'done') return null
  if (cmd.json) cmd.ctx.out(JSON.stringify(info, null, 2))
  else if (info.state === 'failed') cmd.ctx.err(`できませんでした: ${clean(info.error?.message ?? '理由は不明です')}`)
  else cmd.ctx.err(`${CONFIRMATION_STATE_LABEL[info.state] ?? info.state}。`)
  switch (info.state) {
    case 'denied': return EXIT.denied
    case 'expired': return EXIT.timeout
    case 'failed': return info.error ? exitCodeForError(info.error.code) : EXIT.failure
    default: return EXIT.failure
  }
}
