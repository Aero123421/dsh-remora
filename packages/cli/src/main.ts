/**
 * remora — the Remora CLI.
 *
 * P0 scaffold: argument handling, `--version`, `help` and `doctor`. The other
 * commands are listed with the phase they arrive in, so the surface is
 * visible from day one.
 */
import { PROTOCOL_VERSION } from '@dsh-remora/protocol'
import { configDir } from './config.ts'

declare const __REMORA_VERSION__: string | undefined
export const CLI_VERSION: string = typeof __REMORA_VERSION__ === 'string' ? __REMORA_VERSION__ : '0.0.0-dev'

export interface Io {
  out(line: string): void
  err(line: string): void
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  nodeVersion: string
}

const PLANNED: Readonly<Record<string, { phase: 'P0' | 'P1' | 'P2'; summary: string }>> = {
  login: { phase: 'P0', summary: 'ハブにログインする（--device で SSH 先からも）' },
  hosts: { phase: 'P0', summary: 'つながっている DSH ホストを表示する' },
  sessions: { phase: 'P0', summary: 'セッションを一覧・表示する（ls / show / read）' },
  tasks: { phase: 'P0', summary: 'タスクを投入・確認・待機する（start / status / wait / watch）' },
  run: { phase: 'P0', summary: 'タスクを投入して完了まで待つ（--wait）' },
  attention: { phase: 'P0', summary: '人の判断待ちを表示する' },
  mcp: { phase: 'P0', summary: 'ローカルの MCP クライアント向け stdio ブリッジ' },
  answer: { phase: 'P1', summary: 'AI からの質問に答える' },
  patch: { phase: 'P1', summary: '変更差分を取り出してローカルに適用する' },
  open: { phase: 'P1', summary: 'セッションを DSH Web で開く' },
  workspaces: { phase: 'P1', summary: 'ワークスペースを作る' },
  'self-update': { phase: 'P1', summary: 'GitHub Releases から自己更新する' },
}

function help(io: Io): void {
  io.out(`remora ${CLI_VERSION} — DSH を外から操作する Remora の CLI（非公式）`)
  io.out('')
  io.out('使い方: remora <コマンド> [オプション]')
  io.out('')
  io.out('  help             この説明を表示する')
  io.out('  doctor           環境と設定を確認する')
  io.out('  --version        版を表示する')
  for (const [name, { phase, summary }] of Object.entries(PLANNED)) io.out(`  ${name.padEnd(16)} ${summary}（${phase} で追加予定）`)
  io.out('')
  io.out('すべてのコマンドに --json を付けられます（追加予定）。')
}

function doctor(io: Io): number {
  const [major = 0, minor = 0] = io.nodeVersion.replace(/^v/, '').split('.').map(Number)
  const nodeOk = major > 22 || (major === 22 && minor >= 19)
  io.out(`remora      ${CLI_VERSION} (protocol ${PROTOCOL_VERSION})`)
  io.out(`node        ${io.nodeVersion} ${nodeOk ? 'ok' : '— 22.19 以上が必要です'}`)
  io.out(`platform    ${io.platform}`)
  io.out(`config      ${configDir(io.env, io.platform)}`)
  io.out('hub         未設定（remora login で設定します。P0 で追加予定）')
  return nodeOk ? 0 : 1
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [command] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') { help(io); return 0 }
  if (command === '--version' || command === '-v') { io.out(CLI_VERSION); return 0 }
  if (command === 'doctor') return doctor(io)
  const planned = PLANNED[command]
  if (planned) {
    io.err(`remora ${command}: まだ実装されていません（${planned.phase} で追加予定）。`)
    return 2
  }
  io.err(`remora: 不明なコマンドです: ${command}`)
  io.err('remora help で使えるコマンドを確認できます。')
  return 64
}
