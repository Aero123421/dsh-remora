import { ENDPOINTS, PROTOCOL_VERSION, type HostSummary } from '@dsh-remora/protocol'
import { bool, str } from '../args.ts'
import { hubOf, printJson, type CommandDef } from '../command.ts'
import type { Ctx } from '../ctx.ts'
import { configDir } from '../config.ts'
import { CliError, EXIT, notAvailable, usageError } from '../errors.ts'
import { clean, table } from '../format.ts'
import { openHub, resolveHubUrl } from '../hub.ts'
import { probe, runMcpBridge } from '../mcp.ts'
import { discover } from '../oauth.ts'
import { installOf, selfUpdate } from '../selfupdate.ts'
import { BACKEND_LABEL, openTokenStore } from '../tokens.ts'
import { hostRows } from './read.ts'
import { CLI_VERSION } from '../version.ts'

interface Check { name: string; ok: boolean | null; detail: string }

function nodeOk(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 19)
}

async function health(ctx: Ctx, hubUrl: string): Promise<Check> {
  try {
    const response = await ctx.fetch(hubUrl + ENDPOINTS.health, { signal: AbortSignal.timeout(10_000) })
    await response.body?.cancel().catch(() => {})
    return { name: 'ハブへの接続', ok: response.ok, detail: response.ok ? `${hubUrl}（HTTP ${response.status}）` : `HTTP ${response.status}` }
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause
    return { name: 'ハブへの接続', ok: false, detail: `${hubUrl} に接続できません: ${cause?.code ?? (error as Error).message}` }
  }
}

export const doctor: CommandDef = {
  name: 'doctor',
  summary: '環境・ハブ・ログイン・ホストを診断する',
  usage: ['remora doctor', '', 'ハブへの接続、OAuth メタデータ、トークンの有効性、ホストの一覧を確認します。問題があれば終了コード 1。'],
  flags: {},
  async run({ ctx, args, json }) {
    const checks: Check[] = []
    let hosts: HostSummary[] | null = null
    const install = installOf(ctx)
    const form = install.form === 'binary' ? '単体実行ファイル' : install.path ? `Node.js 版（${install.path}）` : 'ソースから実行'
    checks.push({ name: 'remora', ok: true, detail: `${CLI_VERSION}（protocol ${PROTOCOL_VERSION}、${form}、${ctx.platform}-${ctx.arch}）` })
    if (!ctx.isSea) checks.push({ name: 'Node.js', ok: nodeOk(ctx.nodeVersion), detail: nodeOk(ctx.nodeVersion) ? ctx.nodeVersion : `${ctx.nodeVersion} — 22.19 以上が必要です` })
    checks.push({ name: '設定フォルダー', ok: true, detail: configDir(ctx.env, ctx.platform) })
    let hubUrl: string | null = null
    try {
      hubUrl = await resolveHubUrl(ctx, str(args, 'hub'))
    } catch (error) {
      checks.push({ name: 'ハブの URL', ok: false, detail: (error as Error).message })
    }
    if (!hubUrl) {
      if (checks.every(c => c.name !== 'ハブの URL')) checks.push({ name: 'ハブの URL', ok: false, detail: '未設定です。remora login <ハブの URL> でログインしてください' })
    } else {
      checks.push({ name: 'ハブの URL', ok: true, detail: hubUrl })
      const reach = await health(ctx, hubUrl)
      checks.push(reach)
      if (reach.ok) {
        try {
          const meta = await discover(ctx, hubUrl)
          const device = meta.device_authorization_endpoint ? 'デバイスコード対応' : 'デバイスコード非対応'
          checks.push({ name: 'OAuth メタデータ', ok: true, detail: `issuer 一致、PKCE S256、${device}` })
        } catch (error) {
          checks.push({ name: 'OAuth メタデータ', ok: false, detail: (error as Error).message })
        }
        if (ctx.env.REMORA_TOKEN) {
          checks.push({ name: 'トークン', ok: null, detail: '環境変数 REMORA_TOKEN を使います' })
        } else {
          const store = await openTokenStore(ctx)
          const tokens = await store.load(hubUrl)
          checks.push(tokens && store.location
            ? { name: 'トークンの保存先', ok: true, detail: BACKEND_LABEL[store.location] }
            : { name: 'トークンの保存先', ok: false, detail: `ログインしていません。remora login ${hubUrl} を実行してください` })
        }
        try {
          const hub = await openHub(ctx, hubUrl)
          const result = await hub.op('hosts.list', {})
          hosts = result.hosts
          checks.push({ name: 'トークンの有効性', ok: true, detail: `有効${hub.tokens ? `（スコープ: ${hub.tokens.scope}）` : ''}` })
          const online = hosts.filter(h => h.online).length
          checks.push({ name: 'DSH ホスト', ok: hosts.length > 0 ? online > 0 : null, detail: hosts.length === 0 ? 'ペアリング済みのホストはありません' : `${hosts.length} 台（オンライン ${online} 台）` })
        } catch (error) {
          if (checks.some(c => c.name === 'トークンの保存先' && c.ok === false)) { /* already reported */ } else {
            checks.push({ name: 'トークンの有効性', ok: false, detail: `${(error as Error).message}${error instanceof CliError && error.detail.hint ? ` ${error.detail.hint}` : ''}` })
          }
        }
      }
    }
    const ok = checks.every(c => c.ok !== false)
    if (json) {
      printJson(ctx, { ok, checks, hosts })
    } else {
      for (const line of table(['項目', '結果', '詳細'], checks.map(c => [c.name, c.ok === null ? '—' : c.ok ? 'OK' : 'NG', c.detail]), 100)) ctx.out(line)
      if (hosts && hosts.length > 0) {
        ctx.out('')
        for (const line of hostRows(hosts)) ctx.out(line)
      }
    }
    return ok ? EXIT.ok : EXIT.failure
  },
}

