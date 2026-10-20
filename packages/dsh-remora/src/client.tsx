/**
 * Remora — DSH Web side.
 *   - settings.section: the "Remora" page in the settings left nav
 *   - plugins.bundle.config: a short entry on the bundle's Plugins page
 *   - sidebar.footer.action: a status chip with a one-click kill switch
 * Built by scripts/build.mjs into a CommonJS module registered through
 * DSH's `window.__ModuleLoader__`; React comes from the host page, and the
 * official DSH primitives are compiled in from pinned DSH source.
 */
import { NS } from './locales.ts'
import { installLocale } from './locale-install.ts'
import css from './styles.css'
import type { ClientContext } from './ui/api.ts'
import { officialCss } from './ui/css-registry.ts'
import { PluginsEntry, RemoraChip, RemoraPage } from './ui/page.tsx'

export const inject = ['slots', 'locale', 'connection']

export function apply(ctx: ClientContext): void {
  installLocale(ctx)
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshRemora = ''
    style.textContent = `${officialCss.join('\n')}\n${css}`
    document.head.append(style)
    return () => style.remove()
  }, 'dsh-remora: styles')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'remora', order: 900, label: () => t('title') },
    () => <RemoraPage ctx={ctx} />,
  ))
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
    { name: 'plugins.bundle.config', key: 'dsh-remora' },
    props => <PluginsEntry ctx={ctx} view={props.view === 'summary' ? 'summary' : 'page'} />,
  ))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'dsh-remora', order: 900, label: () => t('title') },
    props => <RemoraChip ctx={ctx} wide={props.wide !== false} />,
  ))
}
