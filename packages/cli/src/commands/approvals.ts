import type { AttentionItem } from '@dsh-remora/protocol'
import { bool, str } from '../args.ts'
import { hostParam, hubOf, printJson, type Cmd, type CommandDef } from '../command.ts'
import { countdown, passkeyUrl, routeOf } from '../attention.ts'
import { CliError, EXIT, usageError } from '../errors.ts'
import { clean } from '../format.ts'
import type { Hub } from '../hub.ts'

function passkeyRequired(url: string): CliError {
  return new CliError('この承認には、ハブの画面でオーナーのパスキーが必要です。', EXIT.denied, {
    code: 'denied',
    denial: { layer: 'dsh', reason: 'confirmation-failed' },
    hint: '次の URL をブラウザで開いて、許可か拒否を選んでください（DSH の設定タブ「Remora」で「MCP と CLI からの承認を許可」をオンにすると、パスキーなしで答えられます）。',
    fix: url,
  })
}

async function respond(cmd: Cmd, approve: boolean): Promise<number> {
  const { ctx, args, json } = cmd
  const verb = approve ? '承認' : '拒否'
  const attentionId = args.positionals[0]
  if (!attentionId) throw usageError(`要対応 ID を指定してください: remora ${approve ? 'approve' : 'reject'} <要対応 ID>`)
  const hub = await hubOf(cmd)
  let sessionId = str(args, 'session')
  let hostId = str(args, 'host')
  let item: AttentionItem | undefined
  if (!sessionId) {
    const listed = await hub.op('attention.list', { ...hostParam(cmd) })
    item = listed.items.find(a => a.attentionId === attentionId && (!hostId || a.hostId === hostId))
    if (!item) throw new CliError(`要対応 ${attentionId} が見つかりません（すでに答えられたか、期限が切れたかもしれません）。`, EXIT.notFound, { code: 'not_found' })
    if (item.kind !== 'approval') throw usageError(`${attentionId} は承認ではありません。remora answer ${attentionId} で答えてください。`)
    sessionId = item.sessionId
    hostId ??= item.hostId
    const route = routeOf(item)
    // Asking for a confirmation the host is known to refuse would only waste the user's time.
    if (route === 'hub-passkey') throw passkeyRequired(passkeyUrl(hub.url, item))
    if (route === 'dsh-web') throw new CliError('この承認は DSH Web でしか答えられません（Remora からの回答がオフです）。', EXIT.denied, { code: 'denied', hint: 'DSH Web でセッションを開いて答えてください。' })
  }

  if (!bool(args, 'yes')) {
    if (item) {
      ctx.err(`${verb}する要対応: ${clean(item.title)}`)
      ctx.err(`  セッション ${item.sessionId}、期限 ${countdown(item.expiresAt, ctx.now())}`)
      if (item.detail) ctx.err(`  ${clean(item.detail, true).split('\n').join('\n  ')}`)
    }
    if (!ctx.stdinIsTTY) throw usageError(`確認できないため中止しました。--yes を付けると確認なしで${verb}します。`)
    const question = approve
      ? `${attentionId} を 1 回だけ許可しますか？ エージェントはこの操作をより強い権限で実行します。`
      : `${attentionId} を拒否しますか？`
    if (!(await ctx.confirm(question))) { ctx.err('中止しました。'); return EXIT.failure }
  }

  try {
    const result = await hub.op('approval.respond', { ...(hostId ? { hostId } : {}), attentionId, sessionId, answer: { approve } })
    if (json) printJson(ctx, result)
    else ctx.out(approve ? '許可しました（1 回だけ）。' : '拒否しました。')
    return EXIT.ok
  } catch (error) {
    if (error instanceof CliError && error.detail.denial?.reason === 'confirmation-failed') {
      throw passkeyRequired(passkeyLink(hub, error, item, hostId, attentionId))
    }
    throw error
  }
}

function passkeyLink(hub: Hub, error: CliError, item: AttentionItem | undefined, hostId: string | undefined, attentionId: string): string {
  const fix = error.detail.fix
  // `hub:/` alone only says "on the hub"; a page of its own is better.
  if (fix && fix !== `${hub.url}/` && fix.startsWith(hub.url)) return fix
  if (item) return passkeyUrl(hub.url, item)
  return hostId ? passkeyUrl(hub.url, { hostId, attentionId }) : `${hub.url}/attention`
}

const USAGE_TAIL = [
  '',
  '--session を省略すると remora attention の一覧から探します。--yes で確認を省きます。',
  'DSH の設定タブで「MCP と CLI からの承認を許可」がオフのとき（既定）は、ハブの画面でパスキーを使って答えるよう案内し、終了コード 5 で終わります。',
]

export const approve: CommandDef = {
  name: 'approve',
  summary: 'DSH の承認待ちを 1 回だけ許可する',
  usage: ['remora approve <要対応 ID> [--yes] [--session <ID>] [--host <ID>]', ...USAGE_TAIL],
  flags: { host: 'string', session: 'string', yes: 'bool' },
  run: cmd => respond(cmd, true),
}

export const reject: CommandDef = {
  name: 'reject',
  summary: 'DSH の承認待ちを拒否する',
  usage: ['remora reject <要対応 ID> [--yes] [--session <ID>] [--host <ID>]', ...USAGE_TAIL],
  flags: { host: 'string', session: 'string', yes: 'bool' },
  run: cmd => respond(cmd, false),
}