export const mcp: CommandDef = {
  name: 'mcp',
  summary: 'ローカルの MCP クライアント向け stdio ブリッジ（mcp probe で疎通確認）',
  usage: [
    'remora mcp           stdio の MCP サーバーとして動き、ハブの MCP に中継する',
    'remora mcp probe     initialize と tools/list を試してツールを表示する',
    '',
    '例（Claude Code）: claude mcp add remora -- remora mcp',
    '例（Codex）: ~/.codex/config.toml に [mcp_servers.remora] command = "remora" args = ["mcp"]',
  ],
  flags: {},
  async run({ ctx, args, json }) {
    const sub = args.positionals[0]
    if (sub === undefined) {
      const hub = await openHub(ctx, str(args, 'hub'))
      return runMcpBridge(ctx, hub)
    }
    if (sub !== 'probe') throw usageError(`不明なサブコマンドです: mcp ${sub}`)
    const hub = await openHub(ctx, str(args, 'hub'))
    const result = await probe(hub)
    if (json) { printJson(ctx, result); return EXIT.ok }
    const server = result.serverInfo as { name?: string; version?: string } | undefined
    ctx.out(`MCP サーバー: ${clean(server?.name ?? '?')} ${clean(server?.version ?? '')}（プロトコル ${clean(String(result.protocolVersion))}）`)
    ctx.out(`ツール: ${result.tools.length} 個`)
    for (const line of table(['ツール', '種類', '説明'], result.tools.map(t => [
      t.name,
      t.annotations?.destructiveHint ? '破壊的' : t.annotations?.readOnlyHint ? '読み取り' : '書き込み',
      t.description ?? '',
    ]), 90)) ctx.out(line)
    return EXIT.ok
  },
}

