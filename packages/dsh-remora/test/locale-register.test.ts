import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { installLocale } from '../src/locale-install.ts'
import { en, ja, NS } from '../src/locales.ts'
import type { Locale, LocaleCopy, LocaleLanguage } from '../src/ui/api.ts'

const src = join(dirname(fileURLToPath(import.meta.url)), '../src')

interface Language extends LocaleLanguage {
  fallback?: string
}

/** dsh-japanese stand-in. The plugin source must not name this host method. */
interface CatalogLocale extends Locale {
  addLanguage(input: { id: string; label: string; fallback: string }): () => void
}

/** Catalog with the same disposer rules as DSH 0.2.1-rc.2. */
function catalog(initial: Language[] = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '简体中文', fallback: 'en' },
]) {
  const languages = new Map(initial.map(language => [language.id, language]))
  const dicts = new Map<string, Map<string, Record<string, string>>>()
  let active = 'en'
  let revision = 0
  const locale: CatalogLocale = {
    getSnapshot: () => ({ revision, active, locales: [...languages.values()] }),
    addLanguage(input) {
      if (languages.has(input.id)) throw new Error(`locale "${input.id}" is already registered`)
      if (!languages.has(input.fallback)) throw new Error(`locale fallback "${input.fallback}" is not registered`)
      const language = { ...input }
      languages.set(input.id, language)
      revision += 1
      return () => {
        if (languages.get(input.id) !== language) return
        languages.delete(input.id)
        if (active === input.id) active = 'en'
        revision += 1
      }
    },
    register(ns: string, localeOrDicts: string | LocaleCopy, dict?: Record<string, string>) {
      let table = dicts.get(ns)
      if (!table) {
        table = new Map()
        dicts.set(ns, table)
      }
      const pairs: Array<[string, Record<string, string>]> = typeof localeOrDicts === 'string'
        ? [[localeOrDicts, dict ?? {}]]
        : Object.entries(localeOrDicts)
      for (const [id] of pairs) if (table.has(id)) throw new Error(`locale namespace "${ns}" already has locale "${id}"`)
      for (const [id, entries] of pairs) table.set(id, entries)
      revision += 1
      return () => {
        let removed = false
        for (const [id, entries] of pairs) {
          if (table.get(id) === entries) {
            table.delete(id)
            removed = true
          }
        }
        if (removed) revision += 1
      }
    },
    bind: ns => (key, params) => {
      const chain = fallback(active)
      const table = dicts.get(ns)
      let template = key
      for (const id of chain) {
        const value = table?.get(id)?.[key]
        if (value !== undefined) {
          template = value
          break
        }
      }
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
    },
    subscribe: () => () => {},
  }
  function fallback(start: string): string[] {
    const chain: string[] = []
    const seen = new Set<string>()
    let current = languages.get(start)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      chain.push(current.id)
      current = current.fallback ? languages.get(current.fallback) : undefined
    }
    if (!seen.has('en')) chain.push('en')
    return chain
  }
  const cleanups: Array<() => void> = []
  const ctx = {
    locale,
    effect(setup: () => () => void) {
      cleanups.push(setup())
    },
  }
  return {
    ctx,
    locale,
    dispose: () => {
      for (const cleanup of [...cleanups].reverse()) cleanup()
      cleanups.length = 0
    },
    hasJa: () => languages.has('ja'),
    active: () => active,
    setActive: (id: string) => {
      active = id
    },
  }
}

/** dsh-japanese stand-in: it owns the `ja` language and the shell's `ja` dictionaries. */
function installJapanese(world: ReturnType<typeof catalog>) {
  const removeLanguage = world.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' })
  const removeCommon = world.locale.register('common', 'ja', { cancel: 'キャンセル' })
  const removeSettings = world.locale.register('settings', 'ja', { trigger: '設定' })
  world.locale.register('common', 'en', { cancel: 'Cancel' })
  world.locale.register('settings', 'en', { trigger: 'Settings' })
  return () => {
    removeSettings()
    removeCommon()
    removeLanguage()
  }
}

