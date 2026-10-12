/**
 * remora terminal: one shell command in a workspace folder on a DSH host.
 * It never runs at once: the hub parks it, the owner reviews it on the hub
 * and confirms it with a passkey, then this command collects the output.
 */
import { TASK_WAIT_MAX_MS, type ConfirmationInfo, type TerminalRunOutput } from '@dsh-remora/protocol'
import { bool, str } from '../args.ts'
import { hubLink } from '../attention.ts'
import { hostParam, hubOf, printJson, type Cmd, type CommandDef } from '../command.ts'
import { CliError, EXIT, exitCodeForError, usageError } from '../errors.ts'
import { clean, fmtElapsed, parseDuration } from '../format.ts'
import type { Hub } from '../hub.ts'

const STATE_LABEL: Readonly<Record<string, string>> = {
  pending: 'ハブでのパスキー確認待ち', running: 'ホストで実行中', done: '完了', failed: '失敗', denied: 'オーナーが拒否', expired: '確認されないまま期限切れ',
}

const settled = (info: ConfirmationInfo) => info.state !== 'pending' && info.state !== 'running'

/** Poll confirmation.get until it settles, the wait runs out, or Ctrl-C. */
async function waitFor(cmd: Cmd, hub: Hub, first: ConfirmationInfo, limitMs: number | null): Promise<{ info: ConfirmationInfo; timedOut: boolean }> {
  const { ctx } = cmd
  const started = ctx.now()
  let info = first
  let last = ''
  const report = () => {
    if (!cmd.json && info.state !== last) ctx.err(`${STATE_LABEL[info.state] ?? info.state}…`)
    last = info.state
  }
  report()
  const onInterrupt = () => {
    ctx.err(`待機をやめました。確認と実行はハブ側で続きます: remora terminal status ${info.confirmationId}`)
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
      info = await hub.op('confirmation.get', { confirmationId: info.confirmationId, timeoutMs: Math.max(0, Math.round(step)) }, step + 20_000)
      report()
      if (!settled(info) && ctx.now() - callStarted < 1000) await ctx.sleep(2000)
    }
  } finally {
    process.off('SIGINT', onInterrupt)
  }
}

/** Print the outcome and pick the exit code. */
function finish(cmd: Cmd, info: ConfirmationInfo, timedOut: boolean): number {
  const output = info.state === 'done' ? (info.result as TerminalRunOutput | undefined) : undefined
  if (cmd.json) {
    printJson(cmd.ctx, { ...info, ...(timedOut ? { timedOut: true } : {}) })
  } else if (timedOut) {
    cmd.ctx.err(`待機を打ち切りました（${STATE_LABEL[info.state] ?? info.state}）。続けて待つ: remora terminal status ${info.confirmationId} --wait`)
  } else if (output) {
    cmd.ctx.err('（以下は DSH ホストで実行したコマンドの出力です。シークレットらしい文字列は伏せてあります）')
    if (output.stdout) cmd.ctx.out(clean(output.stdout, true).replace(/\n$/, ''))
    if (output.stderr) cmd.ctx.err(clean(output.stderr, true).replace(/\n$/, ''))
    if (output.truncated) cmd.ctx.err('（出力が長いため一部を省きました）')
    const status = output.timedOut ? 'タイムアウトで止めました' : output.exitCode === null ? `シグナル ${output.signal ?? '?'} で終了` : `終了コード ${output.exitCode}`
    cmd.ctx.err(`${status}（${fmtElapsed(output.durationMs)}）`)
  } else if (info.state === 'done') {
    cmd.ctx.err('完了しましたが、出力はもうありません（ハブは 1 時間で消します）。')
  } else if (info.state === 'failed') {
    cmd.ctx.err(`実行できませんでした: ${clean(info.error?.message ?? '理由は不明です')}`)
  } else {
    cmd.ctx.err(`${STATE_LABEL[info.state] ?? info.state}。`)
  }
  if (timedOut) return EXIT.timeout
  switch (info.state) {
    case 'done': return !output ? EXIT.notFound : output.exitCode === 0 && !output.timedOut ? EXIT.ok : EXIT.failure
    case 'denied': return EXIT.denied
    case 'expired': return EXIT.timeout
    case 'failed': return info.error ? exitCodeForError(info.error.code) : EXIT.failure
    default: return EXIT.failure
  }
}

function waitLimit(cmd: Cmd): number | null {
  const raw = str(cmd.args, 'wait-timeout')
  if (raw === undefined) return null
  const ms = parseDuration(raw)
  if (ms === null) throw usageError('--wait-timeout は 90s、10m のように指定してください。')
  return ms
}

