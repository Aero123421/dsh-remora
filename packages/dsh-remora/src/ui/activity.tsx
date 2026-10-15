import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Tag } from 'remora-official-primitives'
import type { CopyKey } from '../locales.ts'
import type { AuditEntry, ClientSummary, RemoraSnapshot, UpdateCheck, UpdateInstallation } from '../state.ts'
import { CallError, call, errorText, formatTime, type ClientContext, type Translate } from './api.ts'
import type { SectionProps } from './connection.tsx'
import { QuestionModeTags } from './question-mode.tsx'

const OUTCOME_TONE = { ok: 'success', error: 'warning', denied: 'danger' } as const

const INSTALL_OUTCOMES = new Set(['previous-restored', 'restore-failed', 'presence-unknown', 'restore-receipt-failed'])

function installCopyKey(installation: UpdateInstallation): CopyKey {
  if (installation.error && INSTALL_OUTCOMES.has(installation.error)) return `compat.install.${installation.error}` as CopyKey
  return `compat.install.${installation.phase}` as CopyKey
}

export function ActivitySection({ snapshot, t, ctx }: { snapshot: RemoraSnapshot; t: Translate; ctx: ClientContext }) {
  const [clients, setClients] = useState<ClientSummary[]>([])
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const load = useCallback(() => {
    call<{ clients: ClientSummary[] }>(ctx, 'clients').then(value => setClients(value.clients), () => {})
    call<{ entries: AuditEntry[] }>(ctx, 'audit').then(value => setEntries(value.entries), () => {})
  }, [ctx])
  useEffect(load, [load])
  const who = (entry: AuditEntry) => {
    if (entry.kind === 'request') return entry.clientName ?? entry.clientId ?? '?'
    const kind = t(entry.kind === 'settings' ? 'act.kind.settings' : 'act.kind.connection')
    return entry.local === undefined ? kind : `${kind} (${t(entry.local ? 'act.local' : 'act.remote')})`
  }
  return <div className="rmr-section">
    <div className="rmr-section-head">
      <div className="rmr-title-row"><h3>{t('act.clients')}</h3><Button variant="ghost" size="sm" onClick={load}>{t('retry')}</Button></div>
      <span className="rmr-muted">{t('act.clientsHint')}</span>
    </div>
    <div className="rmr-list">
      {clients.length === 0 ? <span className="rmr-faint">{t('none')}</span> : null}
      {clients.map(client => <div key={client.clientId} className="rmr-item">
        <div className="rmr-item-text"><span>{client.clientName}</span><span className="rmr-faint rmr-mono">{client.clientId}</span></div>
        <span className="rmr-faint">{t('act.requests', { count: client.requests })}{client.denied > 0 ? ` · ${t('act.denied', { count: client.denied })}` : ''} · {t('act.lastSeen', { time: formatTime(client.lastAt) })}</span>
      </div>)}
    </div>
    <div className="rmr-section-head" style={{ paddingTop: 20 }}>
      <h3>{t('act.audit')}</h3>
      <span className="rmr-muted">{t('act.auditHint')}</span>
    </div>
    {snapshot.auditIntact ? null : <p className="rmr-notice" data-tone="danger">{t('act.auditBroken')}</p>}
    {entries.length === 0 ? <span className="rmr-faint">{t('none')}</span> : <table className="rmr-table">
      <tbody>
        {entries.map(entry => <tr key={entry.seq}>
          <td className="rmr-faint">{formatTime(entry.at)}</td>
          <td>{who(entry)}</td>
          <td className="rmr-mono">{entry.action}</td>
          <td>
            <Tag tone={OUTCOME_TONE[entry.outcome]}>{t(`act.outcome.${entry.outcome}`)}</Tag>
            {entry.layer ? <span className="rmr-faint"> {t(`act.layer.${entry.layer}` as CopyKey)} · {entry.reason}</span> : entry.reason ? <span className="rmr-faint"> {entry.reason}</span> : null}
          </td>
        </tr>)}
      </tbody>
    </table>}
  </div>
}

