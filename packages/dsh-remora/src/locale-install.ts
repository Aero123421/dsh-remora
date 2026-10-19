import { en, ja, NS } from './locales.ts'
import type { ClientContext } from './ui/api.ts'

/**
 * Register Remora's dictionaries. The language `ja` is defined only by
 * dsh-japanese. This plugin does not define that language. Without it,
 * lookup uses built-in `en`, so the screen shows English rather than key
 * names. No `zh` dictionary is registered. The typed object form of
 * `register` would require one, so each locale is registered on its own.
 * Built-in `zh` falls back to `en`, and a missing key is read from that
 * English dictionary.
 */
export function installLocale(ctx: Pick<ClientContext, 'effect' | 'locale'>): void {
  ctx.effect(() => {
    const removeEn = ctx.locale.register(NS, 'en', en)
    const removeJa = ctx.locale.register(NS, 'ja', ja)
    return () => {
      removeJa()
      removeEn()
    }
  }, 'dsh-remora: copy')
}
