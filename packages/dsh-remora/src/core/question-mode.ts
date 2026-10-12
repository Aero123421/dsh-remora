/**
 * Which `ask_user_question` mode each DSH agent preset uses.
 *
 * DSH's shipped presets use the blocking `legacy` tool, whose questions
 * never enter the `userQuestions` projection and so cannot be answered from
 * outside. With `mode: timed` on the preset's `tool-ask-user` row, the
 * question stays answerable (`userQuestions.answer`) and, after the row's
 * timeout (120 s by default), the agent continues independent work while the
 * question remains open. Plan reviews and approvals cannot be answered
 * remotely in any mode.
 *
 * The rows live inside each preset's `config.plugins` list. Reading and
 * switching go through DSH's own `configEditor` service (the same profile
 * patch the Agent Preset editor writes), at DSH 0.2.1-alpha.2.
 */

export type QuestionMode = 'legacy' | 'timed' | 'absent' | 'unknown'

export interface PresetQuestionMode {
  /** Agent preset id (e.g. standard). */
  presetId: string
  /** Profile row id (e.g. preset-standard). */
  entryId: string
  mode: QuestionMode
}

export interface QuestionModeReport {
  /** Whether DSH's configEditor service is available to read and switch modes. */
  editable: boolean
  presets: PresetQuestionMode[]
}

interface EntryLike {
  options: { id: string; name: string; config?: unknown; disabled?: unknown }
}

interface ConfigEditorLike {
  entries(): EntryLike[]
  edit(entry: EntryLike, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>): Promise<void>
}

const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'
const ASK_USER_PLUGIN = '@deepseek-ai/dsh-tool-ask-user'

function editorOf(get: (name: string) => unknown): ConfigEditorLike | null {
  const editor = get('configEditor') as Partial<ConfigEditorLike> | undefined
  return editor && typeof editor.entries === 'function' && typeof editor.edit === 'function' ? editor as ConfigEditorLike : null
}

type Row = { id?: unknown; name?: unknown; disabled?: unknown; config?: unknown }

function isAskUserRow(row: unknown): row is Row {
  if (typeof row !== 'object' || row === null) return false
  const r = row as Row
  return r.id === 'tool-ask-user' || r.name === ASK_USER_PLUGIN
}

function modeOf(plugins: unknown): QuestionMode {
  if (!Array.isArray(plugins)) return 'unknown'
  const row = plugins.find(isAskUserRow)
  if (!row) return 'absent'
  if (row.disabled === true) return 'absent'
  const mode = typeof row.config === 'object' && row.config !== null ? (row.config as { mode?: unknown }).mode : undefined
  if (mode === undefined || mode === 'legacy') return 'legacy'
  if (mode === 'timed') return 'timed'
  return 'unknown'
}

function presetEntries(editor: ConfigEditorLike): EntryLike[] {
  return editor.entries().filter(entry => entry.options.name === PRESET_PLUGIN)
}

export function readQuestionModes(get: (name: string) => unknown): QuestionModeReport {
  const editor = editorOf(get)
  if (!editor) return { editable: false, presets: [] }
  try {
    const presets = presetEntries(editor).map(entry => {
      const config = (entry.options.config ?? {}) as { id?: unknown; plugins?: unknown }
      return { presetId: typeof config.id === 'string' ? config.id : entry.options.id, entryId: entry.options.id, mode: modeOf(config.plugins) }
    })
    return { editable: true, presets }
  } catch {
    return { editable: false, presets: [] }
  }
}

/**
 * Set `mode: timed` on the `tool-ask-user` row of every preset that still
 * uses `legacy`. Other fields of the row (such as `timeout`) are kept.
 * Returns the preset ids that were changed; throws when DSH refuses an edit.
 */
export async function switchToTimed(get: (name: string) => unknown): Promise<string[]> {
  const editor = editorOf(get)
  if (!editor) throw new Error('configEditor is not available')
  const changed: string[] = []
  for (const entry of presetEntries(editor)) {
    const config = (entry.options.config ?? {}) as { id?: unknown; plugins?: unknown }
    if (modeOf(config.plugins) !== 'legacy') continue
    await editor.edit(entry, current => {
      const plugins = Array.isArray(current.plugins) ? current.plugins : []
      return {
        ...current,
        plugins: plugins.map(row => {
          if (!isAskUserRow(row)) return row
          const rowConfig = typeof row.config === 'object' && row.config !== null ? row.config as Record<string, unknown> : {}
          return { ...row, config: { ...rowConfig, mode: 'timed' } }
        }),
      }
    })
    changed.push(typeof config.id === 'string' ? config.id : entry.options.id)
  }
  return changed
}
