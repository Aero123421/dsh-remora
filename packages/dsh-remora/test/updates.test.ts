import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { checkForUpdate, compareVersions, downloadVerified, expectedHash, UpdateError } from '../src/core/updates.ts'
import { tempDir } from './helpers.ts'

test('semver comparison handles pre-releases', () => {
  assert.ok(compareVersions('0.1.0', '0.0.9') > 0)
  assert.ok(compareVersions('v1.0.0', '1.0.0-rc.1') > 0)
  assert.ok(compareVersions('1.0.0-rc.2', '1.0.0-rc.10') < 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
})

const tarball = new TextEncoder().encode('fake tarball bytes')
const sha = createHash('sha256').update(tarball).digest('hex')

function github(sums: string) {
  return async (url: string) => {
    if (url.endsWith('/releases/latest')) {
      return Response.json({
        tag_name: 'v0.2.0', name: 'v0.2.0', body: 'Notes', html_url: 'https://github.com/Aero123421/dsh-remora/releases/tag/v0.2.0',
        assets: [
          { name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://example.test/dsh-remora-0.2.0.tgz' },
          { name: 'SHA256SUMS', browser_download_url: 'https://example.test/SHA256SUMS' },
        ],
      })
    }
    if (url.endsWith('SHA256SUMS')) return new Response(sums)
    return new Response(tarball)
  }
}

test('a newer release is found and its tarball is verified against SHA256SUMS', async () => {
  const check = await checkForUpdate('0.1.0', github(`${sha}  dsh-remora-0.2.0.tgz\n`))
  assert.equal(check.newer, true)
  assert.equal(check.latest?.version, '0.2.0')
  assert.equal(expectedHash(`${sha}  dsh-remora-0.2.0.tgz`, 'dsh-remora-0.2.0.tgz'), sha)
  const t = await tempDir()
  try {
    const path = await downloadVerified(check.latest!, t.dir, github(`${sha}  dsh-remora-0.2.0.tgz\n`))
    assert.deepEqual(new Uint8Array(await readFile(path)), tarball)
    await assert.rejects(downloadVerified(check.latest!, t.dir, github(`${'0'.repeat(64)}  dsh-remora-0.2.0.tgz\n`)), (error: unknown) => error instanceof UpdateError && error.code === 'checksum-mismatch')
    await assert.rejects(downloadVerified(check.latest!, t.dir, github('')), (error: unknown) => error instanceof UpdateError && error.code === 'no-checksum')
  } finally { await t.cleanup() }
  const none = await checkForUpdate('0.1.0', async () => new Response('', { status: 404 }))
  assert.deepEqual([none.latest, none.newer, none.error], [null, false, undefined])
})
