import { test } from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../../src/router.ts'
import { escapeHtml, h, page, raw, visibleText } from '../../src/ui/layout.ts'
import { i18n } from '../../src/i18n/index.ts'

test('routes', () => {
  assert.deepEqual(route('GET', '/'), { kind: 'ui' })
  assert.deepEqual(route('GET', '/healthz'), { kind: 'health' })
  assert.deepEqual(route('POST', '/mcp'), { kind: 'mcp' })
  assert.deepEqual(route('POST', '/api/v1/ops/status'), { kind: 'api', path: '/ops/status' })
  assert.deepEqual(route('GET', '/api/v1'), { kind: 'api', path: '/' })
  assert.deepEqual(route('GET', '/.well-known/oauth-authorization-server'), { kind: 'oauth', path: '/.well-known/oauth-authorization-server' })
  assert.deepEqual(route('GET', '/device'), { kind: 'oauth', path: '/device' })
  assert.deepEqual(route('POST', '/pair/start'), { kind: 'pair-start' })
  assert.deepEqual(route('GET', '/pair/start'), { kind: 'method-not-allowed', allow: 'POST' })
  assert.deepEqual(route('GET', '/pair'), { kind: 'pair-approve' })
  assert.deepEqual(route('POST', '/auth/login/options'), { kind: 'auth', path: '/auth/login/options' })
  assert.deepEqual(route('GET', '/ws/host/h_0123456789'), { kind: 'host-socket', hostId: 'h_0123456789' })
  assert.deepEqual(route('POST', '/ws/host/h_0123456789'), { kind: 'method-not-allowed', allow: 'GET' })
})

test('host ids are validated', () => {
  for (const bad of ['/ws/host/short', '/ws/host/has.dot.in.it', '/ws/host/a/b', `/ws/host/${'x'.repeat(65)}`]) {
    assert.deepEqual(route('GET', bad), { kind: 'not-found' }, bad)
  }
})

test('pages escape outside values', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;')
  const title = '<script>alert(1)</script>'
  const body = h`<p>${title}</p>${raw('<b>ok</b>')}${[h`<i>${'&'}</i>`]}`
  assert.equal(body.value, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><b>ok</b><i>&amp;</i>')
  const html = page({ i18n: i18n('ja'), title, body })
  assert.ok(!html.includes('<script>alert'))
  assert.ok(!/<script>[^<]/.test(html), 'no inline script')
  assert.ok(html.includes('非公式'))
})

test('visibleText shows controls, bidi overrides and zero-width marks; keeps tabs and newlines', () => {
  assert.deepEqual(visibleText('ls -la\n\tgit status'), { text: 'ls -la\n\tgit status', hidden: false })
  assert.deepEqual(visibleText('a\u202eb\u200bc\u0007d\r'), { text: 'a⟦U+202E⟧b⟦U+200B⟧c⟦U+0007⟧d⟦U+000D⟧', hidden: true })
  assert.equal(visibleText('\u2066x\u2069\ufeff').text, '⟦U+2066⟧x⟦U+2069⟧⟦U+FEFF⟧')
})

test('visibleText also marks bidi marks, tag characters, odd spaces and fillers, but not ordinary Japanese', () => {
  assert.equal(visibleText('a؜b\u{E0041}c　d eㅤf️').text, 'a⟦U+061C⟧b⟦U+E0041⟧c⟦U+3000⟧d⟦U+00A0⟧e⟦U+3164⟧f⟦U+FE0F⟧')
  assert.deepEqual(visibleText('git commit -m "日本語のメッセージ・テスト"'), { text: 'git commit -m "日本語のメッセージ・テスト"', hidden: false })
})
