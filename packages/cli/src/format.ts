/** Human output helpers: terminal-safe text, East Asian widths, tables, times. */

// C0/C1 controls (except \n and \t) and bidi overrides. DSH text is untrusted:
// escape sequences in a session title must not reach the terminal.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g

/** Make untrusted text safe to print. Single-line mode also folds newlines and tabs. */
export function clean(text: string | null | undefined, multiline = false): string {
  if (text === null || text === undefined) return ''
  const safe = text.replace(CONTROL, '')
  return multiline ? safe : safe.replace(/[\n\t\r]+/g, ' ').trim()
}

function isWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)
}

export function width(text: string): number {
  let w = 0
  for (const ch of text) w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return w
}

export function truncate(text: string, max: number): string {
  if (width(text) <= max) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return `${out}…`
}

function pad(text: string, w: number): string {
  return text + ' '.repeat(Math.max(0, w - width(text)))
}

/** Align columns. Cells are cleaned and truncated to `maxWidth`. */
export function table(headers: readonly string[], rows: readonly (readonly string[])[], maxWidth = 48): string[] {
  const cells = rows.map(row => row.map(cell => truncate(clean(cell), maxWidth)))
  const widths = headers.map((h, i) => Math.max(width(h), ...cells.map(row => width(row[i] ?? ''))))
  const line = (row: readonly string[]) => row.map((cell, i) => (i === row.length - 1 ? cell : pad(cell, widths[i] ?? 0))).join('  ').trimEnd()
  return [line(headers), ...cells.map(line)]
}

function two(n: number): string { return String(n).padStart(2, '0') }

export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-'
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分${two(s % 60)}秒`
  return `${Math.floor(m / 60)}時間${two(m % 60)}分`
}

/** `90`, `90s`, `10m`, `1h` → milliseconds. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] ?? 's'
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000
  return Math.round(n * factor)
}

export const TASK_STATE_LABEL: Readonly<Record<string, string>> = {
  accepted: '受付済み',
  running: '実行中',
  needs_attention: '要対応',
  completed: '完了',
  failed: '失敗',
  cancelled: '取り消し',
  parked: '保留中（ホストに届けられていません）',
}

export const ATTENTION_KIND_LABEL: Readonly<Record<string, string>> = {
  'approval': '承認待ち',
  'question': '質問',
  'plan-review': 'プラン確認',
  'goal-stopped': 'ゴール停止',
  'login-expired': 'ログイン切れ',
}
