import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TASK_WAIT_MAX_MS, TERMINAL_TASK_STATES, type TaskInfo, type TaskTarget } from '@dsh-remora/protocol'
import { bool, list, str, type FlagSpec } from '../args.ts'
import { hostParam, hubOf, printJson, type Cmd, type CommandDef } from '../command.ts'
import { readAll } from '../ctx.ts'
import { CliError, EXIT, usageError } from '../errors.ts'
import { clean, fmtElapsed, fmtTime, parseDuration, TASK_STATE_LABEL } from '../format.ts'
import type { Hub } from '../hub.ts'
import { attentionRows } from './read.ts'

const TARGET_FLAGS: FlagSpec = {
  host: 'string', session: 'string', latest: 'bool', title: 'string', alias: 'string', new: 'string',
  workspace: 'string', preset: 'string', 'new-title': 'string', skill: 'list', key: 'string',
}

const TARGET_USAGE = [
  '宛先（どれか 1 つ）:',
  '  --session <ID>         セッション ID',
  '  --latest               最新のセッション（--workspace で絞り込み可）',
  '  --title <タイトル>     タイトルが完全一致するセッション（--workspace で絞り込み可）',
  '  --alias <別名>         DSH の設定タブで付けた別名',
  '  --new <ワークスペース ID>  新しいセッション（--preset、--new-title を指定可）',
  'その他: --skill <名前>（繰り返し可）、--host <ID>、--key <冪等キー>（省略時は自動生成）',
  'プロンプトを省略すると標準入力から読みます。',
]

function target(cmd: Cmd): TaskTarget {
  const a = cmd.args
  const workspaceId = str(a, 'workspace')
  const ws = workspaceId ? { workspaceId } : {}
  const chosen: TaskTarget[] = []
  const sessionId = str(a, 'session')
  if (sessionId) chosen.push({ sessionId })
  if (bool(a, 'latest')) chosen.push({ latest: true, ...ws })
  const title = str(a, 'title')
  if (title) chosen.push({ title, ...ws })
  const alias = str(a, 'alias')
  if (alias) chosen.push({ alias })
  const newWs = str(a, 'new')
  if (newWs) {
    const preset = str(a, 'preset')
    const newTitle = str(a, 'new-title')
    chosen.push({ new: { workspaceId: newWs, ...(preset ? { agentPreset: preset } : {}), ...(newTitle ? { title: newTitle } : {}) } })
  }
  if (chosen.length !== 1) throw usageError(chosen.length === 0 ? '宛先を指定してください（--session、--latest、--title、--alias、--new のどれか）。' : '宛先は 1 つだけ指定してください。')
  return chosen[0] as TaskTarget
}

async function promptOf(cmd: Cmd, index: number): Promise<string> {
  const words = cmd.args.positionals.slice(index)
  if (words.length > 0) return words.join(' ')
  if (cmd.ctx.stdinIsTTY) throw usageError('プロンプトを指定してください（引数か標準入力）。')
  const text = (await readAll(cmd.ctx.stdin)).trim()
  if (!text) throw usageError('プロンプトが空です。')
  return text
}