test('the plugin registers dictionaries and does not define ja', () => {
  const client = readFileSync(join(src, 'client.tsx'), 'utf8')
  const install = readFileSync(join(src, 'locale-install.ts'), 'utf8')
  assert.match(client, /installLocale\(ctx\)/)
  assert.doesNotMatch(client, /\.addLanguage\s*\(/)
  assert.doesNotMatch(install, /\.addLanguage\s*\(/)
  assert.doesNotMatch(install, /zh:\s*en/)
  const alone = catalog()
  assert.equal(alone.hasJa(), false)
  installLocale(alone.ctx)
  assert.equal(alone.hasJa(), false)
  assert.deepEqual(alone.locale.getSnapshot().locales.map(locale => locale.id), ['en', 'zh'])
  alone.setActive('en')
  assert.equal(alone.locale.bind(NS)('kill.title'), 'Kill switch')
  alone.setActive('zh')
  assert.equal(alone.locale.bind(NS)('kill.title'), en['kill.title'])
  assert.equal(alone.locale.bind(NS)('conn.notPaired'), en['conn.notPaired'])
  assert.notEqual(alone.locale.bind(NS)('kill.title'), 'kill.title')
  assert.notEqual(alone.locale.bind(NS)('conn.notPaired'), 'conn.notPaired')
  alone.setActive('ja')
  assert.equal(alone.locale.bind(NS)('kill.title'), en['kill.title'])
  const release = alone.locale.register(NS, 'zh', { 'kill.title': 'unused' })
  release()
  alone.dispose()
  assert.equal(alone.hasJa(), false)
})

test('with dsh-japanese, Remora is Japanese, and removing Remora first leaves ja until dsh-japanese is removed', () => {
  const world = catalog()
  const removeJapanese = installJapanese(world)
  world.setActive('ja')
  installLocale(world.ctx)
  assert.equal(world.locale.bind(NS)('kill.title'), ja['kill.title'])
  assert.equal(world.locale.bind('settings')('trigger'), '設定')
  world.dispose()
  assert.equal(world.hasJa(), true)
  assert.equal(world.active(), 'ja')
  assert.equal(world.locale.bind('common')('cancel'), 'キャンセル')
  assert.equal(world.locale.bind('settings')('trigger'), '設定')
  removeJapanese()
  assert.equal(world.hasJa(), false)
  assert.equal(world.active(), 'en')
  assert.equal(world.locale.bind('common')('cancel'), 'Cancel')
  assert.equal(world.locale.bind('settings')('trigger'), 'Settings')
  assert.notEqual(world.locale.bind('common')('cancel'), 'cancel')
})

test('removing dsh-japanese first leaves Remora in English, and removing Remora then leaves no ja', () => {
  const world = catalog()
  const removeJapanese = installJapanese(world)
  world.setActive('ja')
  installLocale(world.ctx)
  assert.equal(world.locale.bind(NS)('kill.title'), '緊急停止')
  removeJapanese()
  assert.equal(world.hasJa(), false)
  assert.equal(world.active(), 'en')
  assert.equal(world.locale.bind(NS)('kill.title'), en['kill.title'])
  assert.notEqual(world.locale.bind(NS)('kill.title'), 'kill.title')
  assert.equal(world.locale.bind('common')('cancel'), 'Cancel')
  world.dispose()
  assert.equal(world.hasJa(), false)
  assert.equal(world.locale.bind('common')('cancel'), 'Cancel')
  assert.notEqual(world.locale.bind('settings')('trigger'), 'trigger')
})

test('every visible string has English and Japanese copy, so a missing language does not show the key', () => {
  const keys = Object.keys(ja)
  assert.deepEqual(Object.keys(en).sort(), keys.sort())
  for (const key of keys) {
    assert.notEqual(ja[key as keyof typeof ja], '')
    assert.notEqual(en[key as keyof typeof en], '')
    assert.notEqual(ja[key as keyof typeof ja], key)
    assert.notEqual(en[key as keyof typeof en], key)
  }
})

test('the narrow settings column keeps words intact and constrains inputs', () => {
  const css = readFileSync(join(src, 'styles.css'), 'utf8')
  const start = css.indexOf('@container remora (max-width: 360px)')
  const narrow = css.slice(start, css.indexOf('@media (max-width: 480px)'))
  assert.ok(start > 0)
  assert.match(css, /\.rmr \{[^}]*overflow-wrap: break-word; word-break: normal;/)
  assert.match(css, /\.rmr \* \{ overflow-wrap: break-word; word-break: normal; \}/)
  assert.match(css, /\.rmr \.rmr-mono,\s*\n\.rmr \.rmr-mono \* \{ overflow-wrap: break-word; word-break: break-all; \}/)
  assert.match(css, /\.rmr-row-text \{[^}]*flex: 1 1 12rem;/)
  assert.match(css, /\.rmr-field \{ width: 100%; min-width: 0;/)
  assert.match(readFileSync(join(src, 'ui/connection.tsx'), 'utf8'), /<Input className="rmr-field"/)
  assert.match(narrow, /\.rmr-row-text \{ flex: 1 1 100%; width: 100%; min-width: 0; max-width: 100%; \}/)
  assert.match(narrow, /\.rmr :has\(> input\),\s*\n {2}\.rmr :has\(> textarea\) \{ width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; \}/)
  assert.match(narrow, /\.rmr input,\s*\n {2}\.rmr textarea \{ width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; \}/)
  assert.match(narrow, /\.rmr button \{ max-width: 100%; height: auto; min-height: 28px; white-space: normal;/)
  assert.match(narrow, /overflow-wrap: normal;\s*\n {4}word-break: normal;/)
  assert.match(css, /@media \(max-width: 480px\) \{[\s\S]*\[data-shortcut-modal="settings"\] > div > div:first-child > div button \{/)
  const wide = css.slice(0, start)
  assert.match(wide, /\.rmr-row \{ display: flex; align-items: center; justify-content: space-between; gap: 24px;/)
  assert.doesNotMatch(wide, /\.rmr-row \{[^}]*flex-direction:\s*column/)
  assert.doesNotMatch(wide, /\.rmr-row-text \{[^}]*flex-basis:\s*100%/)
  assert.doesNotMatch(wide, /\.rmr \{[^}]*overflow-wrap:\s*anywhere/)
  assert.doesNotMatch(css, /overflow-wrap:\s*anywhere/)
})
