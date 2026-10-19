import { en, ja, NS } from './locales.ts'
import type { ClientContext } from './ui/api.ts'

/**
 * Register Remora's dictionaries. `ja` is added only when the catalog does not
 * already have it, matching dsh-japanese. A second `addLanguage` throws.
 * The disposer removes only the definition this call stored, so a `ja` that
 * dsh-japanese already registered stays after Remora is turned off.
 * `zh` is the English dictionary: the typed catalog requires it, and Remora
 * has no Chinese copy.
 */
export function installLocale(ctx: Pick<ClientContext, 'effect' | 'locale'>): void {
  if (!ctx.locale.getSnapshot().locales.some(locale => locale.id === 'ja')) {
    ctx.effect(() => ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }), 'dsh-remora: language')
  }
  ctx.effect(() => ctx.locale.register(NS, { en, ja, zh: en }), 'dsh-remora: copy')
}
