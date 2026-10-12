import { useEffect, useState } from 'react'
import { FORBIDDEN_COMMANDS } from '@dsh-remora/protocol'
import { Button, Input, SegmentedControl, Switch, Tag } from 'remora-official-primitives'
import type { CopyKey } from '../locales.ts'
import type { Catalog, CatalogItem, ScopeSettings } from '../state.ts'
import { call, type ClientContext } from './api.ts'
import type { SectionProps } from './connection.tsx'

type ListKey = 'workspaces' | 'skills' | 'agentPresets' | 'commands' | 'gitHosts' | 'untrustedWorkspaces'

function Head({ title, hint }: { title: string; hint?: string }) {
  return <div className="rmr-section-head" style={{ paddingTop: 16 }}><h3>{title}</h3>{hint ? <span className="rmr-muted">{hint}</span> : null}</div>
}

function AddRow({ placeholder, label, busy, onAdd, normalize = value => value.trim() }: { placeholder: string; label: string; busy: boolean; onAdd: (value: string) => void; normalize?: (value: string) => string }) {
  const [value, setValue] = useState('')
  const submit = () => { const v = normalize(value); if (v !== '') { onAdd(v); setValue('') } }
  return <div className="rmr-inline">
    <Input className="rmr-grow" value={value} placeholder={placeholder} aria-label={placeholder} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') submit() }} />
    <Button variant="outline" size="sm" disabled={busy || normalize(value) === ''} onClick={submit}>{label}</Button>
  </div>
}

/** Catalog entries with a switch each, plus configured names DSH did not list. */
function AllowList({ items, allowed, busy, t, onChange, manualPlaceholder, normalize }: {
  items: CatalogItem[]; allowed: string[]; busy: boolean; t: SectionProps['t']; onChange: (next: string[]) => void; manualPlaceholder: string; normalize?: (value: string) => string
}) {
  const known = new Set(items.map(item => item.id))
  const extra = allowed.filter(id => !known.has(id))
  const set = (id: string, on: boolean) => onChange(on ? [...new Set([...allowed, id])] : allowed.filter(item => item !== id))
  return <div className="rmr-list">
    {items.map(item => <div key={item.id} className="rmr-item">
      <div className="rmr-item-text">
        <span>{item.label}</span>
        {item.path ?? item.description ? <span className="rmr-faint">{item.path ?? item.description}</span> : null}
      </div>
      <Switch checked={allowed.includes(item.id)} label={item.label} disabled={busy} onChange={on => set(item.id, on)} />
    </div>)}
    {extra.map(id => <div key={id} className="rmr-item">
      <span className="rmr-mono">{id}</span>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => set(id, false)}>{t('remove')}</Button>
    </div>)}
    <div style={{ paddingTop: 8 }}><AddRow placeholder={manualPlaceholder} label={t('add')} busy={busy} onAdd={value => set(value, true)} {...(normalize ? { normalize } : {})} /></div>
  </div>
}

