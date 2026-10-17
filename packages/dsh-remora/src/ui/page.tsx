import { useEffect, useRef, useState } from 'react'
import { Button, SegmentedControl } from 'remora-official-primitives'
import type { RemoraSnapshot } from '../state.ts'
import { formatTime, useAction, useCopy, useSnapshot, type ClientContext, type Translate } from './api.ts'
import { ActivitySection, CompatSection } from './activity.tsx'
import { ConnectionSection } from './connection.tsx'
import { FullBadge, PermissionsSection } from './permissions.tsx'
import { ScopeSection } from './scope.tsx'

type Tab = 'connection' | 'permissions' | 'scope' | 'activity' | 'compat'
const TABS: Tab[] = ['connection', 'permissions', 'scope', 'activity', 'compat']

function KillSwitch({ snapshot, t, run, busy }: { snapshot: RemoraSnapshot; t: Translate; run: (method: string, payload?: unknown) => Promise<boolean>; busy: boolean }) {
  const on = snapshot.settings.killSwitch
  return <div className="rmr-kill" data-on={on} id="kill-switch" data-testid="remora-kill-switch">
    <div className="rmr-row-text">
      <span>{t('kill.title')}</span>
      <span className="rmr-muted">{on ? t('kill.active') : t('kill.hint')}</span>
    </div>
    {on
      ? <Button variant="outline" size="sm" disabled={busy || !snapshot.local} title={snapshot.local ? undefined : t('err.local-only')} onClick={() => { void run('kill-switch', { on: false }) }}>{t('kill.resume')}</Button>
      : <Button variant="primary" size="sm" className="rmr-danger-button" disabled={busy} onClick={() => { void run('kill-switch', { on: true }) }}>{t('kill.stop')}</Button>}
  </div>
}

/** The Remora page in DSH's settings panel. */
export function RemoraPage({ ctx }: { ctx: ClientContext }) {
  const t = useCopy(ctx.locale)
  const { snapshot, store, failed, lastChecked, reload } = useSnapshot(ctx, 2_000)
  const { run, busy, error } = useAction(t, store)
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const stored = sessionStorage.getItem('dsh-remora:tab')
      return TABS.includes(stored as Tab) ? stored as Tab : 'connection'
    } catch { return 'connection' }
  })
  const top = useRef<HTMLDivElement>(null)
  useEffect(() => { try { sessionStorage.setItem('dsh-remora:tab', tab) } catch { /* storage may be unavailable */ } }, [tab])

  return <div className="rmr" ref={top} data-testid="remora-page">
    <div className="rmr-header">
      <div className="rmr-title-row">
        <h2 className="rmr-title">{t('title')}</h2>
        {snapshot?.fullAccess.active ? <FullBadge t={t} expiresAt={snapshot.fullAccess.expiresAt} now={snapshot.now} /> : null}
      </div>
      <p className="rmr-muted">{t('description')}</p>
    </div>
    {failed ? <div className="rmr-notice" role="alert">
      <div className="rmr-inline"><span>{t('loadFailed')}</span><Button variant="outline" size="sm" onClick={reload}>{t('retry')}</Button></div>
      {snapshot ? <p>{t('staleState')}</p> : null}
      {lastChecked !== null ? <p>{t('lastChecked', { time: formatTime(lastChecked) })}</p> : null}
    </div> : !snapshot ? <p className="rmr-muted" role="status">{t('loading')}</p> : null}
    {snapshot?.ready === false ? <div className="rmr-notice" data-tone="danger" role="alert"><p>{t('initFailed')}</p><p>{snapshot.fatal}</p><Button variant="outline" size="sm" onClick={reload}>{t('retry')}</Button></div> : snapshot ? <>
      {snapshot.local ? null : <p className="rmr-notice" data-tone="info">{t('remoteNotice')}</p>}
      <KillSwitch snapshot={snapshot} t={t} run={run} busy={busy} />
      {error ? <p className="rmr-error" role="alert">{error}</p> : null}
      <div className="rmr-tabs-scroll">
        <SegmentedControl id="rmr-tabs" className="rmr-tabs" value={tab} label={t('title')} options={TABS.map(value => ({ value, label: t(`tab.${value}`) }))} onChange={setTab} />
      </div>
      <div id={`rmr-tabs-${tab}-panel`} role="tabpanel" aria-labelledby={`rmr-tabs-${tab}`}>
        {tab === 'connection' ? <ConnectionSection snapshot={snapshot} t={t} run={run} busy={busy} /> : null}
        {tab === 'permissions' ? <PermissionsSection snapshot={snapshot} t={t} run={run} busy={busy} /> : null}
        {tab === 'scope' ? <ScopeSection snapshot={snapshot} t={t} run={run} busy={busy} ctx={ctx} /> : null}
        {tab === 'activity' ? <ActivitySection snapshot={snapshot} t={t} ctx={ctx} /> : null}
        {tab === 'compat' ? <CompatSection snapshot={snapshot} t={t} ctx={ctx} busy={busy} /> : null}
      </div>
    </> : null}
  </div>
}