export const terminal: CommandDef = {
  name: 'terminal',
  summary: 'ワークスペースのフォルダでコマンドを 1 回実行する（ハブでパスキー確認）',
  usage: [
    'remora terminal run --workspace <ID> [--timeout 60s] [--no-wait] [--wait-timeout 15m] [--host <ID>] -- <コマンド>',
    'remora terminal status <確認 ID> [--wait] [--wait-timeout 15m]',
    '',
    'コマンドはすぐには動きません。ハブが確認用の URL を出すので、オーナーがその画面で内容を確かめ、パスキーで確認すると',
    'DSH ホストのワークスペースのフォルダで 1 回だけ実行され、出力がここに返ります（確認の期限は 10 分）。',
    'DSH のサンドボックスの外で、DSH と同じユーザーとして動きます（macOS・Linux は sh -c、Windows は cmd /c）。',
    'DSH 側の上限とハブでの付与がどちらも「リモート全権」で、dsh.admin スコープ（remora login --admin）が必要です。',
    '--timeout はコマンド自体の制限時間（1 秒〜10 分、既定 60 秒）。出力は 64 KB まで、シークレットらしい文字列は伏せられます。',
    '終了コード: コマンドが 0 で終われば 0、それ以外は 1。拒否は 5、確認されないまま期限切れや待機の打ち切りは 8。',
  ],
  flags: { host: 'string', workspace: 'string', timeout: 'string', 'no-wait': 'bool', wait: 'bool', 'wait-timeout': 'string' },
  async run(cmd) {
    const sub = cmd.args.positionals[0]
    if (sub === 'status') {
      const confirmationId = cmd.args.positionals[1]
      if (!confirmationId) throw usageError('確認 ID を指定してください: remora terminal status <確認 ID>')
      const hub = await hubOf(cmd)
      const info = await hub.op('confirmation.get', { confirmationId })
      if (!bool(cmd.args, 'wait')) {
        if (cmd.json) { printJson(cmd.ctx, info); return EXIT.ok }
        if (!settled(info)) {
          cmd.ctx.out(`${STATE_LABEL[info.state] ?? info.state}`)
          const url = info.state === 'pending' ? hubLink(hub.url, info.confirmUrl) : null
          if (url) cmd.ctx.out(`確認する場所: ${url}`)
          return EXIT.ok
        }
        return finish(cmd, info, false)
      }
      const { info: final, timedOut } = await waitFor(cmd, hub, info, waitLimit(cmd))
      return finish(cmd, final, timedOut)
    }
    if (sub !== 'run') throw usageError(sub === undefined ? 'remora terminal run --workspace <ID> -- <コマンド> の形で指定してください。' : `不明なサブコマンドです: terminal ${sub}`)
    const command = cmd.args.positionals.slice(1).join(' ').trim()
    if (!command) throw usageError('実行するコマンドを -- の後に指定してください: remora terminal run --workspace <ID> -- git status')
    const cwdWorkspaceId = str(cmd.args, 'workspace')
    if (!cwdWorkspaceId) throw usageError('--workspace でワークスペース ID を指定してください（remora workspaces ls で確認できます）。')
    let timeoutMs: number | undefined
    const rawTimeout = str(cmd.args, 'timeout')
    if (rawTimeout !== undefined) {
      const ms = parseDuration(rawTimeout)
      if (ms === null || ms < 1000 || ms > 600_000) throw usageError('--timeout は 1s〜10m で指定してください。')
      timeoutMs = ms
    }
    const hub = await hubOf(cmd)
    // Through the hub the result is always the parked request, never the output itself.
    const parked = (await hub.op('terminal.run', { ...hostParam(cmd), command, cwdWorkspaceId, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })) as unknown as ConfirmationInfo
    if (typeof parked?.confirmationId !== 'string') throw new CliError('ハブの応答に確認 ID がありません。ハブを更新してください。', EXIT.failure, { code: 'bad_response' })
    const url = hubLink(hub.url, parked.confirmUrl)
    if (bool(cmd.args, 'no-wait')) {
      if (cmd.json) { printJson(cmd.ctx, parked); return EXIT.ok }
      cmd.ctx.out(`確認 ID: ${parked.confirmationId}`)
      if (url) cmd.ctx.out(`ハブでパスキーで確認してください: ${url}`)
      cmd.ctx.out(`結果: remora terminal status ${parked.confirmationId} --wait`)
      return EXIT.ok
    }
    if (!cmd.json && url) {
      cmd.ctx.err('ハブでパスキーで確認してください（10 分以内）:')
      cmd.ctx.err(`  ${url}`)
    }
    const { info, timedOut } = await waitFor(cmd, hub, parked, waitLimit(cmd))
    return finish(cmd, info, timedOut)
  },
}