export function ScopeSection({ snapshot, t, run, busy, ctx }: SectionProps & { ctx: ClientContext }) {
  const scope = snapshot.settings.scope
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [exceptionMode, setExceptionMode] = useState<'allow' | 'deny'>('allow')
  const [exceptionId, setExceptionId] = useState('')
  const [alias, setAlias] = useState('')
  const [aliasTarget, setAliasTarget] = useState('')
  useEffect(() => { call<Catalog>(ctx, 'catalog').then(setCatalog, () => setCatalog({ workspaces: [], agentPresets: [], skills: [], commands: [], unavailable: ['workspaces', 'agentPresets', 'skills', 'commands'] })) }, [ctx])
  const save = (patch: Partial<ScopeSettings>) => run('settings', { scope: patch })
  const setList = (key: ListKey, next: string[]) => { void save({ [key]: next }) }
  const unavailable = (name: string) => catalog?.unavailable.includes(name) ? <p className="rmr-faint">{t('scope.catalogUnavailable', { name })}</p> : null

  return <div className="rmr-section">
    <p className="rmr-muted">{t('scope.hint')}</p>

    <Head title={t('scope.workspaces')} hint={t('scope.workspacesHint')} />
    {unavailable('workspaces')}
    <AllowList items={catalog?.workspaces ?? []} allowed={scope.workspaces} busy={busy} t={t} manualPlaceholder={t('scope.manual')} onChange={next => setList('workspaces', next)} />
    <div className="rmr-row">
      <div className="rmr-row-text"><span>{t('scope.outside')}</span><span className="rmr-muted">{t('scope.outsideHint')}</span></div>
      <Switch checked={scope.outsideWorkspace} label={t('scope.outside')} disabled={busy} onChange={on => { void save({ outsideWorkspace: on }) }} />
    </div>

    <Head title={t('scope.placements')} hint={t('scope.placementsHint')} />
    <div className="rmr-list">
      {scope.placements.map(placement => <div key={placement.placementId} className="rmr-item">
        <div className="rmr-item-text">
          <span className="rmr-mono">{placement.path}</span>
          {snapshot.invalidPlacements.includes(placement.placementId) ? <span><Tag tone="warning">{t('scope.placementInvalid')}</Tag></span> : null}
        </div>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void run('placement-remove', { placementId: placement.placementId }) }}>{t('remove')}</Button>
      </div>)}
      <div style={{ paddingTop: 8 }}><AddRow placeholder={t('scope.placementPath')} label={t('add')} busy={busy} onAdd={path => { void run('placement-add', { path }) }} /></div>
    </div>

    <Head title={t('scope.exceptions')} hint={t('scope.exceptionsHint')} />
    <div className="rmr-list">
      {scope.exceptions.map(exception => <div key={exception.sessionId} className="rmr-item">
        <span className="rmr-inline"><Tag tone={exception.allow ? 'success' : 'danger'}>{t(exception.allow ? 'scope.allow' : 'scope.deny')}</Tag><span className="rmr-mono">{exception.sessionId}</span></span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void save({ exceptions: scope.exceptions.filter(e => e.sessionId !== exception.sessionId) }) }}>{t('remove')}</Button>
      </div>)}
      <div className="rmr-inline" style={{ paddingTop: 8 }}>
        <SegmentedControl id="rmr-exception-mode" value={exceptionMode} label={t('scope.exceptions')} options={[{ value: 'allow', label: t('scope.allow') }, { value: 'deny', label: t('scope.deny') }]} onChange={setExceptionMode} />
        <Input className="rmr-grow" value={exceptionId} placeholder={t('scope.sessionId')} aria-label={t('scope.sessionId')} onChange={event => setExceptionId(event.target.value)} />
        <Button variant="outline" size="sm" disabled={busy || exceptionId.trim() === ''} onClick={() => {
          const sessionId = exceptionId.trim()
          void save({ exceptions: [...scope.exceptions.filter(e => e.sessionId !== sessionId), { sessionId, allow: exceptionMode === 'allow' }] }).then(ok => { if (ok) setExceptionId('') })
        }}>{t('add')}</Button>
      </div>
    </div>

    <Head title={t('scope.aliases')} hint={t('scope.aliasesHint')} />
    <div className="rmr-list">
      {Object.entries(scope.aliases).map(([name, sessionId]) => <div key={name} className="rmr-item">
        <span><span className="rmr-mono">{name}</span> → <span className="rmr-mono">{sessionId}</span></span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { const next = { ...scope.aliases }; delete next[name]; void save({ aliases: next }) }}>{t('remove')}</Button>
      </div>)}
      <div className="rmr-inline" style={{ paddingTop: 8 }}>
        <Input value={alias} placeholder={t('scope.alias')} aria-label={t('scope.alias')} onChange={event => setAlias(event.target.value)} />
        <Input className="rmr-grow" value={aliasTarget} placeholder={t('scope.sessionId')} aria-label={t('scope.sessionId')} onChange={event => setAliasTarget(event.target.value)} />
        <Button variant="outline" size="sm" disabled={busy || alias.trim() === '' || aliasTarget.trim() === ''} onClick={() => {
          void save({ aliases: { ...scope.aliases, [alias.trim()]: aliasTarget.trim() } }).then(ok => { if (ok) { setAlias(''); setAliasTarget('') } })
        }}>{t('add')}</Button>
      </div>
    </div>

    <p className="rmr-faint" style={{ paddingTop: 16 }}>{t('scope.allowListHint')}</p>
    {([['skills', 'scope.skills', catalog?.skills], ['agentPresets', 'scope.presets', catalog?.agentPresets], ['commands', 'scope.commands', catalog?.commands]] as const).map(([key, title, items]) => <div key={key}>
      <Head title={t(title as CopyKey)} />
      {unavailable(key)}
      <AllowList items={(items ?? []).filter(item => key !== 'commands' || !FORBIDDEN_COMMANDS.has(item.id))} allowed={scope[key]} busy={busy} t={t} manualPlaceholder={t('scope.manual')}
        onChange={next => setList(key, next)} {...(key === 'commands' ? { normalize: (value: string) => { const v = value.trim().toLowerCase(); return v === '' ? '' : v.startsWith('/') ? v : `/${v}` } } : {})} />
    </div>)}

    <Head title={t('scope.gitHosts')} hint={t('scope.gitHostsHint')} />
    <div className="rmr-stack">
      <div className="rmr-chips">
        {scope.gitHosts.map(host => <Tag key={host} tone="neutral">{host}<button type="button" className="rmr-chip-remove" aria-label={`${t('remove')} ${host}`} disabled={busy} onClick={() => setList('gitHosts', scope.gitHosts.filter(h => h !== host))}>×</button></Tag>)}
      </div>
      <AddRow placeholder="github.com" label={t('add')} busy={busy} normalize={value => value.trim().toLowerCase()} onAdd={host => setList('gitHosts', [...scope.gitHosts, host])} />
    </div>

    <Head title={t('scope.untrusted')} hint={t('scope.untrustedHint')} />
    <div className="rmr-list">
      {scope.untrustedWorkspaces.length === 0 ? <span className="rmr-faint">{t('none')}</span> : null}
      {scope.untrustedWorkspaces.map(id => {
        const ws = catalog?.workspaces.find(item => item.id === id)
        return <div key={id} className="rmr-item">
          <div className="rmr-item-text"><span>{ws?.label ?? id}</span>{ws?.path ? <span className="rmr-faint">{ws.path}</span> : null}</div>
          <Button variant="outline" size="sm" disabled={busy || !snapshot.local} title={snapshot.local ? undefined : t('err.local-only')} onClick={() => setList('untrustedWorkspaces', scope.untrustedWorkspaces.filter(item => item !== id))}>{t('scope.trust')}</Button>
        </div>
      })}
    </div>
  </div>
}