/** Small status chip beside Settings at the sidebar foot, with a one-click kill switch. */
export function RemoraChip({ ctx, wide }: { ctx: ClientContext; wide: boolean }) {
  const t = useCopy(ctx.locale)
  const { snapshot, store, failed, lastChecked, reload } = useSnapshot(ctx, 15_000)
  const { run, busy, error } = useAction(t, store)
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const focusTarget = popover.current?.querySelector<HTMLButtonElement>('button') ?? popover.current
    focusTarget?.focus()
    const close = (event: MouseEvent) => { if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  if (!snapshot || (!snapshot.hub.paired && snapshot.ready !== false)) return null
  const tone = failed || snapshot.ready === false ? 'stale' : snapshot.settings.killSwitch ? 'stopped' : snapshot.fullAccess.active ? 'full' : snapshot.hub.link.state === 'connected' ? 'connected' : 'offline'
  const label = t(tone === 'stale' ? 'chip.stale' : tone === 'stopped' ? 'chip.stopped' : tone === 'full' ? 'chip.full' : tone === 'connected' ? 'chip.connected' : 'chip.offline')
  return <div className="rmr-chip-wrap" ref={wrap} onBlur={event => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false)
  }}>
    <button ref={trigger} type="button" className="rmr-chipbtn" aria-haspopup="dialog" data-tone={tone} aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className="rmr-dot" data-tone={tone} />{wide ? <span>{label}</span> : null}
    </button>
    {open ? <div ref={popover} className="rmr-popover" role="dialog" tabIndex={-1} aria-label={label}>
      <strong>{label}</strong>
      {failed ? <>
        <span>{t('staleState')}</span>
        {lastChecked !== null ? <span className="rmr-faint">{t('lastChecked', { time: formatTime(lastChecked) })}</span> : null}
        <Button variant="outline" size="sm" onClick={reload}>{t('retry')}</Button>
      </> : null}
      {snapshot.ready === false ? <span className="rmr-error">{t('initFailed')} {snapshot.fatal}</span> : null}
      {snapshot.fullAccess.active ? <FullBadge t={t} expiresAt={snapshot.fullAccess.expiresAt} now={snapshot.now} /> : null}
      {snapshot.ready === false ? null : snapshot.settings.killSwitch
        ? <Button variant="outline" size="sm" disabled={busy || !snapshot.local} onClick={() => { void run('kill-switch', { on: false }) }}>{t('kill.resume')}</Button>
        : <Button variant="primary" size="sm" className="rmr-danger-button" disabled={busy} onClick={() => { void run('kill-switch', { on: true }) }}>{t('kill.stop')}</Button>}
      {error ? <span className="rmr-error">{error}</span> : null}
      <span className="rmr-faint">{t('chip.menuHint')}</span>
    </div> : null}
  </div>
}

/** Entry on DSH's Plugins page (the bundle's own configuration cell). */
export function PluginsEntry({ ctx, view }: { ctx: ClientContext; view: 'summary' | 'page' }) {
  const t = useCopy(ctx.locale)
  return view === 'summary' ? <span>{t('plugins.summary')}</span> : <PluginsStatus ctx={ctx} />
}

function PluginsStatus({ ctx }: { ctx: ClientContext }) {
  const t = useCopy(ctx.locale)
  const { snapshot, failed } = useSnapshot(ctx, 15_000)
  const link = snapshot?.hub.link.state
  return <div className="rmr rmr-stack">
    <p className="rmr-muted">{t('plugins.summary')}</p>
    {snapshot?.ready === false ? <p className="rmr-error" role="alert">{t('initFailed')} {snapshot.fatal}</p> : null}
    {snapshot ? <p className="rmr-faint">{failed || snapshot.ready === false ? t('chip.stale') : snapshot.hub.paired ? t(link === 'connected' ? 'chip.connected' : 'chip.offline') : t('conn.notPaired')} · {t(`perm.level.${snapshot.settings.ceiling.level}` as 'perm.level.view')}{snapshot.settings.killSwitch ? ` · ${t('kill.title')}` : ''}</p> : null}
  </div>
}
