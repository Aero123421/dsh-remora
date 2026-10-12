/**
 * Remora — DSH Web side: the "Remora" tab in the settings left nav.
 * Built by scripts/build.mjs into a CommonJS module registered through
 * DSH's `window.__ModuleLoader__`; React comes from the host page.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { RemoraSnapshot } from './state.ts'
import { NS, en, ja } from './locales.ts'
import css from './styles.css'

type Translate = (key: keyof typeof ja) => string

interface Locale {
  register(ns: string, copy: Record<string, Record<string, string>>): () => void
  bind(ns: string): Translate
  subscribe(listener: () => void): () => void
  getSnapshot(): { revision: number }
}

interface ClientContext {
  slots: {
    inject(name: string, setup: () => () => void): void
    register(options: { name: string; id: string; order?: number; label?: string | (() => string) }, component: () => unknown): () => void
  }
  locale: Locale
  connection: { rpc: { call(base: string, method: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string } }> } }
  effect(setup: () => () => void, label?: string): void
}

export const inject = ['slots', 'locale', 'connection']

async function call<T>(ctx: ClientContext, method: string, payload: unknown = {}): Promise<T> {
  const result = await ctx.connection.rpc.call('/api', `remora/${method}`, payload)
  if (!result.ok) throw new Error(result.error.code)
  return result.value as T
}

function useCopy(locale: Locale): Translate {
  useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot().revision)
  return locale.bind(NS)
}

function RemoraSection({ ctx }: { ctx: ClientContext }) {
  const t = useCopy(ctx.locale)
  const [state, setState] = useState<RemoraSnapshot>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    setFailed(false)
    call<RemoraSnapshot>(ctx, 'state').then(setState, () => setFailed(true))
  }, [ctx])
  useEffect(load, [load])
  async function toggleKillSwitch() {
    if (!state) return
    setBusy(true)
    try { setState(await call<RemoraSnapshot>(ctx, 'kill-switch', { on: !state.killSwitch })) }
    catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return <section className="dsh-remora">
    <div><h2>{t('title')}</h2><p className="dsh-remora-muted">{t('description')}</p></div>
    {failed ? <p role="alert">{t('loadFailed')} <button type="button" onClick={load}>{t('retry')}</button></p> : null}
    {state ? <>
      <div className="dsh-remora-rows">
        <div className="dsh-remora-row">
          <span>{t('hub')}</span>
          <span className="dsh-remora-value"><span className="dsh-remora-dot" data-on={state.hub.connected} />{state.hub.connected ? t('connected') : t('notConnected')}</span>
        </div>
        <div className="dsh-remora-row">
          <span>{t('permission')}</span>
          <span className="dsh-remora-value">{t(`level.${state.permission.level}`)}</span>
        </div>
        <div className="dsh-remora-row">
          <div><span>{t('killSwitch')}</span><span className="dsh-remora-muted">{t('killSwitchHint')}</span></div>
          <button type="button" aria-pressed={state.killSwitch} disabled={busy} onClick={() => { void toggleKillSwitch() }}>{state.killSwitch ? t('on') : t('off')}</button>
        </div>
      </div>
      <div className="dsh-remora-rows">
        <div className="dsh-remora-row"><span>{t('available')}</span><span className="dsh-remora-value">{state.features.available.join(', ') || '—'}</span></div>
        {state.features.missing.length > 0 ? <div className="dsh-remora-row"><span>{t('missing')}</span>
          <ul>{state.features.missing.map(item => <li key={item.operation}>{item.operation} ({item.services.join(', ')})</li>)}</ul></div> : null}
        <div className="dsh-remora-row"><span>{t('version')}</span><span className="dsh-remora-value">{state.version} · protocol {state.protocol}</span></div>
      </div>
      <p className="dsh-remora-muted">{t('scaffoldNote')}</p>
    </> : null}
  </section>
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { en, ja }), 'dsh-remora: copy')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshRemora = ''
    style.textContent = css
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-remora: styles')
  const t = ctx.locale.bind(NS)
  const Section = () => <RemoraSection ctx={ctx} />
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'remora', order: 900, label: () => t('title') },
    Section,
  ))
}
