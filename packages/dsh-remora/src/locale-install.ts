import { en, ja, NS } from './locales.ts'
import type { ClientContext, Locale } from './ui/api.ts'

/**
 * Namespaces dsh-japanese fills with `ja` copy for the DSH shell.
 * The locale catalog does not list other plugins, so a occupied `ja` slot is
 * the signal that one of them is still loaded.
 */
const SHELL_NAMESPACES = ['common', 'settings'] as const

/**
 * Register Remora's dictionaries. `ja` is added only when the catalog does not
 * already have it, matching dsh-japanese. A second `addLanguage` throws.
 * The disposer removes that definition only when no other plugin still has a
 * `ja` dictionary. dsh-japanese skips its own `addLanguage` when Remora added
 * `ja` first, so dropping the definition here would switch the shell back to
 * English. A `ja` that dsh-japanese itself registered is never owned by this
 * disposer. `zh` is the English dictionary: the typed catalog requires it, and
 * Remora has no Chinese copy.
 */
export function installLocale(ctx: Pick<ClientContext, 'effect' | 'locale'>): void {
  if (!ctx.locale.getSnapshot().locales.some(locale => locale.id === 'ja')) {
    ctx.effect(() => {
      const remove = ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' })
      return () => {
        if (shellJaIsRegistered(ctx.locale)) return
        remove()
      }
    }, 'dsh-remora: language')
  }
  ctx.effect(() => ctx.locale.register(NS, { en, ja, zh: en }), 'dsh-remora: copy')
}

function shellJaIsRegistered(locale: Locale): boolean {
  for (const ns of SHELL_NAMESPACES) {
    if (jaSlotIsOccupied(locale, ns)) return true
  }
  return false
}

/** True when `ns` already has a `ja` dictionary. A free slot is taken and released immediately. */
function jaSlotIsOccupied(locale: Locale, ns: string): boolean {
  try {
    const release = locale.register(ns, { ja: { __dshRemoraJaProbe: '1' } })
    release()
    return false
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('already has locale "ja"')) return true
    throw error
  }
}
