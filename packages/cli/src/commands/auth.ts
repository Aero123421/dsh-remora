import { CLI_CLIENT_ID } from '@dsh-remora/protocol'
import { bool, str } from '../args.ts'
import { printJson, type CommandDef } from '../command.ts'
import { loadProfile, normalizeHubUrl, saveProfile } from '../config.ts'
import { EXIT, usageError } from '../errors.ts'
import { parseDuration } from '../format.ts'
import { resolveHubUrl } from '../hub.ts'
import { CONTENT_SCOPE, DEFAULT_SCOPE, discover, discoverResources, loginWithBrowser, loginWithDevice, revoke, toAccess } from '../oauth.ts'
import { BACKEND_LABEL, openTokenStore, type StoredTokens } from '../tokens.ts'

export const login: CommandDef = {
  name: 'login',
  summary: 'ハブにログインする（--device で SSH 先からも）',
  usage: [
    'remora login <ハブの URL> [--device] [--content] [--scope "<スコープ>"] [--no-browser] [--timeout 5m]',
    '',
    'ブラウザでハブのパスキー承認を行い、トークンを OS のキーチェーンに保存します。',
    'ブラウザが使えない環境（SSH 先など）では --device を付け、表示されたコードを別の端末で入力します。',
    '',
    `既定のスコープ: ${DEFAULT_SCOPE}`,
    '  一覧・タスクの投入と待機・そのタスク自身の最終返答の表示までできます。',
    `--content を付けると ${CONTENT_SCOPE} も求めます。sessions read（会話本文）、patch（差分）、`,
    '  要対応の質問の全文に必要です。会話や差分には秘密が紛れることがあるので、必要なときだけ付けてください。',
    '--scope は求めるスコープをそのまま指定します（--content より優先）。',
  ],
  flags: { device: 'bool', content: 'bool', scope: 'string', 'no-browser': 'bool', timeout: 'string' },
  async run({ ctx, args, json }) {
    const given = args.positionals[0]
    const hubUrl = given ? normalizeHubUrl(given) : await resolveHubUrl(ctx, str(args, 'hub'))
    if (!hubUrl) throw usageError('ハブの URL を指定してください。', '例: remora login https://remora.example.workers.dev')
    const requested = str(args, 'scope') ?? (bool(args, 'content') ? `${DEFAULT_SCOPE} ${CONTENT_SCOPE}` : DEFAULT_SCOPE)
    const scope = requested.trim().split(/\s+/).join(' ')
    const timeoutRaw = str(args, 'timeout')
    const timeoutMs = timeoutRaw ? parseDuration(timeoutRaw) : 5 * 60_000
    if (timeoutMs === null || timeoutMs <= 0) throw usageError('--timeout は 90s、5m のように指定してください。')

    const meta = await discover(ctx, hubUrl)
    const resources = await discoverResources(ctx, hubUrl)
    const response = bool(args, 'device')
      ? await loginWithDevice(ctx, hubUrl, meta, { scope, resources, timeoutMs })
      : await loginWithBrowser(ctx, meta, { scope, resources, timeoutMs, openBrowser: !bool(args, 'no-browser') && !ctx.env.REMORA_NO_BROWSER })

    const tokens: StoredTokens = {
      hubUrl,
      clientId: CLI_CLIENT_ID,
      scope: response.scope ?? scope,
      issuer: meta.issuer,
      tokenEndpoint: meta.token_endpoint,
      ...(meta.revocation_endpoint ? { revocationEndpoint: meta.revocation_endpoint } : {}),
      resources,
      refreshToken: response.refresh_token ?? null,
      access: { api: toAccess(ctx, response) },
    }
    const store = await openTokenStore(ctx)
    const where = await store.save(tokens)
    await saveProfile(ctx, { ...(await loadProfile(ctx)), hubUrl, scope })
    if (json) {
      printJson(ctx, { hubUrl, scope: tokens.scope, store: where, refreshable: tokens.refreshToken !== null })
    } else {
      ctx.out(`ログインしました: ${hubUrl}`)
      ctx.out(`スコープ: ${tokens.scope}`)
      ctx.out(`保存先: ${BACKEND_LABEL[where]}`)
      if (!tokens.refreshToken) ctx.out('注意: 更新用トークンが発行されなかったため、期限が切れたらログインし直す必要があります。')
    }
    return EXIT.ok
  },
}

export const logout: CommandDef = {
  name: 'logout',
  summary: 'トークンを取り消して削除する',
  usage: ['remora logout', '', 'ハブでトークンを取り消し（対応している場合）、保存したトークンを削除します。ハブの URL は残します。'],
  flags: {},
  async run({ ctx, args, json }) {
    const hubUrl = await resolveHubUrl(ctx, str(args, 'hub'))
    if (!hubUrl) {
      if (json) printJson(ctx, { loggedOut: false, reason: 'not_logged_in' })
      else ctx.out('ログインしていません。')
      return EXIT.ok
    }
    const store = await openTokenStore(ctx)
    const tokens = await store.load(hubUrl)
    const revoked = tokens ? await revoke(ctx, tokens) : false
    await store.clear(hubUrl)
    if (json) {
      printJson(ctx, { loggedOut: true, hubUrl, revoked })
    } else {
      ctx.out(`ログアウトしました: ${hubUrl}`)
      if (tokens && !revoked) ctx.out('ハブでの取り消しはできませんでした。必要ならハブの「接続」画面から取り消してください。')
    }
    return EXIT.ok
  },
}
