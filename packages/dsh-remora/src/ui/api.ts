/** Settings-tab plumbing: the DSH client context, RPC calls and localized copy. */
import { useEffect, useSyncExternalStore } from 'react'
import { NS, ja, type CopyKey } from '../locales.ts'
import type { RemoraSnapshot } from '../state.ts'
import { SnapshotStore } from './snapshot-store.ts'

export type Translate = (key: CopyKey, params?: Record<string, unknown>) => string

/** One locale's flat dictionary. A missing `zh` entry is not a Chinese dictionary: built-in `zh` falls back to `en`. */
export type LocaleDict = Record<string, string>

export interface LocaleCopy {
  [locale: string]: LocaleDict
}

export interface LocaleLanguage {
  id: string
  label: string
  fallback?: string
}

export interface Locale {
  /**
   * Single-locale form. Remora uses this so a typed object register, which
   * requires a `zh` dictionary, is not how these strings are published.
   * Built-in `zh` has fallback `en`, and lookup walks that chain.
   */
  register(ns: string, locale: string, dict: LocaleDict): () => void
  /** Object form. A locale id that is already present throws. */
  register(ns: string, copy: LocaleCopy): () => void
  /**
   * Host API for defining a language. Remora does not call this. `ja` is
   * defined only by dsh-japanese.
   */
  addLanguage(input: { id: string; label: string; fallback: string }): () => void
  bind(ns: string): (key: string, params?: Record<string, unknown>) => string
  subscribe(listener: () => void): () => void
  getSnapshot(): { revision: number; active: string; locales: readonly LocaleLanguage[] }
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

async function rpcCall<T>(rpc: ClientContext['connection']['rpc'], method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  const result = await rpc.call('/api', `remora/${method}`, payload, signal)
  if (!result.ok) throw new CallError(result.error.code.replace(/^remora\//, ''))
  return result.value as T
}

export function call<T>(ctx: ClientContext, method: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> {
  return rpcCall<T>(ctx.connection.rpc, method, payload, signal)
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

const stores = new WeakMap<ClientContext['connection']['rpc'], SnapshotStore<RemoraSnapshot>>()

/** Share the same state and request ordering between the settings page and chip. */
function snapshotStore(ctx: ClientContext): SnapshotStore<RemoraSnapshot> {
  const rpc = ctx.connection.rpc
  let store = stores.get(rpc)
  if (!store) {
    store = new SnapshotStore<RemoraSnapshot>(
      (method, payload, signal) => rpcCall(rpc, method, payload, signal),
      (value): value is RemoraSnapshot => !!value && typeof value === 'object' && 'settings' in value,
    )
    stores.set(rpc, store)
  }
  return store
}

/** The snapshot, refreshed every `intervalMs` while the page is visible. */
export function useSnapshot(ctx: ClientContext, intervalMs: number) {
  const store = snapshotStore(ctx)
  const { snapshot, failed, lastChecked } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => {
    const release = store.retain(document.visibilityState === 'visible')
    let timer: ReturnType<typeof setInterval> | undefined
    const update = () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      if (document.visibilityState !== 'visible') return
      void store.reload()
      timer = setInterval(() => { void store.reload() }, intervalMs)
    }
    update()
    document.addEventListener('visibilitychange', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      if (timer !== undefined) clearInterval(timer)
      release()
    }
  }, [store, intervalMs])
  return { snapshot, store, failed, lastChecked, reload: store.reload }
}

/** Run a settings action; the returned snapshot replaces the current one. */
export function useAction(t: Translate, store: SnapshotStore<RemoraSnapshot>) {
  const { busy, actionError } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return { run: store.run, busy, error: actionError === null ? null : errorText(t, actionError) }
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
