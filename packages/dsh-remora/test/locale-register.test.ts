import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { en, ja } from '../src/locales.ts'

const src = join(dirname(fileURLToPath(import.meta.url)), '../src')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

test('the plugin registers its dictionaries and does not define the ja language', () => {
  const client = readFileSync(join(src, 'client.tsx'), 'utf8')
  assert.match(client, /ctx\.locale\.register\(NS, \{ en, ja \}\)/)
  for (const path of files(src)) {
    assert.equal(readFileSync(path, 'utf8').includes('addLanguage'), false, path)
  }
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
  assert.match(css, /\.rmr \{[^}]*overflow-wrap: normal; word-break: normal;/)
  assert.match(css, /\.rmr \* \{ overflow-wrap: normal; word-break: normal; \}/)
  assert.match(css, /\.rmr \.rmr-mono,\s*\n\.rmr \.rmr-mono \* \{ overflow-wrap: anywhere; word-break: break-all; \}/)
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
})
