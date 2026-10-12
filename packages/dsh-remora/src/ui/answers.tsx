import { SegmentedControl, Switch } from 'remora-official-primitives'
import type { SectionProps } from './connection.tsx'

const WAITS = [0, 5, 10, 30, 60]

/** Answers from outside: how long Remora waits, and approvals from MCP and CLI. */
export function AnswersSection({ snapshot, t, run, busy }: SectionProps) {
  const settings = snapshot.settings
  const minutes = Math.round(settings.remoteAnswerWaitMs / 60_000)
  const choices = WAITS.includes(minutes) ? WAITS : [...WAITS, minutes].sort((a, b) => a - b)
  const localOnly = snapshot.local ? undefined : t('err.local-only')
  const approval = snapshot.operations.find(op => op.id === 'approval.respond')
  const respond = snapshot.operations.find(op => op.id === 'attention.respond')
  return <div className="rmr-stack" style={{ marginTop: 12 }} id="answers" data-testid="remora-answers">
    <div className="rmr-section-head"><h3>{t('ans.title')}</h3><span className="rmr-muted">{t('ans.hint')}</span></div>
    <div className="rmr-row">
      <div className="rmr-row-text">
        <span>{t('ans.wait')}</span>
        <span className="rmr-muted">{t('ans.waitHint')}</span>
        {minutes === 0 ? <span className="rmr-faint">{t('ans.offNote')}</span> : null}
      </div>
    </div>
    <SegmentedControl id="rmr-answer-wait" label={t('ans.wait')} value={String(minutes)} disabled={busy}
      options={choices.map(value => ({
        value: String(value),
        label: value === 0 ? t('ans.off') : t('ans.minutes', { n: value }),
        // Turning waiting on (from off) widens what outsiders can do: this PC only.
        disabled: minutes === 0 && value > 0 && !snapshot.local,
        ...(minutes === 0 && value > 0 && localOnly ? { title: localOnly } : {}),
      }))}
      onChange={value => { void run('answers', { waitMinutes: Number(value) }) }} />
    <div className="rmr-row">
      <div className="rmr-row-text">
        <span>{t('ans.approvals')}</span>
        <span className="rmr-muted">{settings.approvalsFromRemote ? t('ans.approvalsOn') : t('ans.approvalsOff')}</span>
      </div>
      <Switch checked={settings.approvalsFromRemote} label={t('ans.approvals')} title={settings.approvalsFromRemote ? undefined : localOnly}
        disabled={busy || (!settings.approvalsFromRemote && !snapshot.local)}
        onChange={next => { void run('answers', { approvalsFromRemote: next }) }} />
    </div>
    {approval && !approval.allowed ? <p className="rmr-notice">{t('ans.approvalsBlocked')}</p> : null}
    {respond && !respond.allowed ? <p className="rmr-faint">{t('ans.questionsBlocked')}</p> : null}
  </div>
}
