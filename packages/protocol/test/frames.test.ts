import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROTOCOL_VERSION, ProtocolError, hostAuthMessage, isSupportedProtocol, parseHostFrame, parseHubFrame, rotateKeyMessage } from '../src/index.ts'

test('hello frames round-trip', () => {
  const hello = { t: 'hello', protocol: PROTOCOL_VERSION, hostId: 'h1', name: 'desk', plugin: { version: '0.1.0' }, dsh: { version: '0.2.1-alpha.2' }, operations: ['status'], ceiling: { level: 'view' }, killSwitch: false }
  assert.deepEqual(parseHostFrame(JSON.stringify(hello)), hello)
})

test('malformed frames are rejected with a protocol error', () => {
  for (const text of ['nope', '[]', '{"t":"wat"}', '{"t":"hello","hostId":"","protocol":1,"operations":[]}', '{"t":"response","id":"1"}']) {
    assert.throws(() => parseHostFrame(text), ProtocolError, text)
  }
  assert.throws(() => parseHubFrame('{"t":"request","id":"1","op":"status"}'), ProtocolError)
  assert.throws(() => parseHubFrame('{"t":"request","id":"1","op":"status","deadline":1}'), ProtocolError)
  assert.throws(() => parseHostFrame('{"t":"hello","hostId":"h1","protocol":1,"operations":[]}'), ProtocolError)
})

test('hub frames parse', () => {
  const challenge = { t: 'challenge', nonce: 'n', issuedAt: 1, origin: 'https://hub.example' }
  assert.deepEqual(parseHubFrame(JSON.stringify(challenge)), challenge)
})

test('the signed handshake message binds origin, host, nonce and time', () => {
  assert.equal(hostAuthMessage('https://hub.example', 'h1', 'n', 5), 'remora-host-auth/v1\nhttps://hub.example\nh1\nn\n5')
  assert.notEqual(hostAuthMessage('https://evil.example', 'h1', 'n', 5), hostAuthMessage('https://hub.example', 'h1', 'n', 5))
})

test('protocol version support', () => {
  assert.equal(isSupportedProtocol(PROTOCOL_VERSION), true)
  assert.equal(isSupportedProtocol(PROTOCOL_VERSION + 1), false)
  assert.equal(isSupportedProtocol('1'), false)
})

test('key rotation frames parse and the signed message binds the new key', () => {
  assert.equal(parseHubFrame(JSON.stringify({ t: 'rotate-key', nonce: 'n1', issuedAt: 5 })).t, 'rotate-key')
  assert.equal(parseHubFrame(JSON.stringify({ t: 'rotate-key-commit', nonce: 'n1', publicKey: 'k' })).t, 'rotate-key-commit')
  assert.throws(() => parseHubFrame(JSON.stringify({ t: 'rotate-key', nonce: 'n1' })), ProtocolError)
  assert.equal(parseHostFrame(JSON.stringify({ t: 'rotate-key-proof', nonce: 'n1', publicKey: 'k', signature: 's', newSignature: 'z' })).t, 'rotate-key-proof')
  assert.throws(() => parseHostFrame(JSON.stringify({ t: 'rotate-key-proof', nonce: 'n1', publicKey: 'k', signature: 's' })), ProtocolError)
  assert.equal(rotateKeyMessage('https://hub', 'h1', 'n1', 5, 'KEY'), 'remora-rotate-key/v1\nhttps://hub\nh1\nn1\n5\nKEY')
})
