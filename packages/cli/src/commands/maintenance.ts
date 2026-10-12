/**
 * Hub maintenance the owner approves on the hub each time:
 *
 *   remora audit verify   fetch every audit chain (or read an exported file)
 *                         and recompute it here, against the anchors kept from
 *                         earlier checks
 *   remora hub export     the hub's settings without secrets
 *   remora hosts rotate-key / remora rotate-key   replace a host's key
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AUDIT_KEPT_ROWS, verifyAuditRecords, type AuditExportResult, type AuditLogExport, type HostRotateKeyResult, type HubExportResult } from '@dsh-remora/protocol'
import { bool, str } from '../args.ts'
import { hostParam, hubOf, printJson, type Cmd, type CommandDef } from '../command.ts'
import { asConfirmation, showConfirmUrl, unsettledExit, waitForConfirmation, waitLimit } from '../confirm.ts'
import { configDir, writePrivate } from '../config.ts'
import { CliError, EXIT, usageError } from '../errors.ts'
import { clean, fmtTime, table } from '../format.ts'
import type { Hub } from '../hub.ts'

/** Ask the hub, show where the owner approves, wait, and return the result (or exit with why not). */
async function approved<T>(cmd: Cmd, hub: Hub, op: 'audit.export' | 'hub.export' | 'host.rotate-key', params: Record<string, unknown>, what: string, command: string): Promise<{ result: T } | { exit: number }> {
  // --resume <id>: pick up a request made earlier instead of asking again.
  const earlier = str(cmd.args, 'resume')
  const parked = earlier
    ? asConfirmation(await hub.op('confirmation.get', { confirmationId: earlier }))
    : asConfirmation(await hub.op(op, params as never))
  if (parked.operation !== op) throw usageError(`${earlier} は ${op} の依頼ではありません。`)
  if (parked.state === 'pending') showConfirmUrl(cmd, hub, parked, what)
  const resume = `${command} --resume ${parked.confirmationId}`
  const { info, timedOut } = await waitForConfirmation(cmd, hub, parked, waitLimit(cmd), resume)
  const exit = unsettledExit(cmd, info, timedOut, resume)
  if (exit !== null) return { exit }
  if (info.result === undefined) throw new CliError('承認されましたが、結果はもうありません（1 時間で消えます）。もう一度実行してください。', EXIT.notFound, { code: 'gone' })
  return { result: info.result as T }
}

async function writeOut(cmd: Cmd, path: string, value: unknown): Promise<string> {
  const target = resolve(cmd.ctx.cwd, path)
  await writePrivate(target, `${JSON.stringify(value, null, 2)}\n`)
  return target
}

// --- audit verify -----------------------------------------------------------------------------

/** The last row seen per log at the last successful check, per hub. */
type Anchors = Record<string, Record<string, { seq: number; hash: string; checkedAt: number }>>

const anchorsPath = (cmd: Cmd) => join(configDir(cmd.ctx.env, cmd.ctx.platform), 'audit-anchors.json')

async function loadAnchors(cmd: Cmd): Promise<Anchors> {
  try {
    const value = JSON.parse(await readFile(anchorsPath(cmd), 'utf8')) as unknown
    return typeof value === 'object' && value !== null ? (value as Anchors) : {}
  } catch {
    return {}
  }
}

export type AnchorCheck = 'none' | 'ok' | 'mismatch' | 'truncated' | 'pruned' | 'missing'

export interface LogCheck {
  log: string
  name: string
  records: number
  first: number | null
  last: number | null
  /** First sequence number whose link or hash is wrong. */
  brokenAt: number | null
  anchor: AnchorCheck
}

/** Recompute one chain and compare it with the row pinned at the last check. */
export async function checkLog(log: AuditLogExport, anchor: { seq: number; hash: string } | undefined): Promise<LogCheck> {
  const records = [...log.records].sort((a, b) => a.seq - b.seq)
  const first = records[0]?.seq ?? null
  const last = records.at(-1)?.seq ?? null
  const brokenAt = await verifyAuditRecords(records)
  let check: AnchorCheck = 'none'
  if (anchor) {
    const pinned = records.find(record => record.seq === anchor.seq)
    if (pinned) check = pinned.hash === anchor.hash ? 'ok' : 'mismatch'
    else if (last === null || anchor.seq > last) check = 'truncated'
    // The hub drops old rows only once a log holds its full quota; fewer rows means rows were removed.
    else check = records.length >= AUDIT_KEPT_ROWS ? 'pruned' : 'mismatch'
  }
  return { log: log.log, name: log.name, records: records.length, first, last, brokenAt, anchor: check }
}

