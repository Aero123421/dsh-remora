import { Button, Tag } from 'remora-official-primitives'
import type { RemoraSnapshot } from '../state.ts'
import type { Translate } from './api.ts'

const TONE = { legacy: 'neutral', timed: 'neutral', absent: 'quiet', unknown: 'quiet' } as const

/** Mode per agent preset, as tags. */
export function QuestionModeTags({ snapshot, t }: { snapshot: RemoraSnapshot; t: Translate }) {
  const { presets } = snapshot.questionModes
  if (presets.length === 0) return <span className="rmr-faint">{t('qm.unreadable')}</span>
  return <span className="rmr-chips">{presets.map(preset => <Tag key={preset.entryId} tone={TONE[preset.mode]}>{preset.presetId}: {t(`qm.mode.${preset.mode}`)}</Tag>)}</span>
}

/** Which questions from the agent can be answered from outside, and a local-only switch to timed mode. */
export function QuestionModeNotice({ snapshot, t, run, busy }: { snapshot: RemoraSnapshot; t: Translate; run: (method: string, payload?: unknown) => Promise<boolean>; busy: boolean }) {
  const { editable, presets } = snapshot.questionModes
  const legacy = presets.some(preset => preset.mode === 'legacy')
  return <div className="rmr-stack" style={{ marginTop: 12 }}>
    <div className="rmr-section-head"><h3>{t('qm.title')}</h3><span className="rmr-muted">{t('qm.limit')}</span></div>
    <QuestionModeTags snapshot={snapshot} t={t} />
    <span className="rmr-faint">{t('qm.timedNote')}</span>
    {legacy && editable
      ? <div className="rmr-inline">
        <Button variant="outline" size="sm" disabled={busy || !snapshot.local} title={snapshot.local ? undefined : t('err.local-only')} onClick={() => { void run('question-mode') }}>{t('qm.switch')}</Button>
      </div>
      : null}
    {legacy && !editable ? <span className="rmr-faint">{t('qm.manual')}</span> : null}
  </div>
}
