import { test } from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../src/router.ts'
import { escapeHtml, renderHome } from '../src/ui.ts'

test('routes', () => {
  assert.deepEqual(route('GET', '/'), { kind: 'home' })
  assert.deepEqual(route('POST', '/'), { kind: 'method-not-allowed', allow: 'GET, HEAD' })
  assert.deepEqual(route('POST', '/mcp'), { kind: 'mcp' })
  assert.deepEqual(route('GET', '/api/v1/sessions'), { kind: 'api', path: '/sessions' })
  assert.deepEqual(route('GET', '/api/v1'), { kind: 'api', path: '/' })
  assert.deepEqual(route('GET', '/.well-known/oauth-authorization-server'), { kind: 'oauth', path: '/.well-known/oauth-authorization-server' })
  assert.deepEqual(route('GET', '/ws/host/h_0123456789'), { kind: 'host-socket', hostId: 'h_0123456789' })
  assert.deepEqual(route('POST', '/ws/host/h_0123456789'), { kind: 'method-not-allowed', allow: 'GET' })
})

test('host ids are validated', () => {
  for (const bad of ['/ws/host/short', '/ws/host/has.dot.in.it', '/ws/host/a/b', `/ws/host/${'x'.repeat(65)}`]) {
    assert.deepEqual(route('GET', bad), { kind: 'not-found' }, bad)
  }
})

test('the home page escapes outside values', () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;')
  assert.ok(renderHome({ setupComplete: false, hosts: 0, version: '<b>' }).includes('&lt;b&gt;'))
  assert.ok(!renderHome({ setupComplete: true, hosts: 2, version: '1' }).includes('<script'))
})
