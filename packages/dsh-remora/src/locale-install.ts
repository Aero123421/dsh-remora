import { en, ja, NS } from './locales.ts'
import type { ClientContext } from './ui/api.ts'
import { zh } from './zh.ts'

/**
 * Register Remora's dictionaries. The language `ja` is defined only by
 * dsh-japanese. This plugin does not define that language. Without it,
 * lookup uses built-in `en`, so the screen shows English rather than key
 * names. Built-in `zh` is already defined by DSH, and this plugin registers
 * the Simplified Chinese dictionary for it. Each locale is registered on
 * its own.
 */
export function installLocale(ctx: Pick<ClientContext, 'effect' | 'locale'>): void {
  ctx.effect(() => {
    const removeEn = ctx.locale.register(NS, 'en', en)
    const removeJa = ctx.locale.register(NS, 'ja', ja)
    const removeZh = ctx.locale.register(NS, 'zh', zh)
    return () => {
      removeZh()
      removeJa()
      removeEn()
    }
  }, 'dsh-remora: copy')
}
