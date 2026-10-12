/** Settings-tab plumbing: the DSH client context, RPC calls and localized copy. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { NS, ja, type CopyKey } from '../locales.ts'
import type { RemoraSnapshot } from '../state.ts'

export type Translate = (key: CopyKey, params?: Record<string, unknown>) => string

export interface Locale {
  register(ns: string, copy: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  subscribe(listener: () => void): () => void
  getSnapshot(): { revision: number }
}

export interface ClientContext {
  slots: {
    inject(name: string, setup: () => () => void): void
    register(options: { name: string; id?: string; key?: string; order?: number; label?: string | (() => string) }, component: (props: Record<string, unknown>) => unknown): () => void
  }
  locale: Locale
  connection: { rpc: { call(base: string, method: string, payload: unknown, signal?: AbortSignal): Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; details?: { detail?: string } } }> } }
  effect(setup: () => () => void, label?: string): void
}

export class CallError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

export async function call<T>(ctx: ClientContext, method: string, payload: unknown = {}): Promise<T> {
  const result = await ctx.connection.rpc.call('/api', `remora/${method}`, payload)
  if (!result.ok) throw new CallError(result.error.code.replace(/^remora\//, ''))
  return result.value as T
}

export function useCopy(locale: Locale): Translate {
  useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot().revision)
  return locale.bind(NS) as Translate
}

export function errorText(t: Translate, error: unknown): string {
  const code = error instanceof CallError ? error.code : 'unavailable'
  const key = `err.${code}`
  return key in ja ? t(key as CopyKey) : t('err.generic', { code })
}

/** The snapshot, refreshed every `intervalMs` while the page is visible. */
export function useSnapshot(ctx: ClientContext, intervalMs: number) {
  const [snapshot, setSnapshot] = useState<RemoraSnapshot>()
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  const load = useCallback(() => {
    call<RemoraSnapshot>(ctx, 'state').then(value => { if (alive.current) { setSnapshot(value); setFailed(false) } }, () => { if (alive.current) setFailed(true) })
  }, [ctx])
  useEffect(() => {
    alive.current = true
    load()
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, intervalMs)
    return () => { alive.current = false; clearInterval(timer) }
  }, [load, intervalMs])
  return { snapshot, setSnapshot, failed, reload: load }
}

/** Run a settings action; the returned snapshot replaces the current one. */
export function useAction(ctx: ClientContext, t: Translate, apply: (snapshot: RemoraSnapshot) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(async (method: string, payload: unknown = {}): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      const value = await call<RemoraSnapshot>(ctx, method, payload)
      if (value && typeof value === 'object' && 'settings' in value) apply(value)
      return true
    } catch (caught) {
      setError(errorText(t, caught))
      return false
    } finally {
      setBusy(false)
    }
  }, [ctx, t, apply])
  return { run, busy, error, setError }
}

export function formatRemaining(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleString()
}