const ANCHOR_TEXT: Readonly<Record<AnchorCheck, string>> = {
  none: '前回の確認なし',
  ok: '前回の確認位置と一致',
  mismatch: '前回の確認位置と食い違い',
  truncated: '前回より短くなっている',
  pruned: '前回の確認位置は保存期間外',
  missing: 'ログごと無くなっている',
}

export const audit: CommandDef = {
  name: 'audit',
  summary: '監査ログのハッシュ連鎖をハブの外で検査する（verify）',
  usage: [
    'remora audit verify [--file <書き出した JSON>] [--out <保存先>] [--no-anchor] [--wait-timeout 15m] [--resume <確認 ID>]',
    '',
    'ハブとすべてのホストの監査ログ（誰が・いつ・どの操作を。本文は含みません）を受け取り、この PC でハッシュ連鎖を計算し直します。',
    'ハブから受け取るときは、ハブでオーナーの承認（パスキー）が要ります（dsh.admin スコープ: remora login --admin）。',
    '--file はハブの監査ログ画面の「JSON で書き出す」や --out で保存したファイルを、ハブに問い合わせずに検査します。',
    '検査に通ると、各ログの最後の行を「確認位置」としてこの PC に保存し、次回はその行が変わっていないことも確かめます（--no-anchor で比べず保存もしない）。',
    'ハブは各ログの新しい 10,000 行だけを残すので、それより前の行は検査できません。',
    '待つのをやめても、承認された結果は 1 時間だけ --resume <確認 ID> で受け取れます。',
    '終了コード: すべて正常なら 0、連鎖が途切れているか前回の確認位置と食い違えば 1。拒否は 5、期限切れや待機の打ち切りは 8。',
  ],
  flags: { file: 'string', out: 'string', 'no-anchor': 'bool', 'wait-timeout': 'string', resume: 'string' },
  async run(cmd) {
    const sub = cmd.args.positionals[0] ?? 'verify'
    if (sub !== 'verify') throw usageError(`不明なサブコマンドです: audit ${sub}`)
    let exported: AuditExportResult
    const file = str(cmd.args, 'file')
    let hubKey: string
    if (file) {
      try {
        exported = JSON.parse(await readFile(resolve(cmd.ctx.cwd, file), 'utf8')) as AuditExportResult
      } catch (error) {
        throw usageError(`${file} を読めませんでした: ${(error as Error).message}`)
      }
      if (!Array.isArray(exported?.logs)) throw usageError(`${file} は監査ログの書き出しではありません。`)
      hubKey = exported.hubOrigin || 'file'
    } else {
      const hub = await hubOf(cmd)
      const outcome = await approved<AuditExportResult>(cmd, hub, 'audit.export', {}, '監査ログを受け取る', 'remora audit verify')
      if ('exit' in outcome) return outcome.exit
      exported = outcome.result
      hubKey = hub.url
    }
    const out = str(cmd.args, 'out')
    const saved = out ? await writeOut(cmd, out, exported) : null
    const useAnchors = !bool(cmd.args, 'no-anchor')
    const anchors = useAnchors ? await loadAnchors(cmd) : {}
    const pinned = anchors[hubKey] ?? {}
    const checks = await Promise.all(exported.logs.map(log => checkLog(log, pinned[log.log])))
    // A log checked before must still be there.
    for (const [log, anchor] of Object.entries(pinned)) {
      if (!exported.logs.some(item => item.log === log)) checks.push({ log, name: log, records: 0, first: null, last: null, brokenAt: null, anchor: anchor ? 'missing' : 'none' })
    }
    const bad = checks.filter(check => check.brokenAt !== null || check.anchor === 'mismatch' || check.anchor === 'truncated' || check.anchor === 'missing')
    if (useAnchors && bad.length === 0) {
      const now = cmd.ctx.now()
      const next = { ...pinned }
      for (const log of exported.logs) {
        const last = [...log.records].sort((a, b) => a.seq - b.seq).at(-1)
        if (last) next[log.log] = { seq: last.seq, hash: last.hash, checkedAt: now }
      }
      await writePrivate(anchorsPath(cmd), `${JSON.stringify({ ...anchors, [hubKey]: next }, null, 2)}\n`)
    }
    if (cmd.json) {
      printJson(cmd.ctx, { ok: bad.length === 0, exportedAt: exported.exportedAt, logs: checks, ...(saved ? { savedTo: saved } : {}) })
    } else {
      cmd.ctx.out(`書き出し: ${fmtTime(exported.exportedAt)}${exported.hubOrigin ? `（${clean(exported.hubOrigin)}）` : ''}`)
      for (const line of table(['ログ', '名前', '行数', '範囲', '連鎖', '前回との比較'], checks.map(check => [
        check.log === 'hub' ? 'ハブ' : check.log,
        check.name === 'hub' ? 'ハブ' : check.name,
        String(check.records),
        check.first === null ? '-' : `#${check.first}〜#${check.last}`,
        check.brokenAt === null ? '正常' : `#${check.brokenAt} で途切れ`,
        ANCHOR_TEXT[check.anchor],
      ]), 40)) cmd.ctx.out(line)
      if (saved) cmd.ctx.err(`保存しました: ${saved}`)
      if (bad.length > 0) cmd.ctx.err('改ざんか欠落の疑いがあります。ハブの監査ログ画面と、DSH 側の Remora タブの監査ログも確かめてください。')
      else if (useAnchors) cmd.ctx.err('確認位置を保存しました。次回はこの位置から変わっていないことも確かめます。')
    }
    return bad.length === 0 ? EXIT.ok : EXIT.failure
  },
}