export function CompatSection({ snapshot, t, ctx, busy }: Pick<SectionProps, 'snapshot' | 't' | 'busy'> & { ctx: ClientContext }) {
  const [check, setCheck] = useState<UpdateCheck | null>(snapshot.update)
  const [installation, setInstallation] = useState<UpdateInstallation | null>(snapshot.updateInstallation)
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const generation = useRef(0)
  const hostInstance = useRef(snapshot.updateHostInstance)
  const pending = useRef<'check' | 'install' | null>(null)
  useLayoutEffect(() => {
    const changedHost = hostInstance.current !== snapshot.updateHostInstance
    const interrupted = changedHost && (pending.current === 'install' || installation?.phase === 'downloading' || installation?.phase === 'installing')
    hostInstance.current = snapshot.updateHostInstance
    generation.current++
    pending.current = null
    setChecking(false)
    setMessage(interrupted ? t('compat.resultLost') : null)
    setCheck(snapshot.update)
    setInstallation(snapshot.updateInstallation)
    const requestGeneration = generation.current
    call<UpdateInstallation | null>(ctx, 'update-reconcile', {}).then(value => {
      if (generation.current === requestGeneration && value) { setInstallation(value); setMessage(null) }
    }, () => {})
    return () => { generation.current++ }
  }, [ctx, snapshot.updateHostInstance])
  useEffect(() => {
    if (snapshot.update) setCheck(current => !current || current.checkedAt <= snapshot.update!.checkedAt ? snapshot.update : current)
    const next = snapshot.updateInstallation
    if (next) setInstallation(current => {
      if (current?.phase === 'confirmed' && next.requestId === current.requestId) return current
      if (!current || next.attempt > current.attempt) return next
      if (next.attempt < current.attempt) return current
      // A poll started before settlement must not replace a terminal RPC result.
      const running = (value: UpdateInstallation) => value.phase === 'downloading' || value.phase === 'installing'
      if (!running(current) && running(next)) return current
      if (current.phase === 'installing' && next.phase === 'downloading') return current
      return next
    })
  }, [snapshot.update, snapshot.updateInstallation])
  const runCheck = (force: boolean) => {
    if (pending.current) return
    pending.current = 'check'
    const requestGeneration = generation.current
    setChecking(true)
    setMessage(null)
    call<UpdateCheck>(ctx, 'update-check', { force }).then(value => {
      if (generation.current === requestGeneration) setCheck(value)
    }, error => {
      if (generation.current === requestGeneration) setMessage(errorText(t, error))
    }).finally(() => {
      if (generation.current === requestGeneration) { pending.current = null; setChecking(false) }
    })
  }
  const install = () => {
    if (pending.current) return
    pending.current = 'install'
    const requestGeneration = generation.current
    setChecking(true)
    setMessage(null)
    call<UpdateInstallation>(ctx, 'update-install', { version: check?.latest?.version }).then(value => {
      if (generation.current === requestGeneration) setInstallation(value)
    }, error => {
      // A lost RPC reply does not prove installation failed. Poll the Host state.
      if (generation.current === requestGeneration) setMessage(error instanceof CallError ? errorText(t, error) : t('compat.resultUnknown'))
    }).finally(() => {
      if (generation.current === requestGeneration) { pending.current = null; setChecking(false) }
    })
  }
  const latest = check?.latest
  const installing = installation?.phase === 'downloading' || installation?.phase === 'installing' || installation?.phase === 'unknown'
  const installed = installation?.version === latest?.version && (installation?.phase === 'applied' || installation?.phase === 'restart-required' || installation?.phase === 'confirmed')
  return <div className="rmr-section">
    <div className="rmr-row">
      <div className="rmr-row-text">
        <span>{t('compat.versions')}</span>
        <span className="rmr-faint">Remora {snapshot.version} · protocol {snapshot.protocol} · DSH {snapshot.dshVersion ?? '?'}</span>
      </div>
    </div>
    <div className="rmr-row">
      <div className="rmr-row-text">
        <span>{t('compat.available')}</span>
        <span className="rmr-chips">{snapshot.features.available.length === 0 ? <span className="rmr-faint">{t('none')}</span> : snapshot.features.available.map(id => <Tag key={id} tone="neutral">{id}</Tag>)}</span>
      </div>
    </div>
    {snapshot.features.missing.length > 0 ? <div className="rmr-row">
      <div className="rmr-row-text">
        <span>{t('compat.missing')}</span>
        {snapshot.features.missing.map(item => <span key={item.operation} className="rmr-faint"><span className="rmr-mono">{item.operation}</span> ({item.services.join(', ')})</span>)}
      </div>
    </div> : null}
    <div className="rmr-row">
      <div className="rmr-row-text"><span>{t('compat.questionMode')}</span><QuestionModeTags snapshot={snapshot} t={t} /></div>
    </div>
    <div className="rmr-row">
      <div className="rmr-row-text"><span>{t('compat.dataDir')}</span><span className="rmr-faint rmr-mono">{snapshot.dataDir}</span></div>
    </div>
    <div className="rmr-section-head" style={{ paddingTop: 16 }}>
      <div className="rmr-title-row"><h3>{t('compat.update')}</h3><Button variant="outline" size="sm" disabled={checking || busy || installing} onClick={() => runCheck(true)}>{t('compat.check')}</Button></div>
    </div>
    {check?.installUnavailable ? <p className="rmr-muted">{t('compat.unavailable', { code: check.installUnavailable })}</p> : null}
    {check?.restartRequired ? <p className="rmr-muted">{t('compat.installedPending', { version: check.installedVersion ?? '?', current: snapshot.version })}</p> : null}
    {check?.error ? <p className="rmr-error">{t('compat.checkFailed', { code: check.error })}</p> : null}
    {check && !check.error && !latest ? <p className="rmr-muted">{t('compat.noRelease')}</p> : null}
    {check && latest && !check.newer && !check.restartRequired ? <p className="rmr-muted">{t('compat.upToDate')}</p> : null}
    {check && latest && check.newer ? <div className="rmr-stack">
      <p>{t('compat.newer', { version: latest.version })}</p>
      {latest.notes ? <><span className="rmr-faint">{t('compat.notes')}</span><div className="rmr-notes">{latest.notes}</div></> : null}
      {snapshot.canInstallUpdate && !check.installUnavailable && latest.tarball && latest.sums ? <div className="rmr-inline">
        <Button variant="primary" size="sm" disabled={checking || busy || installing || installed || !snapshot.local} title={snapshot.local ? undefined : t('err.local-only')} onClick={install}>{t('compat.install')}</Button>
        <span className="rmr-faint">{t('compat.installHint')}</span>
      </div> : null}
      <span className="rmr-faint">{t('compat.manual')}</span>
      <span className="rmr-mono">{latest.tarball?.url ?? latest.url}</span>
    </div> : null}
    {installation ? <p className={['failed', 'overridden', 'cancelled'].includes(installation.phase) ? 'rmr-error' : 'rmr-muted'}>
      {t(installCopyKey(installation), { version: installation.installedVersion ?? installation.version, current: snapshot.version, code: installation.error ?? installation.phase, stage: installation.stage ?? 'download' })}
    </p> : null}
    {message ? <p className="rmr-muted">{message}</p> : null}
  </div>
}
