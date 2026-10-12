/**
 * remora — the Remora CLI. Drives DSH Web sessions through a self-hosted
 * Remora hub: OAuth login, the HTTP API (`POST /api/v1/ops/<operationId>`),
 * and a stdio MCP bridge.
 */
import { PROTOCOL_VERSION } from '@dsh-remora/protocol'
import { bool, parseArgs } from './args.ts'
import { makeCmd, printJson, type CommandDef } from './command.ts'
import type { Ctx } from './ctx.ts'
import { CliError, EXIT } from './errors.ts'
import { login, logout } from './commands/auth.ts'
import { attention, hosts, sessions, workspaces } from './commands/read.ts'
import { answer, patch, run, tasks } from './commands/tasks.ts'
import { doctor, mcp, NOT_YET, selfUpdateCommand } from './commands/misc.ts'
import { cleanupOldBinary } from './selfupdate.ts'
import { CLI_VERSION } from './version.ts'

export { CLI_VERSION } from './version.ts'
export type { Ctx } from './ctx.ts'
/** @deprecated use Ctx */
export type Io = Ctx

export const COMMANDS: readonly CommandDef[] = [
  login, logout, hosts, sessions, tasks, run, attention, answer, patch, workspaces, doctor, mcp, selfUpdateCommand, ...NOT_YET,
]

const EXIT_CODE_HELP = [
  '終了コード:',
  '  0 成功 / 1 失敗（タスクの失敗・取り消しを含む） / 2 未対応の機能 / 3 人の判断待ちで停止',
  '  4 未ログイン・ログイン切れ / 5 権限で拒否 / 6 見つからない / 7 ハブやホストに届かない',
  '  8 待機の打ち切り / 64 使い方の誤り / 130 待機中の Ctrl-C（タスクは続行）',
]

function help(ctx: Ctx): void {
  ctx.out(`remora ${CLI_VERSION} — DSH を外から操作する Remora の CLI（非公式）`)
  ctx.out('')
  ctx.out('使い方: remora <コマンド> [オプション]')
  ctx.out('')
  for (const c of COMMANDS) ctx.out(`  ${c.name.padEnd(12)} ${c.summary}`)
  ctx.out(`  ${'help'.padEnd(12)} この説明（remora help <コマンド> で詳しく）`)
  ctx.out(`  ${'--version'.padEnd(12)} 版を表示する`)
  ctx.out('')
  ctx.out('共通オプション: --json（機械向けの JSON を出す）、--hub <URL>（保存したハブの代わりに使う）、--help')
  ctx.out('環境変数: REMORA_HUB_URL、REMORA_TOKEN（個人トークン）、REMORA_CONFIG_DIR、REMORA_TOKEN_STORE=file')
  ctx.out('')
  for (const line of EXIT_CODE_HELP) ctx.out(line)
}

function commandHelp(ctx: Ctx, c: CommandDef): void {
  ctx.out(`remora ${c.name} — ${c.summary}`)
  ctx.out('')
  for (const line of c.usage) ctx.out(line)
  ctx.out('')
  ctx.out('共通オプション: --json、--hub <URL>')
}

function report(ctx: Ctx, json: boolean, error: CliError): void {
  if (json) {
    printJson(ctx, { error: { code: error.detail.code ?? 'error', message: error.message, ...(error.detail.fix ? { fix: error.detail.fix } : {}), ...(error.detail.hint ? { hint: error.detail.hint } : {}), ...(error.detail.denial ? { denial: error.detail.denial } : {}), exitCode: error.exitCode } })
    return
  }
  ctx.err(`remora: ${error.message}`)
  if (error.detail.hint) ctx.err(error.detail.hint)
  if (error.detail.fix) ctx.err(`直す場所: ${error.detail.fix}`)
}

export async function main(argv: readonly string[], ctx: Ctx): Promise<number> {
  const [name, ...rest] = argv
  if (ctx.isSea && ctx.platform === 'win32') await cleanupOldBinary(ctx.execPath)
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    const topic = name === 'help' ? COMMANDS.find(c => c.name === rest[0]) : undefined
    if (topic) commandHelp(ctx, topic)
    else help(ctx)
    return EXIT.ok
  }
  if (name === '--version' || name === '-v' || name === 'version') {
    if (rest.includes('--json')) printJson(ctx, { version: CLI_VERSION, protocol: PROTOCOL_VERSION, platform: ctx.platform, arch: ctx.arch })
    else ctx.out(CLI_VERSION)
    return EXIT.ok
  }
  const command = COMMANDS.find(c => c.name === name)
  const json = rest.includes('--json')
  if (!command) {
    report(ctx, json, new CliError(`不明なコマンドです: ${name}`, EXIT.usage, { code: 'usage', hint: 'remora help で使えるコマンドを確認できます。' }))
    return EXIT.usage
  }
  try {
    const args = parseArgs(rest, command.flags)
    if (bool(args, 'help')) { commandHelp(ctx, command); return EXIT.ok }
    return await command.run(makeCmd(ctx, args))
  } catch (error) {
    if (error instanceof CliError) {
      report(ctx, json, error)
      if (error.exitCode === EXIT.usage && !json && error.detail.code === 'usage') ctx.err(`remora help ${command.name} で使い方を確認できます。`)
      return error.exitCode
    }
    report(ctx, json, new CliError(`予期しないエラー: ${(error as Error)?.stack ?? String(error)}`, EXIT.failure, { code: 'internal' }))
    return EXIT.failure
  }
}