export const selfUpdateCommand: CommandDef = {
  name: 'self-update',
  summary: 'GitHub Releases から自己更新する（SHA256SUMS を検証）',
  usage: [
    'remora self-update [--check] [--version <版>] [--force]',
    '',
    '--check は新しい版があるかだけを確認します。GITHUB_TOKEN があれば API の回数制限を避けるのに使います。',
    'Node.js で動く remora.mjs 版はその .mjs を、単体実行ファイル版は実行ファイルを入れ替えます（どちらも SHA256SUMS を検証）。',
  ],
  flags: { check: 'bool', version: 'string', force: 'bool', target: 'string' },
  async run({ ctx, args, json }) {
    const target = str(args, 'target')
    const version = str(args, 'version')
    const outcome = await selfUpdate(ctx, {
      check: bool(args, 'check'),
      force: bool(args, 'force'),
      currentVersion: CLI_VERSION,
      ...(target ? { target } : {}),
      ...(version ? { version } : {}),
    })
    if (json) { printJson(ctx, outcome); return EXIT.ok }
    if (bool(args, 'check')) {
      ctx.out(outcome.latest === outcome.current ? `最新です（${outcome.current}）。` : `新しい版があります: ${outcome.current} → ${outcome.latest}（${outcome.asset}）。remora self-update で更新します。`)
    } else if (outcome.updated) {
      ctx.out(`更新しました: ${outcome.current} → ${outcome.latest}`)
      ctx.out(`SHA-256 ${outcome.sha256} を確認済み（${outcome.target}）`)
    } else {
      ctx.out(`最新です（${outcome.current}）。`)
    }
    return EXIT.ok
  },
}

/** The hub's owner page for one session (hub/src/ui/routes.ts). */
export function sessionPageUrl(hubUrl: string, hostId: string, sessionId: string): string {
  return `${hubUrl}/hosts/${encodeURIComponent(hostId)}/sessions/${encodeURIComponent(sessionId)}`
}

export const open: CommandDef = {
  name: 'open',
  summary: 'セッションをハブの画面で開く',
  usage: [
    'remora open <セッション ID> [--host <ID>] [--no-browser]',
    '',
    'ハブのセッション画面（/hosts/<ホスト>/sessions/<セッション>）をブラウザで開き、URL を表示します。',
    'ホストが複数あるときは、--host が無ければセッションを持つホストを探します。開くにはハブへのパスキーでのサインインが必要です。',
  ],
  flags: { host: 'string', 'no-browser': 'bool' },
  async run(cmd) {
    const { ctx, args, json } = cmd
    const sessionId = args.positionals[0]
    if (!sessionId) throw usageError('セッション ID を指定してください: remora open <セッション ID>')
    const hub = await hubOf(cmd)
    let hostId = str(args, 'host')
    if (!hostId) {
      const { hosts } = await hub.op('hosts.list', {})
      if (hosts.length === 0) throw new CliError('ペアリング済みのホストがありません。', EXIT.notFound, { code: 'not_found' })
      if (hosts.length === 1) hostId = (hosts[0] as HostSummary).hostId
      else {
        for (const host of [...hosts].sort((a, b) => Number(b.online) - Number(a.online))) {
          try {
            await hub.op('session.get', { hostId: host.hostId, sessionId })
            hostId = host.hostId
            break
          } catch (error) {
            if (!(error instanceof CliError) || error.exitCode === EXIT.auth) throw error
          }
        }
        if (!hostId) throw new CliError(`セッション ${sessionId} を持つホストが見つかりません。--host で指定してください。`, EXIT.notFound, { code: 'not_found' })
      }
    }
    const url = sessionPageUrl(hub.url, hostId, sessionId)
    const opened = !bool(args, 'no-browser') && !ctx.env.REMORA_NO_BROWSER && await ctx.openBrowser(url).catch(() => false)
    if (json) printJson(ctx, { url, hostId, sessionId, opened })
    else {
      ctx.out(url)
      ctx.err(opened ? 'ブラウザで開きました。' : 'ブラウザを開けませんでした。上の URL を開いてください。')
    }
    return EXIT.ok
  },
}

/** Commands whose hub endpoints are not in the contract yet. */
function unavailable(name: string, summary: string, label: (positionals: string[]) => string): CommandDef {
  return {
    name,
    summary: `${summary}（未対応）`,
    usage: [`remora ${name}`, '', 'ハブ側のエンドポイントがまだ無いため使えません。'],
    flags: {},
    async run({ args }) { throw notAvailable(label(args.positionals)) },
  }
}

export const NOT_YET: readonly CommandDef[] = [
  unavailable('audit', '監査ログの改ざん検査（audit verify）', p => `remora audit ${p[0] ?? 'verify'}`),
  unavailable('hub', 'ハブ設定の書き出し（hub export）', p => `remora hub ${p[0] ?? 'export'}`),
  unavailable('rotate-key', 'ホスト鍵の更新', () => 'remora rotate-key'),
]
