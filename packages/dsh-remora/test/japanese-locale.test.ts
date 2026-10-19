import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachJapanese, hasJapanese, JAPANESE_LANGUAGE } from '../src/japanese.ts'
import { NS } from '../src/locales.ts'

interface Language { id: string; label: string; fallback: string }

function localeFixture(initial: Language[] = []) {
  const languages = [...initial]
  const copies = new Map<string, Record<string, Record<string, string>>>()
  const calls: string[] = []
  return {
    languages,
    copies,
    calls,
    locale: {
      register(ns: string, copy: Record<string, Record<string, string>>) {
        calls.push(`register:${ns}`)
        if (copies.has(ns)) throw new Error(`locale namespace "${ns}" already has locale`)
        copies.set(ns, copy)
        return () => {
          calls.push(`dispose-copy:${ns}`)
          copies.delete(ns)
        }
      },
      getSnapshot() {
        return { locales: languages.map(language => ({ ...language })) }
      },
      addLanguage(input: Language) {
        calls.push(`add:${input.id}`)
        if (languages.some(language => language.id.toLowerCase() === input.id.toLowerCase())) {
          throw new Error(`locale "${input.id}" is already registered`)
        }
        const language = { ...input }
        languages.push(language)
        return () => {
          calls.push(`dispose-language:${input.id}`)
          const index = languages.indexOf(language)
          if (index >= 0) languages.splice(index, 1)
        }
      },
    },
  }
}

test('registers Japanese when the catalog has no ja, and removes only that definition', () => {
  const { locale, languages, copies, calls } = localeFixture([{ id: 'en', label: 'English', fallback: 'en' }])
  const dispose = attachJapanese(locale)
  assert.deepEqual(calls, ['register:dsh.remora', 'add:ja'])
  assert.equal(hasJapanese(languages), true)
  assert.deepEqual(languages.at(-1), JAPANESE_LANGUAGE)
  assert.ok(copies.get(NS)?.ja)
  assert.ok(copies.get(NS)?.en)
  dispose()
  assert.deepEqual(calls.slice(2), ['dispose-copy:dsh.remora', 'dispose-language:ja'])
  assert.equal(hasJapanese(languages), false)
  assert.equal(copies.has(NS), false)
})

test('does not add or remove ja that another plugin already registered', () => {
  const existing = { id: 'ja', label: '日本語', fallback: 'en' }
  const { locale, languages, copies, calls } = localeFixture([existing])
  const dispose = attachJapanese(locale)
  assert.deepEqual(calls, ['register:dsh.remora'])
  dispose()
  assert.deepEqual(languages, [existing])
  assert.equal(copies.has(NS), false)
  assert.deepEqual(calls, ['register:dsh.remora', 'dispose-copy:dsh.remora'])
})

test('treats an already-registered error as another plugin winning the race', () => {
  const existing = { id: 'ja', label: '日本語', fallback: 'en' }
  const { locale, languages, calls } = localeFixture([existing])
  locale.getSnapshot = () => ({ locales: [] })
  const dispose = attachJapanese(locale)
  assert.deepEqual(calls, ['register:dsh.remora', 'add:ja'])
  dispose()
  assert.deepEqual(languages, [existing])
  assert.equal(calls.includes('dispose-language:ja'), false)
})

test('a plugin that loads afterwards leaves the language the first plugin added', () => {
  const first = localeFixture()
  const disposeFirst = attachJapanese(first.locale)
  const second = localeFixture()
  second.languages.splice(0, second.languages.length, ...first.languages)
  const disposeSecond = attachJapanese({
    ...second.locale,
    getSnapshot: () => ({ locales: first.languages }),
    addLanguage(input) {
      second.calls.push(`add:${input.id}`)
      throw new Error(`locale "${input.id}" is already registered`)
    },
  })
  assert.equal(second.calls.includes('add:ja'), false)
  disposeSecond()
  assert.equal(hasJapanese(first.languages), true)
  disposeFirst()
  assert.equal(hasJapanese(first.languages), false)
})

test('skips addLanguage when the host locale service does not provide it', () => {
  const { locale, copies } = localeFixture()
  const legacy = { register: locale.register, getSnapshot: locale.getSnapshot }
  const dispose = attachJapanese(legacy)
  assert.ok(copies.has(NS))
  dispose()
  assert.equal(copies.has(NS), false)
})

test('drops the dictionary when addLanguage fails for another reason', () => {
  const { locale, copies } = localeFixture()
  locale.addLanguage = () => { throw new Error('locale fallback "en" is not registered') }
  assert.throws(() => attachJapanese(locale), /fallback/)
  assert.equal(copies.has(NS), false)
})

test('the narrow settings column keeps words intact and constrains inputs', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/styles.css'), 'utf8')
  const start = css.indexOf('@container remora (max-width: 360px)')
  const narrow = css.slice(start, css.indexOf('/* Sidebar chip */'))
  assert.ok(start > 0)
  assert.match(narrow, /\.rmr \{ overflow-wrap: normal; \}/)
  assert.match(narrow, /\.rmr-mono \{ overflow-wrap: anywhere; word-break: break-all; \}/)
  assert.match(narrow, /\.rmr-row-text \{ flex: 1 1 100%; width: 100%; \}/)
  assert.match(narrow, /\.rmr input,\s*\n {2}\.rmr textarea \{ width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; \}/)
  assert.match(narrow, /overflow-wrap: normal;\s*\n {4}word-break: normal;/)
  const wide = css.slice(0, start)
  assert.match(wide, /\.rmr-row \{ display: flex; align-items: center; justify-content: space-between; gap: 24px;/)
  assert.doesNotMatch(wide, /\.rmr-row \{[^}]*flex-direction:\s*column/)
  assert.doesNotMatch(wide, /\.rmr-row-text \{[^}]*flex-basis:\s*100%/)
})
