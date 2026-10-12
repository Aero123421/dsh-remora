import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import type { ExecOptions, ExecResult } from '../src/ctx.ts'
import { FileBackend, LayeredTokenStore, openTokenStore, type SecretBackend, type StoredTokens } from '../src/tokens.ts'
import { writePrivate } from '../src/config.ts'
import { testCtx } from './helpers.ts'

const tokens: StoredTokens = {
  hubUrl: 'https://hub.example.com',
  clientId: 'remora-cli',
  scope: 'dsh.read',
  issuer: 'https://hub.example.com',
  tokenEndpoint: 'https://hub.example.com/oauth/token',
  resources: {},
  refreshToken: 'rt-secret',
  access: { default: { token: 'at-secret', expiresAt: null } },
}

/** A fake `secret-tool` backed by a map; `broken` makes `store` fail like a locked keyring. */
function fakeSecretTool(broken: boolean) {
  const secrets = new Map<string, string>()
  const calls: string[][] = []
  const exec = async (command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> => {
    calls.push([command, ...args])
    if (command === 'which') return { code: args[0] === 'secret-tool' ? 0 : 1, stdout: '', stderr: '' }
    if (command !== 'secret-tool') return { code: 127, stdout: '', stderr: 'not found' }
    const account = args[args.length - 1] as string
    if (args[0] === 'store') {
      if (broken) return { code: 1, stdout: '', stderr: 'Cannot create an item in a locked collection' }
      secrets.set(account, options.input ?? '')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'lookup') return secrets.has(account) ? { code: 0, stdout: secrets.get(account) ?? '', stderr: '' } : { code: 1, stdout: '', stderr: '' }
    if (args[0] === 'clear') { secrets.delete(account); return { code: 0, stdout: '', stderr: '' } }
    return { code: 2, stdout: '', stderr: '' }
  }
  return { exec, secrets, calls }
}

test('libsecret keychain is used when available; nothing is written to disk', async () => {
  const fake = fakeSecretTool(false)
  const t = await testCtx({ exec: fake.exec, envExtra: { REMORA_TOKEN_STORE: 'auto', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' } })
  const store = await openTokenStore(t.ctx)
  assert.equal(await store.save(tokens), 'libsecret')
  assert.equal(fake.secrets.size, 1)
  assert.ok(!fake.calls.some(c => c.some(arg => arg.includes('rt-secret'))), 'the secret never appears in argv')
  assert.deepEqual(await (await openTokenStore(t.ctx)).load(tokens.hubUrl), tokens)
  assert.deepEqual(await readdir(t.dir).catch(() => []), [])
  await store.clear(tokens.hubUrl)
  assert.equal(fake.secrets.size, 0)
  assert.equal(t.err.length, 0)
})

test('falls back to a 0600 file with one warning when the keychain fails', async () => {
  const fake = fakeSecretTool(true)
  const t = await testCtx({ exec: fake.exec, envExtra: { REMORA_TOKEN_STORE: 'auto', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' } })
  const store = await openTokenStore(t.ctx)
  assert.equal(await store.save(tokens), 'file')
  assert.equal(await store.save(tokens), 'file')
  assert.equal(t.err.length, 1)
  assert.match(t.err[0] ?? '', /警告.*0600/)
  assert.ok(!(t.err[0] ?? '').includes('rt-secret'), 'warnings never contain tokens')
  const files = await readdir(t.dir)
  assert.equal(files.length, 1)
  assert.equal((await stat(`${t.dir}/${files[0]}`)).mode & 0o777, 0o600)
  assert.deepEqual(await (await openTokenStore(t.ctx)).load(tokens.hubUrl), tokens)
})

test('no D-Bus session means no secret-tool attempt', async () => {
  const fake = fakeSecretTool(false)
  const t = await testCtx({ exec: fake.exec, envExtra: { REMORA_TOKEN_STORE: 'auto' } })
  const store = await openTokenStore(t.ctx)
  assert.equal(await store.save(tokens), 'file')
  assert.equal(fake.calls.length, 0)
  assert.match(t.stderr(), /キーチェーンが使えません/)
})

test('macOS and Windows backends pass secrets on stdin only', async () => {
  const calls: { command: string; args: readonly string[]; input: string | undefined }[] = []
  let stored = ''
  const exec = async (command: string, args: readonly string[], options: ExecOptions = {}): Promise<ExecResult> => {
    calls.push({ command, args, input: options.input })
    if (command === 'which') return { code: 0, stdout: '/usr/bin/security', stderr: '' }
    if (command === 'security' && args[0] === '-i') { stored = /-w "([^"]+)"/.exec(options.input ?? '')?.[1] ?? ''; return { code: 0, stdout: '', stderr: '' } }
    if (command === 'security' && args[0] === 'find-generic-password') return { code: 0, stdout: `${stored}\n`, stderr: '' }
    if (command === 'powershell.exe') {
      const script = Buffer.from(args[args.length - 1] as string, 'base64').toString('utf16le')
      if (script.includes('ConvertFrom-SecureString')) return { code: 0, stdout: `01000000d08c${Buffer.from(options.input ?? '').toString('hex')}\r\n`, stderr: '' }
      return { code: 0, stdout: Buffer.from((options.input ?? '').slice(12), 'hex').toString(), stderr: '' }
    }
    return { code: 1, stdout: '', stderr: '' }
  }
  const mac = await testCtx({ exec, platform: 'darwin', envExtra: { REMORA_TOKEN_STORE: 'auto' } })
  assert.equal(await (await openTokenStore(mac.ctx)).save(tokens), 'macos-keychain')
  assert.ok(calls.every(c => !c.args.some(a => a.includes(Buffer.from(JSON.stringify(tokens)).toString('base64')))))
  const win = await testCtx({ exec, platform: 'win32', envExtra: { REMORA_TOKEN_STORE: 'auto' } })
  assert.equal(await (await openTokenStore(win.ctx)).save(tokens), 'windows-dpapi')
  assert.deepEqual(await (await openTokenStore(win.ctx)).load(tokens.hubUrl), tokens)
  const files = await readdir(win.dir)
  assert.ok(files[0]?.endsWith('.dpapi'))
})

for (const failure of ['throw', 'read-back'] as const) {
  test(`fresh file fallback wins over an old readable keychain after ${failure}`, async t => {
    const fixture = await testCtx()
    t.after(() => rm(fixture.dir, { recursive: true, force: true }))
    const file = new FileBackend(fixture.dir)
    let value: string | null = null
    let broken = false
    const keychain: SecretBackend = {
      name: 'libsecret',
      get: async () => value,
      set: async (_account, next) => {
        if (broken) {
          if (failure === 'throw') throw new Error('locked')
          return
        }
        value = next
      },
      delete: async () => { throw new Error('locked') },
    }
    const store = new LayeredTokenStore(keychain, file, () => {})
    await store.save(tokens)
    broken = true
    const updated: StoredTokens = { ...tokens, scope: 'dsh.read dsh.admin', refreshToken: 'rt-updated' }
    assert.equal(await store.save(updated), 'file')
    const reopened = new LayeredTokenStore(keychain, file, () => {})
    assert.deepEqual(await reopened.load(tokens.hubUrl), updated)
    assert.equal(reopened.location, 'file')

    broken = false
    assert.equal(await reopened.save(updated), 'libsecret')
    assert.equal(await file.get(tokens.hubUrl), null, 'a verified keychain write removes the fallback')
    await reopened.clear(tokens.hubUrl)
    assert.equal(await new LayeredTokenStore(keychain, file, () => {}).load(tokens.hubUrl), null, 'failed deletion cannot restore old credentials')
    assert.ok(!(await file.get(tokens.hubUrl))?.includes('rt-'), 'logout retains only a nonsecret tombstone')
  })
}

test('concurrent atomic writes use private independent temporary files', async t => {
  const fixture = await testCtx()
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  const path = `${fixture.dir}/tokens.json`
  const contents = Array.from({ length: 24 }, (_, i) => JSON.stringify({ i, payload: 'x'.repeat(4096) }))
  await Promise.all(contents.map(content => writePrivate(path, content)))
  assert.ok(contents.includes(await readFile(path, 'utf8')))
  assert.deepEqual(await readdir(fixture.dir), ['tokens.json'])
})

test('a logout tombstone does not suppress the first plaintext fallback warning', async t => {
  const fixture = await testCtx()
  t.after(() => rm(fixture.dir, { recursive: true, force: true }))
  const file = new FileBackend(fixture.dir)
  let value: string | null = null
  let failed = false
  const keychain: SecretBackend = {
    name: 'libsecret',
    get: async () => value,
    set: async (_account, next) => { if (failed) throw new Error('locked'); value = next },
    delete: async () => { value = null },
  }
  const initial = new LayeredTokenStore(keychain, file, () => {})
  await initial.save(tokens)
  await initial.clear(tokens.hubUrl)
  const warnings: string[] = []
  const reopened = new LayeredTokenStore(keychain, file, message => { warnings.push(message) })
  failed = true
  assert.equal(await reopened.save(tokens), 'file')
  assert.equal(await reopened.save({ ...tokens, refreshToken: 'next-refresh' }), 'file')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /0600.*暗号化なし/)
})
