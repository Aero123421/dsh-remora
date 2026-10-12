import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MASK, redact, redactLine, redactTruncate } from '../src/redact.ts'

const cases: [string, string, string][] = [
  ['OpenAI key', 'use sk-abcdefghijklmnopqrstuvwx1234 now', `use sk-${MASK} now`],
  ['OpenAI project key', 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx_12', `sk-${MASK}`],
  ['Anthropic key', 'key sk-ant-api03-abcdefghijklmnop_QRST', `key sk-ant-${MASK}`],
  ['GitHub classic', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', `ghp_${MASK}`],
  ['GitHub fine-grained', 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop', `github_pat_${MASK}`],
  ['Slack bot', 'xoxb-1234567890-abcdefghij', `xoxb-${MASK}`],
  ['Slack user', 'token xoxp-1234-5678-abcdefghijk', `token xoxp-${MASK}`],
  ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE', `AKIAIOSF${MASK}`],
  ['Bearer header', 'Authorization: Bearer abc.def-ghi_jkl', `Authorization: Bearer ${MASK}`],
  ['JWT', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', `jwt eyJ${MASK}`],
  ['URL credentials', 'https://alice:s3cr3t@example.com/repo.git', `https://alice:${MASK}@example.com/repo.git`],
  ['.env key', 'OPENAI_API_KEY=abcd1234efgh', `OPENAI_API_KEY=${MASK}`],
  ['.env token quoted', 'GH_TOKEN="hello-world-123"', `GH_TOKEN="${MASK}"`],
  ['.env secret with colon', 'CLIENT_SECRET: zzzzyyyy', `CLIENT_SECRET: ${MASK}`],
  ['.env password', 'DB_PASSWORD = hunter22', `DB_PASSWORD = ${MASK}`],
  ['lower-case config with random value', 'client_secret: a1b2c3d4e5f6g7h8', `client_secret: ${MASK}`],
]

for (const [name, input, expected] of cases) {
  test(`redacts ${name}`, () => {
    assert.equal(redact(input), expected)
  })
}

test('redacts an AWS secret access key assignment', () => {
  const out = redact('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
  assert.ok(!out.includes('wJalrXUtnFEMI'), out)
})

test('redacts a PEM private key block', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx\nabc\n-----END RSA PRIVATE KEY-----'
  const out = redact(`before\n${pem}\nafter`)
  assert.ok(!out.includes('MIIEowIBAAKCAQEAx'))
  assert.match(out, /^before\n-----BEGIN RSA PRIVATE KEY-----\n\[REDACTED\]\n-----END RSA PRIVATE KEY-----\nafter$/)
})

test('redacts an unterminated private key to the end', () => {
  const out = redact('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA')
  assert.ok(!out.includes('b3BlbnNzaC1rZXktdjEAAAAA'))
})

test('leaves ordinary text and code alone', () => {
  const text = [
    'const key = getValue()',
    'monkey = banana',
    'The token budget is 4096.',
    'see /usr/bin/env and https://example.com/path',
    'DEBUG=true',
    'API_KEY=true',
    'password: form.password',
  ].join('\n')
  assert.equal(redact(text), text)
})

test('is idempotent', () => {
  const once = redact('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx and Authorization: Bearer abcdefghijklmnopqrstuvwxyz')
  assert.equal(redact(once), once)
})

test('redactTruncate and redactLine bound the length', () => {
  assert.deepEqual(redactTruncate('abcdef', 4), { text: 'abc…', truncated: true })
  assert.deepEqual(redactTruncate('abc', 4), { text: 'abc', truncated: false })
  assert.equal(redactLine('a\n  b\tc', 120), 'a b c')
  assert.equal(redactLine('x'.repeat(200)).length, 120)
})