async function startTask(cmd: Cmd, promptIndex: number): Promise<{ hub: Hub; info: TaskInfo }> {
  const t = target(cmd)
  const prompt = await promptOf(cmd, promptIndex)
  const hub = await hubOf(cmd)
  const skills = list(cmd.args, 'skill').map(s => s.replace(/^\//, ''))
  const info = await hub.op('task.start', {
    ...hostParam(cmd),
    target: t,
    prompt,
    ...(skills.length ? { skills } : {}),
    idempotencyKey: str(cmd.args, 'key') ?? crypto.randomUUID(),
  })
  return { hub, info }
}

function stateLine(info: TaskInfo): string {
  return `${info.taskId}  ${TASK_STATE_LABEL[info.state] ?? info.state}${info.sessionId ? `  セッション ${info.sessionId}` : ''}${info.hasLiveClient ? '  （DSH Web で誰かが見ています）' : ''}`
}

function printTask(cmd: Cmd, info: TaskInfo): void {
  const out = cmd.ctx.out
  out(`タスク      ${info.taskId}`)
  out(`状態        ${TASK_STATE_LABEL[info.state] ?? info.state}`)
  out(`ホスト      ${info.hostId}`)
  out(`セッション  ${info.sessionId ?? '-'}`)
  out(`作成        ${fmtTime(info.createdAt)}  更新 ${fmtTime(info.updatedAt)}`)
  if (info.hasLiveClient) out('DSH Web で誰かがこのセッションを見ています。')
  if (info.error) out(`エラー      ${clean(info.error.message)}`)
  printAttention(cmd, info)
  if (info.result) printResult(cmd, info)
}

function printAttention(cmd: Cmd, info: TaskInfo): void {
  if (!info.attention?.length) return
  cmd.ctx.out('')
  cmd.ctx.out('人の判断を待っています:')
  for (const line of attentionRows(info.attention)) cmd.ctx.out(`  ${line}`)
  for (const item of info.attention) {
    if (item.detail) cmd.ctx.out(`  ${item.attentionId}: ${clean(item.detail, true).split('\n').join('\n    ')}`)
    if (item.options?.length) cmd.ctx.out(`  ${item.attentionId} の選択肢: ${item.options.map(o => `${o.id}=${clean(o.label)}`).join('、')}`)
  }
  const answerable = info.attention.find(a => a.answerable)
  if (answerable) cmd.ctx.out(`回答: remora answer ${answerable.attentionId} --text "…"（または --option <ID>）`)
  cmd.ctx.out(`続けて待つ: remora tasks wait ${info.taskId}`)
}

function printResult(cmd: Cmd, info: TaskInfo): void {
  const r = info.result
  if (!r) return
  if (r.changes?.length) {
    cmd.ctx.err(`変更したファイル: ${r.changes.length} 件（remora patch --task ${info.taskId} で差分）`)
    for (const c of r.changes.slice(0, 20)) cmd.ctx.err(`  ${c.status.padEnd(8)} ${clean(c.path)}${c.additions !== undefined ? `  +${c.additions} -${c.deletions ?? 0}` : ''}`)
  }
  if (r.deliverables?.length) cmd.ctx.err(`成果物: ${r.deliverables.map(d => clean(d.title)).join('、')}`)
  if (r.reply) cmd.ctx.out(clean(r.reply, true))
}

function done(info: TaskInfo): boolean {
  return TERMINAL_TASK_STATES.has(info.state)
}

function exitFor(info: TaskInfo): number {
  if (info.state === 'completed') return EXIT.ok
  if (info.state === 'needs_attention') return EXIT.attention
  return EXIT.failure
}

interface WaitOptions {
  /** Stop at needs_attention (wait/run) or keep going until terminal (watch). */
  stopAtAttention: boolean
  timeoutMs: number | null
  /** Print a line for every state change instead of a progress line. */
  log: boolean
}

/** Poll `task.wait` in ≤ 25 s steps until the task finishes, needs a human, or the timeout passes. */
async function waitFor(cmd: Cmd, hub: Hub, first: TaskInfo, options: WaitOptions): Promise<{ info: TaskInfo; timedOut: boolean }> {
  const { ctx } = cmd
  const started = ctx.now()
  let info = first
  let lastState = ''
  let lastAttention = ''
  const progress = !cmd.json && !options.log && ctx.stderrIsTTY
  const report = () => {
    const label = TASK_STATE_LABEL[info.state] ?? info.state
    if (progress) {
      ctx.errWrite(`\r\u001b[2K[${fmtElapsed(ctx.now() - started)}] ${label}${info.hasLiveClient ? '（DSH Web で表示中）' : ''}`)
    } else if (!cmd.json && info.state !== lastState) {
      ctx.err(`${fmtTime(ctx.now())} ${options.log ? stateLine(info) : label}`)
    }
    lastState = info.state
  }
  report()
  // Ctrl-C stops waiting, not the task.
  const onInterrupt = () => {
    ctx.err(`${progress ? '\n' : ''}待機をやめました。タスクは続いています: remora tasks wait ${info.taskId}`)
    process.exit(130)
  }
  process.once('SIGINT', onInterrupt)
  try {
    for (;;) {
      if (done(info)) return { info, timedOut: false }
      if (info.state === 'needs_attention') {
        if (options.stopAtAttention) return { info, timedOut: false }
        const key = (info.attention ?? []).map(a => a.attentionId).join(',')
        if (key !== lastAttention && !cmd.json) { if (progress) ctx.errWrite('\n'); printAttention(cmd, info) }
        lastAttention = key
      }
      const elapsed = ctx.now() - started
      if (options.timeoutMs !== null && elapsed >= options.timeoutMs) return { info, timedOut: true }
      const step = Math.min(TASK_WAIT_MAX_MS, options.timeoutMs === null ? TASK_WAIT_MAX_MS : options.timeoutMs - elapsed)
      const callStarted = ctx.now()
      info = await hub.op('task.wait', { taskId: info.taskId, timeoutMs: Math.max(0, Math.round(step)) }, step + 20_000)
      report()
      // A hub that answers instantly must not turn this into a busy loop.
      if (!done(info) && info.state !== 'needs_attention' && ctx.now() - callStarted < 1000) await ctx.sleep(2000)
    }
  } finally {
    process.off('SIGINT', onInterrupt)
    if (progress) ctx.errWrite('\n')
  }
}

function timeoutOf(cmd: Cmd): number | null {
  const raw = str(cmd.args, 'timeout')
  if (raw === undefined) return null
  const ms = parseDuration(raw)
  if (ms === null) throw usageError('--timeout は 90s、10m、1h のように指定してください。')
  return ms
}

async function finish(cmd: Cmd, result: { info: TaskInfo; timedOut: boolean }): Promise<number> {
  const { info, timedOut } = result
  if (cmd.json) {
    printJson(cmd.ctx, { ...info, ...(timedOut ? { timedOut: true } : {}) })
  } else if (timedOut) {
    cmd.ctx.err(`待機を打ち切りました（${TASK_STATE_LABEL[info.state] ?? info.state}）。続けて待つ: remora tasks wait ${info.taskId}`)
  } else if (info.state === 'needs_attention') {
    printAttention(cmd, info)
  } else if (info.state === 'completed') {
    printResult(cmd, info)
  } else {
    cmd.ctx.err(`タスクは${TASK_STATE_LABEL[info.state] ?? info.state}で終わりました。${info.error ? ` ${clean(info.error.message)}` : ''}`)
    if (info.result?.reply) printResult(cmd, info)
  }
  return timedOut ? EXIT.timeout : exitFor(info)
}

function taskIdArg(cmd: Cmd, sub: string): string {
  const taskId = cmd.args.positionals[1]
  if (!taskId) throw usageError(`タスク ID を指定してください: remora tasks ${sub} <タスク ID>`)
  return taskId
}

export const tasks: CommandDef = {
  name: 'tasks',
  summary: 'タスクを投入・確認・待機・操作する（start / status / wait / watch / steer / cancel）',
  usage: [
    'remora tasks start <宛先> [--skill <名前>]... [プロンプト]',
    'remora tasks status <タスク ID>',
    'remora tasks wait <タスク ID> [--timeout 10m]    完了か要対応まで待つ',
    'remora tasks watch <タスク ID> [--timeout 1h]    状態の変化を表示し続け、終了まで待つ',
    'remora tasks steer <タスク ID> <追加の指示>      実行中のタスクに指示を足す（--session でも可）',
    'remora tasks cancel <タスク ID>                  キューから外すか、セッションを止める',
    '',
    ...TARGET_USAGE,
  ],
  flags: { ...TARGET_FLAGS, timeout: 'string' },
  async run(cmd) {
    const sub = cmd.args.positionals[0]
    if (sub === 'start') {
      const { info } = await startTask(cmd, 1)
      if (cmd.json) printJson(cmd.ctx, info)
      else { cmd.ctx.out(stateLine(info)); cmd.ctx.out(`待つ: remora tasks wait ${info.taskId}`) }
      return EXIT.ok
    }
    if (sub === 'status' || sub === 'get') {
      const hub = await hubOf(cmd)
      const info = await hub.op('task.get', { taskId: taskIdArg(cmd, sub) })
      if (cmd.json) printJson(cmd.ctx, info)
      else printTask(cmd, info)
      return EXIT.ok
    }
    if (sub === 'wait' || sub === 'watch') {
      const hub = await hubOf(cmd)
      const first = await hub.op('task.get', { taskId: taskIdArg(cmd, sub) })
      return finish(cmd, await waitFor(cmd, hub, first, { stopAtAttention: sub === 'wait', timeoutMs: timeoutOf(cmd), log: sub === 'watch' }))
    }
    if (sub === 'steer') {
      const sessionId = str(cmd.args, 'session')
      const taskId = sessionId ? undefined : taskIdArg(cmd, sub)
      const prompt = await promptOf(cmd, sessionId ? 1 : 2)
      const hub = await hubOf(cmd)
      const info = await hub.op('task.steer', {
        ...hostParam(cmd),
        ...(taskId ? { taskId } : {}),
        ...(sessionId ? { sessionId } : {}),
        prompt,
        idempotencyKey: str(cmd.args, 'key') ?? crypto.randomUUID(),
      })
      if (cmd.json) printJson(cmd.ctx, info)
      else cmd.ctx.out(`指示を追加しました: ${stateLine(info)}`)
      return EXIT.ok
    }
    if (sub === 'cancel') {
      const hub = await hubOf(cmd)
      const r = await hub.op('task.cancel', { ...hostParam(cmd), taskId: taskIdArg(cmd, sub) })
      if (cmd.json) printJson(cmd.ctx, r)
      else cmd.ctx.out(r.how === 'removed-from-queue' ? 'キューから外しました。' : r.how === 'stopped-session' ? 'セッションを止めました（セッション全体が中断されます）。' : 'タスクはすでに終わっていました。')
      return EXIT.ok
    }
    throw usageError(sub ? `不明なサブコマンドです: tasks ${sub}` : 'サブコマンドを指定してください（start / status / wait / watch / steer / cancel）。')
  },
}

export const run: CommandDef = {
  name: 'run',
  summary: 'タスクを投入して完了まで待ち、最後の返答を表示する（--wait）',
  usage: [
    'remora run --wait <宛先> [--skill <名前>]... [--timeout 30m] [プロンプト]',
    '',
    '25 秒ごとに状態を確認し、完了したら最後の返答を標準出力に出します。',
    '失敗・取り消しは終了コード 1、人の判断待ちで止まったら 3、--timeout で打ち切ったら 8。',
    '--no-wait なら投入だけ行います（tasks start と同じ）。',
    '',
    ...TARGET_USAGE,
  ],
  flags: { ...TARGET_FLAGS, wait: 'bool', 'no-wait': 'bool', timeout: 'string' },
  async run(cmd) {
    const timeoutMs = timeoutOf(cmd)
    const { hub, info } = await startTask(cmd, 0)
    if (bool(cmd.args, 'no-wait')) {
      if (cmd.json) printJson(cmd.ctx, info)
      else cmd.ctx.out(stateLine(info))
      return EXIT.ok
    }
    if (!cmd.json) cmd.ctx.err(`タスク ${info.taskId} を投入しました${info.sessionId ? `（セッション ${info.sessionId}）` : ''}。`)
    return finish(cmd, await waitFor(cmd, hub, info, { stopAtAttention: true, timeoutMs, log: false }))
  },
}

export const answer: CommandDef = {
  name: 'answer',
  summary: 'AI からの質問やプラン確認に答える',
  usage: [
    'remora answer <要対応 ID> (--text "<回答>" | --option <選択肢 ID> | --approve | --reject) [--session <ID>] [--host <ID>]',
    '',
    '--session を省略すると remora attention の一覧から探します。承認待ちには答えられません（DSH で承認してください）。',
  ],
  flags: { host: 'string', session: 'string', text: 'string', option: 'string', approve: 'bool', reject: 'bool' },
  async run(cmd) {
    const attentionId = cmd.args.positionals[0]
    if (!attentionId) throw usageError('要対応 ID を指定してください: remora answer <要対応 ID> --text "…"')
    const text = str(cmd.args, 'text')
    const optionId = str(cmd.args, 'option')
    const approve = bool(cmd.args, 'approve')
    const reject = bool(cmd.args, 'reject')
    if (approve && reject) throw usageError('--approve と --reject は同時に指定できません。')
    if (!text && !optionId && !approve && !reject) throw usageError('--text、--option、--approve、--reject のどれかで回答を指定してください。')
    const hub = await hubOf(cmd)
    let sessionId = str(cmd.args, 'session')
    let hostId = str(cmd.args, 'host')
    if (!sessionId) {
      const listed = await hub.op('attention.list', { ...hostParam(cmd) })
      const item = listed.items.find(a => a.attentionId === attentionId)
      if (!item) throw new CliError(`要対応 ${attentionId} が見つかりません（すでに回答済みかもしれません）。`, EXIT.notFound, { code: 'not_found' })
      if (!item.answerable) throw new CliError('この要対応は Remora からは答えられません。DSH の画面で対応してください。', EXIT.denied, { code: 'not_answerable' })
      sessionId = item.sessionId
      hostId ??= item.hostId
    }
    const result = await hub.op('attention.respond', {
      ...(hostId ? { hostId } : {}),
      attentionId,
      sessionId,
      answer: { ...(text ? { text } : {}), ...(optionId ? { optionId } : {}), ...(approve ? { approve: true } : reject ? { approve: false } : {}) },
    })
    if (cmd.json) printJson(cmd.ctx, result)
    else cmd.ctx.out('回答を送りました。')
    return EXIT.ok
  },
}

export const patch: CommandDef = {
  name: 'patch',
  summary: '変更差分を表示する（--apply で手元の git リポジトリに適用）',
  usage: [
    'remora patch (--task <ID> | --session <ID>) [--path <ファイル>] [--max-bytes N] [--apply [--yes]] [--host <ID>]',
    '',
    '--apply は現在の git リポジトリのルートで git apply --check を通してから、確認のうえ git apply します。',
  ],
  flags: { host: 'string', task: 'string', session: 'string', path: 'string', 'max-bytes': 'string', apply: 'bool', yes: 'bool' },
  async run(cmd) {
    const { ctx, args } = cmd
    const taskId = str(args, 'task')
    const sessionId = str(args, 'session')
    if (!taskId && !sessionId) throw usageError('--task か --session を指定してください。')
    const path = str(args, 'path')
    const maxBytesRaw = str(args, 'max-bytes')
    const maxBytes = maxBytesRaw === undefined ? undefined : Number(maxBytesRaw)
    const hub = await hubOf(cmd)
    const r = await hub.op('patch.get', {
      ...hostParam(cmd),
      ...(taskId ? { taskId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(path ? { path } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    })
    const apply = bool(args, 'apply')
    if (cmd.json && !apply) { printJson(ctx, r); return EXIT.ok }
    if (!r.patch) { if (cmd.json) printJson(ctx, r); else ctx.out('差分はありません。'); return EXIT.ok }
    if (!cmd.json) ctx.out(clean(r.patch, true))
    if (r.truncated) ctx.err('注意: 差分が途中で切り詰められています（--max-bytes を増やしてください）。')
    if (!apply) return EXIT.ok

    if (r.truncated) throw new CliError('切り詰められた差分は適用できません。', EXIT.failure, { code: 'truncated' })
    const top = await ctx.exec('git', ['rev-parse', '--show-toplevel'], { cwd: ctx.cwd })
    if (top.code !== 0) throw new CliError('git リポジトリの中で実行してください。', EXIT.usage, { code: 'not_a_repo' })
    const root = top.stdout.trim()
    const dir = await mkdtemp(join(tmpdir(), 'remora-patch-'))
    const file = join(dir, 'changes.patch')
    try {
      await writeFile(file, r.patch.endsWith('\n') ? r.patch : `${r.patch}\n`, { mode: 0o600 })
      const check = await ctx.exec('git', ['apply', '--check', file], { cwd: root })
      if (check.code !== 0) throw new CliError(`この差分は ${root} にきれいに適用できません:\n${check.stderr.trim()}`, EXIT.failure, { code: 'apply_check_failed' })
      if (!bool(args, 'yes')) {
        if (!ctx.stdinIsTTY) throw usageError('確認できないため中止しました。--yes を付けると確認なしで適用します。')
        if (!(await ctx.confirm(`この差分を ${root} に適用しますか?`))) { ctx.err('中止しました。'); return EXIT.failure }
      }
      const applied = await ctx.exec('git', ['apply', file], { cwd: root })
      if (applied.code !== 0) throw new CliError(`git apply に失敗しました:\n${applied.stderr.trim()}`, EXIT.failure, { code: 'apply_failed' })
      if (cmd.json) printJson(ctx, { applied: true, root, truncated: false })
      else ctx.err(`適用しました: ${root}`)
      return EXIT.ok
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
}
