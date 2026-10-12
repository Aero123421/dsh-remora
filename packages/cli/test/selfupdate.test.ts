import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { main } from '../src/main.ts'
import { EXIT } from '../src/errors.ts'
import { parseSums, replaceBinary } from '../src/selfupdate.ts'
import { testCtx } from './helpers.ts'

const PORT = 18112
const base = `http://127.0.0.1:${PORT}`
const binary = Buffer.from('#!/bin/sh\necho new remora\n')
let sums = ''
let server: Server
let requests: string[] = []

before(async () => {
  server = createServer((req, res) => {
    requests.push(req.url ?? '')
    const release = (tag: string) => ({
      tag_name: tag,
      assets: [
        { name: 'remora-linux-x64', browser_download_url: `${base}/dl/remora-linux-x64` },
        { name: 'remora-win32-x64.exe', browser_download_url: `${base}/dl/remora-linux-x64` },
        { name: 'SHA256SUMS', browser_download_url: `${base}/dl/SHA256SUMS` },
      ],
    })
    if (req.url === '/releases/latest') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(release('v9.9.9'))); return }
    if (req.url === '/releases/tags/v1.2.3') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(release('v1.2.3'))); return }
    if (req.url === '/dl/remora-linux-x64') { res.writeHead(302, { location: '/objects/bin' }); res.end(); return }
    if (req.url === '/objects/bin') { res.writeHead(200); res.end(binary); return }
    if (req.url === '/dl/SHA256SUMS') { res.writeHead(200); res.end(sums); return }
    res.writeHead(404); res.end()
  })
  await new Promise<void>(resolve => server.listen(PORT, '127.0.0.1', resolve))
})
after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))

const goodSums = () => `${createHash('sha256').update(binary).digest('hex')}  remora-linux-x64\n${'0'.repeat(64)}  remora-darwin-arm64\n${createHash('sha256').update(binary).digest('hex')} *remora-win32-x64.exe\n`

async function setup(platform: NodeJS.Platform = 'linux') {
  const t = await testCtx({ platform, envExtra: { REMORA_RELEASES_API: `${base}/releases` } })
  const target = join(t.dir, platform === 'win32' ? 'remora.exe' : 'remora')
  await writeFile(target, 'old', { mode: 0o755 })
  requests = []
  return { t, target }
}

test('parseSums reads sha256sum output', () => {
  const m = parseSums(`${'a'.repeat(64)}  x\n${'B'.repeat(64)} *dir/y\njunk\n`)
  assert.equal(m.get('x'), 'a'.repeat(64))
  assert.equal(m.get('y'), 'b'.repeat(64))
})

test('self-update verifies SHA256SUMS and replaces the binary', async () => {
  sums = goodSums()
  const { t, target } = await setup()
  assert.equal(await main(['self-update', '--target', target], t.ctx), 0, t.stderr())
  assert.deepEqual(await readFile(target), binary)
  assert.match(t.stdout(), /0\.0\.0-dev → 9\.9\.9/)
  assert.deepEqual((await readdir(t.dir)).sort(), ['remora'], 'no temporary files left')
})

test('a checksum mismatch leaves the binary untouched', async () => {
  sums = `${'f'.repeat(64)}  remora-linux-x64\n`
  const { t, target } = await setup()
  assert.equal(await main(['self-update', '--target', target, '--json'], t.ctx), EXIT.failure)
  assert.equal(JSON.parse(t.stdout()).error.code, 'checksum_mismatch')
  assert.equal(await readFile(target, 'utf8'), 'old')
  assert.deepEqual(await readdir(t.dir), ['remora'])
})

test('missing checksum line, --check, a pinned version, and the non-standalone guard', async () => {
  sums = `${'f'.repeat(64)}  something-else\n`
  const a = await setup()
  assert.equal(await main(['self-update', '--target', a.target], a.t.ctx), EXIT.failure)
  assert.match(a.t.stderr(), /SHA256SUMS に remora-linux-x64 の行がありません/)

  const c = await setup()
  assert.equal(await main(['self-update', '--check'], c.t.ctx), 0)
  assert.match(c.t.stdout(), /新しい版があります/)
  assert.deepEqual(requests, ['/releases/latest'])

  sums = goodSums()
  const v = await setup()
  assert.equal(await main(['self-update', '--version', '1.2.3', '--target', v.target, '--json'], v.t.ctx), 0)
  assert.equal(JSON.parse(v.t.stdout()).latest, '1.2.3')

  const s = await setup()
  assert.equal(await main(['self-update'], s.t.ctx), EXIT.usage)
  assert.match(s.t.stderr(), /単体実行ファイル/)
})

test('Windows: the running binary is moved aside, then replaced', async () => {
  sums = goodSums()
  const { t, target } = await setup('win32')
  assert.equal(await main(['self-update', '--target', target], t.ctx), 0, t.stderr())
  assert.deepEqual(await readFile(target), binary)
  const dir = join(t.dir, 'w')
  await import('node:fs/promises').then(fs => fs.mkdir(dir))
  await writeFile(join(dir, 'remora.exe'), 'running')
  await writeFile(join(dir, 'new'), 'fresh')
  await replaceBinary(join(dir, 'remora.exe'), join(dir, 'new'), 'win32')
  assert.equal(await readFile(join(dir, 'remora.exe'), 'utf8'), 'fresh')
})

test('install scripts download the asset names from RELEASE_ASSETS', async () => {
  const { RELEASE_ASSETS } = await import('@dsh-remora/protocol')
  const root = join(import.meta.dirname, '../../..')
  const sh = await readFile(join(root, 'scripts/install.sh'), 'utf8')
  const ps1 = await readFile(join(root, 'scripts/install.ps1'), 'utf8')
  // install.sh builds `remora-${os}-${arch}` with os ∈ {linux, darwin}, arch ∈ {x64, arm64}.
  assert.match(sh, /asset="remora-\$\{os\}-\$\{arch\}"/)
  for (const [os, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    assert.ok(sh.includes(os === 'linux' ? 'Linux) os=linux' : 'Darwin) os=darwin'))
    assert.ok(sh.includes(arch === 'x64' ? 'arch=x64' : 'arch=arm64'))
    assert.equal(RELEASE_ASSETS.cli(os!, arch!), `remora-${os}-${arch}`)
  }
  assert.match(sh, new RegExp(`/${RELEASE_ASSETS.checksums}"`))
  assert.match(ps1, /\$asset = "remora-win32-\$cpu\.exe"/)
  assert.equal(RELEASE_ASSETS.cli('win32', 'x64'), 'remora-win32-x64.exe')
  assert.match(ps1, new RegExp(`/${RELEASE_ASSETS.checksums}"`))
})