// --- hub export -------------------------------------------------------------------------------

export const hubCommand: CommandDef = {
  name: 'hub',
  summary: 'ハブの設定を書き出す（export）',
  usage: [
    'remora hub export [--out <保存先>] [--wait-timeout 15m] [--resume <確認 ID>]',
    '',
    'ホスト（鍵の指紋）、クライアントと付与範囲、個人トークン・パスキー・通知デバイスの一覧を JSON で書き出します。',
    'トークンの値、鍵、通知の送り先、リカバリーコードなどの秘密は含みません。',
    'ハブでオーナーの承認（パスキー）が要ります（dsh.admin スコープ: remora login --admin）。--out が無ければ標準出力へ。',
  ],
  flags: { out: 'string', 'wait-timeout': 'string', resume: 'string' },
  async run(cmd) {
    const sub = cmd.args.positionals[0] ?? 'export'
    if (sub !== 'export') throw usageError(`不明なサブコマンドです: hub ${sub}`)
    const hub = await hubOf(cmd)
    const outcome = await approved<HubExportResult>(cmd, hub, 'hub.export', {}, 'ハブの設定を受け取る', 'remora hub export')
    if ('exit' in outcome) return outcome.exit
    const out = str(cmd.args, 'out')
    if (out) {
      const saved = await writeOut(cmd, out, outcome.result)
      if (cmd.json) printJson(cmd.ctx, { savedTo: saved })
      else cmd.ctx.out(`保存しました: ${saved}（ホスト ${outcome.result.hosts.length}、クライアント ${outcome.result.clients.length}）`)
    } else {
      printJson(cmd.ctx, outcome.result)
    }
    return EXIT.ok
  },
}

// --- rotate-key -------------------------------------------------------------------------------

/** `remora hosts rotate-key [<host>]` and `remora rotate-key [<host>]`. */
export async function rotateKey(cmd: Cmd, hostArg: string | undefined): Promise<number> {
  const hub = await hubOf(cmd)
  let hostId = hostArg ?? hostParam(cmd).hostId
  if (!hostId && !str(cmd.args, 'resume')) {
    const { hosts } = await hub.op('hosts.list', {})
    if (hosts.length !== 1) throw usageError(hosts.length === 0 ? 'ペアリング済みのホストがありません。' : 'ホストが複数あります。ホスト ID を指定してください（remora hosts で確認できます）。')
    hostId = (hosts[0] as { hostId: string }).hostId
  }
  const outcome = await approved<HostRotateKeyResult>(cmd, hub, 'host.rotate-key', { hostId }, 'ホスト鍵を更新する', 'remora rotate-key')
  if ('exit' in outcome) return outcome.exit
  if (cmd.json) printJson(cmd.ctx, outcome.result)
  else cmd.ctx.out(`ホスト鍵を更新しました: ${outcome.result.hostId}（新しい鍵の指紋 ${outcome.result.publicKeyFingerprint}）`)
  return EXIT.ok
}

export const rotateKeyCommand: CommandDef = {
  name: 'rotate-key',
  summary: 'ホスト鍵を更新する（remora hosts rotate-key と同じ）',
  usage: [
    'remora rotate-key [<ホスト ID>] [--wait-timeout 15m] [--resume <確認 ID>]',
    '',
    'ホストに新しい鍵を作らせ、古い鍵と新しい鍵の両方の署名を確かめてから切り替えます。ホストは新しい鍵でつなぎ直します。',
    'ハブでオーナーの承認（パスキー）が要ります（dsh.admin スコープ: remora login --admin）。ホストが 1 台なら ID は省けます。',
    '鍵が漏れた疑いがあるときは、更新ではなくハブで登録を解除し、DSH 側でペアリングし直してください。',
  ],
  flags: { host: 'string', 'wait-timeout': 'string', resume: 'string' },
  run: cmd => rotateKey(cmd, cmd.args.positionals[0]),
}
