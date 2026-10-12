import { useEffect, useState } from 'react'
import { Button, Input, Modal, StateDot } from 'remora-official-primitives'
import type { RemoraSnapshot } from '../state.ts'
import type { Translate } from './api.ts'
import { QrCode } from './qr.tsx'

export interface SectionProps {
  snapshot: RemoraSnapshot
  t: Translate
  run: (method: string, payload?: unknown) => Promise<boolean>
  busy: boolean
}

const STATE_DOT = { idle: 'idle', connecting: 'ongoing', authenticating: 'ongoing', connected: 'done', backoff: 'warning', stopped: 'error' } as const

export function ConnectionSection({ snapshot, t, run, busy }: SectionProps) {
  const { hub, pairing } = snapshot
  const [hubUrl, setHubUrl] = useState(hub.url ?? '')
  const [hostName, setHostName] = useState(snapshot.settings.hostName)
  const [repairing, setRepairing] = useState(false)
  const [confirmUnpair, setConfirmUnpair] = useState(false)
  useEffect(() => { setHostName(snapshot.settings.hostName) }, [snapshot.settings.hostName])
  useEffect(() => { if (hub.url && hubUrl === '') setHubUrl(hub.url) }, [hub.url, hubUrl])
  const waiting = pairing.phase === 'waiting' || pairing.phase === 'starting'
  const showPairForm = !hub.paired || repairing || waiting
  const link = hub.link
  const stateText = link.state === 'backoff'
    ? t('conn.state.backoff', { sec: Math.max(0, Math.ceil(((link.retryAt ?? snapshot.now) - snapshot.now) / 1000)) })
    : t(`conn.state.${link.state}`)

  return <div className="rmr-section">
    {hub.paired ? <>
      <div className="rmr-row">
        <div className="rmr-row-text">
          <span>{t('conn.status')}</span>
          <span className="rmr-inline"><StateDot state={STATE_DOT[link.state]} size={8} /><span>{stateText}</span></span>
          {link.lastError && link.state !== 'connected' ? <span className="rmr-faint">{t('conn.lastError', { error: link.lastError })}</span> : null}
        </div>
        <div className="rmr-row-actions">
          <Button variant="outline" size="sm" disabled={busy || snapshot.settings.killSwitch} onClick={() => { void run('reconnect') }}>{t('conn.reconnect')}</Button>
        </div>
      </div>
      <div className="rmr-row">
        <div className="rmr-row-text">
          <span>{t('conn.paired')}</span>
          <span className="rmr-mono">{hub.hubOrigin}</span>
          <span className="rmr-faint">{t('conn.hostId')}: <span className="rmr-mono">{hub.hostId}</span> · {t('conn.passkeys', { count: hub.ownerCredentials })}</span>
        </div>
        <div className="rmr-row-actions">
          <Button variant="outline" size="sm" disabled={busy || waiting} onClick={() => setRepairing(value => !value)}>{t('conn.repair')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmUnpair(true)}>{t('conn.unpair')}</Button>
        </div>
      </div>
    </> : <p className="rmr-muted">{t('conn.notPaired')}</p>}

    {hub.lock === 'other' ? <p className="rmr-notice">{t('conn.lockOther')}</p> : null}
    {hub.revoked ? <p className="rmr-notice" data-tone="danger">{t('conn.revoked')}</p> : null}
    {link.lastError === 'protocol_mismatch' ? <p className="rmr-notice" data-tone="danger">{t('conn.protocolMismatch')}</p> : null}

    {snapshot.pendingCredentials ? <div className="rmr-row">
      <div className="rmr-row-text">
        <h3>{t('creds.title')}</h3>
        <span className="rmr-muted">{t('creds.body', { added: snapshot.pendingCredentials.added.length, removed: snapshot.pendingCredentials.removed.length })}</span>
      </div>
      <div className="rmr-row-actions">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => { void run('owner-credentials', { accept: true }) }}>{t('creds.accept')}</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run('owner-credentials', { accept: false }) }}>{t('creds.reject')}</Button>
      </div>
    </div> : null}

    <div className="rmr-row">
      <div className="rmr-row-text">
        <span>{t('conn.hostName')}</span>
        <span className="rmr-muted">{t('conn.hostNameHint')}</span>
      </div>
      <div className="rmr-row-actions">
        <Input value={hostName} maxLength={100} aria-label={t('conn.hostName')} onChange={event => setHostName(event.target.value)}
          onBlur={() => { if (hostName.trim() !== '' && hostName !== snapshot.settings.hostName) void run('settings', { hostName }) }} />
      </div>
    </div>

    {showPairForm ? <div className="rmr-row">
      <div className="rmr-row-text">
        <span>{t('conn.hubUrl')}</span>
        <span className="rmr-muted">{repairing ? t('conn.repairHint') : t('conn.hubUrlHint')}</span>
        <div className="rmr-inline">
          <Input className="rmr-grow" value={hubUrl} placeholder="https://remora-hub.example.workers.dev" aria-label={t('conn.hubUrl')} disabled={waiting} onChange={event => setHubUrl(event.target.value)} />
          {waiting
            ? <Button variant="outline" size="sm" onClick={() => { void run('pairing-cancel') }}>{t('cancel')}</Button>
            : <Button variant="primary" size="sm" disabled={busy || hubUrl.trim() === '' || !snapshot.local} title={snapshot.local ? undefined : t('err.local-only')}
              onClick={() => { void run('pairing-start', { hubUrl }).then(ok => { if (ok) setRepairing(false) }) }}>{hub.paired ? t('conn.repair') : t('conn.pair')}</Button>}
        </div>
      </div>
    </div> : null}

    {pairing.phase === 'waiting' && pairing.userCode && pairing.verifyUrl ? <div className="rmr-pairing">
      <QrCode value={pairing.verifyUrl} label={t('conn.openApproval')} />
      <div className="rmr-stack">
        <span className="rmr-muted">{t('conn.code')}</span>
        <span className="rmr-code">{pairing.userCode}</span>
        <span className="rmr-muted">{t('conn.codeHint')}</span>
        <a href={pairing.verifyUrl} target="_blank" rel="noopener noreferrer">{t('conn.openApproval')}</a>
        {pairing.expiresAt ? <span className="rmr-faint">{t('conn.expires', { min: Math.max(0, Math.ceil((pairing.expiresAt - snapshot.now) / 60_000)) })}</span> : null}
        <span className="rmr-faint">{t('pairing.waiting')}</span>
      </div>
    </div> : null}
    {pairing.phase === 'starting' ? <p className="rmr-muted">{t('pairing.starting')}</p> : null}
    {pairing.phase === 'denied' || pairing.phase === 'expired' || pairing.phase === 'cancelled' || pairing.phase === 'approved'
      ? <p className="rmr-muted">{t(`pairing.${pairing.phase}`)}</p> : null}
    {pairing.phase === 'error' ? <p className="rmr-error">{t('pairing.error', { code: pairing.error ?? '?' })}</p> : null}

    <p className="rmr-faint" style={{ paddingTop: 12 }}>{t(snapshot.keyStorage === 'credentials' ? 'conn.keyStorage.credentials' : 'conn.keyStorage.file')}</p>
    {snapshot.proxy.configured && !snapshot.proxy.envProxy ? <p className="rmr-notice" style={{ marginTop: 8 }}>{t('conn.proxyWarning')}</p> : null}

    <Modal open={confirmUnpair} onClose={() => setConfirmUnpair(false)} title={t('conn.unpair')} closeLabel={t('close')} description={t('conn.unpairConfirm')}
      footer={<div className="rmr-inline">
        <Button variant="outline" onClick={() => setConfirmUnpair(false)}>{t('cancel')}</Button>
        <Button variant="primary" className="rmr-danger-button" onClick={() => { setConfirmUnpair(false); void run('unpair') }}>{t('conn.unpair')}</Button>
      </div>}>
      <p className="rmr-muted">{t('conn.unpairHint')}</p>
    </Modal>
  </div>
}
