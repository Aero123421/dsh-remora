import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOCALES, hasMessage, i18n, localeOf, negotiate } from '../../src/i18n/index.ts'
import { en } from '../../src/i18n/en.ts'
import { ja } from '../../src/i18n/ja.ts'
import { zh } from '../../src/i18n/zh.ts'
import { h, raw } from '../../src/ui/html.ts'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

test('Accept-Language picks the best supported language, else English', () => {
  assert.equal(negotiate(null), 'en')
  assert.equal(negotiate(''), 'en')
  assert.equal(negotiate('ja'), 'ja')
  assert.equal(negotiate('ja-JP,ja;q=0.9,en;q=0.8'), 'ja')
  assert.equal(negotiate('zh-CN,zh;q=0.9'), 'zh')
  assert.equal(negotiate('zh-TW'), 'zh')
  assert.equal(negotiate('fr-FR,fr;q=0.9,ja;q=0.5,en;q=0.7'), 'en')
  assert.equal(negotiate('de, ja;q=0.2'), 'ja')
  assert.equal(negotiate('ja;q=0, zh;q=0.1'), 'zh')
  assert.equal(negotiate('ko-KR'), 'en')
})

test('the remora_lang cookie wins over Accept-Language; a bad value is ignored', () => {
  const request = (cookie: string | null, language: string | null) => new Request('https://hub.example.com/', { headers: { ...(cookie ? { cookie } : {}), ...(language ? { 'accept-language': language } : {}) } })
  assert.equal(localeOf(request('remora_lang=zh', 'ja')), 'zh')
  assert.equal(localeOf(request('a=b; remora_lang=en', 'ja')), 'en')
  assert.equal(localeOf(request('remora_lang=xx', 'ja')), 'ja')
  assert.equal(localeOf(request(null, null)), 'en')
})

test('every language has every key, with the same placeholders', () => {
  for (const [name, catalog] of [['ja', ja], ['zh', zh]] as const) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(en).sort(), `${name} keys`)
    for (const [key, value] of Object.entries(en)) {
      assert.deepEqual(placeholders((catalog as Record<string, string>)[key] ?? ''), placeholders(value), `${name} ${key}`)
      assert.notEqual(((catalog as Record<string, string>)[key] ?? '').trim(), '', `${name} ${key} is empty`)
    }
  }
})

test('t fills placeholders; rich escapes the message and keeps markup values', () => {
  const ja = i18n('ja')
  assert.equal(ja.t('host.limit', { level: '見るだけ' }), '上限: 見るだけ')
  assert.equal(i18n('en').t('host.limit'), 'Limit: {level}')
  const marked = i18n('en').rich('error.fixHub', { link: h`<a href="/connections">${'<this hub>'}</a>` })
  assert.equal(marked.value, 'You can change this on <a href="/connections">&lt;this hub&gt;</a>.')
  assert.equal(i18n('en').rich('host.limit', { level: '<b>' }).value, 'Limit: &lt;b&gt;')
  assert.equal(i18n('en').rich('host.limit', { level: raw('<b>x</b>') }).value, 'Limit: <b>x</b>')
  assert.ok(hasMessage('op.task.start'))
  assert.ok(!hasMessage('op.no-such-operation'))
  assert.ok(!hasMessage('toString'))
})

test('times: UTC on the server with a machine-readable stamp; relative and countdown words per language', () => {
  const at = Date.UTC(2026, 9, 19, 5, 7)
  for (const locale of LOCALES) {
    const time = i18n(locale).time(at).value
    assert.match(time, /^<time datetime="2026-10-19T05:07:00.000Z" data-ts="\d+">.+ UTC<\/time>$/)
  }
  const now = at + 5 * 60_000
  assert.equal(i18n('en').relative(at, now), '5 minutes ago')
  assert.equal(i18n('ja').relative(at, now), '5 分前')
  assert.match(i18n('zh').relative(at, now), /5.*分钟前/)
  assert.equal(i18n('en').relative(null), '—')
  assert.equal(i18n('en').countdown(now + 65_000, now), '1:05 left')
})

test('scripts get only the js.* and time.* strings', () => {
  const client = i18n('ja').client()
  assert.equal(client['js.copied'], 'コピーしました')
  assert.equal(client['time.expired'], '期限切れ')
  assert.ok(Object.keys(client).every(key => key.startsWith('js.') || key.startsWith('time.')))
})
