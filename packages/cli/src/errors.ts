import type { DenialReason, ErrorCode, RemoraError } from '@dsh-remora/protocol'

/**
 * Exit codes of `remora`. Stable: scripts depend on them.
 *
 * | code | meaning |
 * | ---- | ------- |
 * | 0    | success |
 * | 1    | failure (task failed or was cancelled, hub internal error, conflict, ...) |
 * | 2    | not available yet (the hub endpoint or feature does not exist yet) |
 * | 3    | the task stopped and is waiting for a human (needs_attention) |
 * | 4    | not logged in, or the login expired / was revoked |
 * | 5    | denied by a permission layer (DSH ceiling, hub grant or token scope) |
 * | 6    | not found / gone |
 * | 7    | hub or DSH host unreachable / unavailable / rate limited |
 * | 8    | timed out while waiting |
 * | 64   | usage error (bad arguments or invalid parameters) |
 * | 130  | interrupted while waiting (Ctrl-C; the task keeps running) |
 */
export const EXIT = {
  ok: 0,
  failure: 1,
  notAvailable: 2,
  attention: 3,
  auth: 4,
  denied: 5,
  notFound: 6,
  unavailable: 7,
  timeout: 8,
  usage: 64,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export interface CliErrorDetail {
  /** Machine-readable code: a protocol `ErrorCode` or a CLI-specific one. */
  code?: string
  /** Where the user can fix it. */
  fix?: string
  /** One more line of advice, in Japanese. */
  hint?: string
  denial?: RemoraError['denial']
  status?: number
}

export class CliError extends Error {
  readonly exitCode: number
  readonly detail: CliErrorDetail
  constructor(message: string, exitCode: number = EXIT.failure, detail: CliErrorDetail = {}) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.detail = detail
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, EXIT.usage, { code: 'usage', ...(hint ? { hint } : {}) })
}

export function notLoggedIn(hint = 'remora login <ハブの URL> でログインしてください。'): CliError {
  return new CliError('ログインしていません。', EXIT.auth, { code: 'not_logged_in', hint })
}

export function notAvailable(what: string): CliError {
  return new CliError(`${what} はまだ使えません（ハブ側の機能がまだありません）。`, EXIT.notAvailable, { code: 'not_available' })
}

export function exitCodeForError(code: ErrorCode | string): number {
  switch (code) {
    case 'denied': return EXIT.denied
    case 'not_found':
    case 'gone': return EXIT.notFound
    case 'unavailable':
    case 'host_offline':
    case 'rate_limited': return EXIT.unavailable
    case 'invalid_request': return EXIT.usage
    default: return EXIT.failure
  }
}

const DENIAL_LAYER: Record<string, string> = { dsh: 'DSH 側の上限', hub: 'ハブでの付与', token: 'トークンのスコープ' }

/** One line of advice per DenialReason. */
const DENIAL_HINT: Readonly<Record<DenialReason, string>> = {
  'forbidden-remotely': 'この操作は遠隔からはできません（DSH の画面で行ってください）。',
  'level-too-low': '権限の段階が足りません。DSH の設定タブ「Remora」かハブの「接続」画面で引き上げてください。',
  'switched-off': 'この操作は個別にオフになっています。',
  'full-access-expired': 'リモート全権の期限（24 時間）が切れました。',
  'missing-scope': 'トークンのスコープが足りません。remora login --content（ターミナルは --admin、または --scope）でログインし直してください。',
  'unknown-operation': 'このホストはこの操作を知りません。プラグインの版を確認してください。',
  'kill-switch': 'DSH 側で緊急停止がオンです。DSH の設定タブ「Remora」で解除するまで何もできません。',
  'confirmation-failed': 'パスキーによる確認が得られませんでした（危険な操作には DSH 側で検証される署名が必要です）。',
  'out-of-scope': 'このセッションやワークスペースは、DSH の設定タブで許可された範囲の外です。',
}

export function missingScope(scope: string): CliError {
  return new CliError(`この操作には ${scope} スコープが必要ですが、今のログインには含まれていません。`, EXIT.denied, {
    code: 'denied',
    denial: { layer: 'token', reason: 'missing-scope' },
    hint: scope === 'dsh.content' ? 'remora login --content でログインし直してください（会話本文や差分を読めるようになります）。'
      : scope === 'dsh.admin' ? 'remora login --admin でログインし直してください（--content も使っていたなら両方付けます）。'
      : `remora login --scope "<今のスコープ> ${scope}" でログインし直してください。`,
  })
}

/** Preserve OAuth step-up advice when HTTP authentication cannot reach a stdio client. */
export function insufficientScopeError(body: unknown, challenge: string | null, requiredScope?: string): CliError | null {
  const oauth = body as { error?: unknown; error_description?: unknown } | null
  if (oauth?.error !== 'insufficient_scope' && !/\berror="insufficient_scope"/.test(challenge ?? '')) return null
  const scopes = /\bscope="([^"]*)"/.exec(challenge ?? '')?.[1]?.split(/\s+/).filter(Boolean) ?? []
  const scope = requiredScope ?? (scopes.includes('dsh.admin') ? 'dsh.admin' : scopes.includes('dsh.content') ? 'dsh.content' : scopes.join(' '))
  const error = missingScope(scope || '<required scope>')
  if (typeof oauth?.error_description === 'string' && oauth.error_description) error.message = `${oauth.error_description}。${error.message}`
  return error
}

/** Turn the body of a non-2xx HTTP API response into a CliError. */
export function fromHttpError(status: number, body: unknown): CliError {
  const error = (body as { error?: Partial<RemoraError> } | null)?.error
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    const detail: CliErrorDetail = { code: error.code, status }
    if (error.fix) detail.fix = error.fix
    if (error.denial) {
      detail.denial = error.denial
      detail.hint = `${DENIAL_LAYER[error.denial.layer] ?? error.denial.layer}で拒否されました（${error.denial.reason}）。${DENIAL_HINT[error.denial.reason as DenialReason] ?? ''}`
    }
    return new CliError(error.message, exitCodeForError(error.code), detail)
  }
  if (status === 401) return new CliError('ハブが認証を受け付けませんでした。', EXIT.auth, { code: 'unauthorized', status, hint: 'remora login でログインし直してください。' })
  if (status === 404) return new CliError('ハブにこの操作がありません（HTTP 404）。ハブの版が古い可能性があります。', EXIT.notFound, { code: 'not_found', status })
  if (status === 429) return new CliError('ハブの回数制限にかかりました（HTTP 429）。少し待ってから試してください。', EXIT.unavailable, { code: 'rate_limited', status })
  if (status >= 500) return new CliError(`ハブがエラーを返しました（HTTP ${status}）。`, EXIT.unavailable, { code: 'unavailable', status })
  return new CliError(`ハブがエラーを返しました（HTTP ${status}）。`, EXIT.failure, { code: 'http_error', status })
}
