import { useState } from 'react'
import { Button, Modal, Switch, Tag } from 'remora-official-primitives'
import type { CopyKey } from '../locales.ts'
import type { OperationRow } from '../state.ts'
import { formatRemaining } from './api.ts'
import type { SectionProps } from './connection.tsx'

type Level = 'view' | 'request' | 'full'
const RANK: Record<Level, number> = { view: 0, request: 1, full: 2 }

/** Whether `level` alone (no switch) allows an operation. */
function byLevel(op: OperationRow, level: Level, fullActive: boolean): boolean {
  if (op.level === 'full') return level === 'full' && fullActive
  return RANK[op.level] <= RANK[level]
}

export function FullBadge({ t, expiresAt, now }: { t: SectionProps['t']; expiresAt: number | null; now: number }) {
  return <span className="rmr-full-badge">
    {t('perm.fullBadge')}{expiresAt !== null ? ` · ${t('perm.fullRemaining', { time: formatRemaining(expiresAt - now) })}` : ''}
  </span>
}

export function PermissionsSection({ snapshot, t, run, busy }: SectionProps) {
  const ceiling = snapshot.settings.ceiling
  const level = ceiling.level as Level
  const overrides: Record<string, boolean> = { ...(ceiling.overrides as Record<string, boolean> | undefined) }
  const hasOverrides = Object.keys(overrides).length > 0
  const [customMode, setCustomMode] = useState(hasOverrides)
  const [confirmFull, setConfirmFull] = useState(false)
  const custom = customMode || hasOverrides
  const fullActive = snapshot.fullAccess.active
  const selected: Level | 'custom' = custom ? 'custom' : level

  const choose = (next: Level | 'custom') => {
    if (next === 'custom') { setCustomMode(true); return }
    setCustomMode(false)
    if (next === 'full' && !fullActive) { setConfirmFull(true); return }
    void run('permission', { level: next })
  }

  const toggle = (op: OperationRow, next: boolean) => {
    const updated = { ...overrides }
    if (byLevel(op, level, fullActive) === next) delete updated[op.id]
    else updated[op.id] = next
    setCustomMode(true)
    void run('permission', { level, overrides: updated })
  }

  const levels: (Level | 'custom')[] = ['view', 'request', 'full', 'custom']
  const groups: Level[] = ['view', 'request', 'full']
  const showSandboxWarning = level !== 'view' || snapshot.operations.some(op => op.allowed && op.level !== 'view')

  return <div className="rmr-section">
    <div className="rmr-section-head">
      <div className="rmr-title-row"><h3>{t('perm.title')}</h3>{fullActive ? <FullBadge t={t} expiresAt={snapshot.fullAccess.expiresAt} now={snapshot.now} /> : null}</div>
      <span className="rmr-muted">{t('perm.hint')}</span>
    </div>
    <div className="rmr-levels" role="radiogroup" aria-label={t('perm.title')}>
      {levels.map(item => <button key={item} type="button" role="radio" className="rmr-level" data-level={item} data-testid={`remora-ceiling-${item}`} aria-checked={selected === item} disabled={busy}
        onClick={() => choose(item)}>
        <span className="rmr-level-name">{t(`perm.level.${item}`)}</span>
        <span className="rmr-muted">{t(`perm.desc.${item}`)}</span>
      </button>)}
    </div>
    {fullActive ? <div className="rmr-row">
      <div className="rmr-row-text"><FullBadge t={t} expiresAt={snapshot.fullAccess.expiresAt} now={snapshot.now} /></div>
      <div className="rmr-row-actions">
        <Button variant="outline" size="sm" disabled={busy || !snapshot.local} title={snapshot.local ? undefined : t('err.local-only')} onClick={() => { void run('full-access-extend') }}>{t('perm.extend')}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void run('permission', { level: 'request', ...(hasOverrides ? { overrides } : {}) }) }}>{t('perm.level.request')}</Button>
      </div>
    </div> : null}
    {showSandboxWarning ? <p className="rmr-notice" style={{ marginTop: 12 }}>{t('perm.sandboxWarning')}</p> : null}

    {custom ? <div className="rmr-stack" style={{ marginTop: 12 }}>
      <div className="rmr-section-head"><h3>{t('perm.ops')}</h3><span className="rmr-muted">{t('perm.opsHint')}</span></div>
      {groups.map(group => <div key={group} className="rmr-list">
        <div className="rmr-group-title">{t(`perm.group.${group}`)}</div>
        {snapshot.operations.filter(op => op.level === group && op.id !== 'status' && op.id !== 'hosts.list').map(op => <div key={op.id} className="rmr-item">
          <div className="rmr-item-text">
            <span>{t(`op.${op.id}` as CopyKey)}</span>
            <span className="rmr-inline"><span className="rmr-faint rmr-mono">{op.id}</span>{op.available ? null : <Tag tone="quiet">{t('perm.unavailable')}</Tag>}</span>
          </div>
          <Switch checked={op.allowed} label={t(`op.${op.id}` as CopyKey)} disabled={busy || (op.level === 'full' && !fullActive && !op.allowed)} onChange={next => toggle(op, next)} />
        </div>)}
      </div>)}
    </div> : null}

    <Modal open={confirmFull} onClose={() => setConfirmFull(false)} title={t('perm.fullConfirmTitle')} closeLabel={t('close')} description={t('perm.fullConfirmBody')}
      footer={<div className="rmr-inline">
        <Button variant="outline" onClick={() => setConfirmFull(false)}>{t('cancel')}</Button>
        <Button variant="primary" className="rmr-danger-button" onClick={() => { setConfirmFull(false); void run('permission', { level: 'full', confirmFull: true, ...(hasOverrides ? { overrides } : {}) }) }}>{t('perm.fullConfirm')}</Button>
      </div>}>
      <p className="rmr-muted">{t('perm.sandboxWarning')}</p>
    </Modal>
  </div>
}
