import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { apply } from '../../src/index.ts'
import type { UpdatePluginManager } from '../../src/core/updates.ts'
import { fakeHost, rpc } from '../helpers.ts'

const dir = process.argv[2]
if (!dir) throw new Error('missing profile folder')
const manifest = { name: 'dsh-remora', version: '0.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.1-alpha.2 <0.2.2-0' } }
const content = Buffer.from(JSON.stringify(manifest))
const header = Buffer.alloc(512)
header.write('package/package.json')
header.write(content.length.toString(8).padStart(11, '0'), 124)
header[156] = 48
const tarball = gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512), Buffer.alloc(1024)]))
const sha = createHash('sha256').update(tarball).digest('hex')
let release!: () => void
const download = new Promise<void>(resolve => { release = resolve })
const manager: UpdatePluginManager = {
  listBundles: async () => [{ name: 'dsh-remora', installed: true, enabled: false, version: '0.1.2', source: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.1.2/dsh-remora-0.1.2.tgz' }],
  installBundle: async (_spec, options) => {
    process.send?.({ event: 'manager', requestId: options.requestId, enabled: options.enabled })
    return { changed: true, application: 'restart-required', stage: 'enable', target: 'dsh-remora', bundle: 'dsh-remora', version: '0.2.0' }
  },
}
const host = fakeHost({ profileContext: { dir }, pluginManager: manager })
const core = apply(host.ctx, undefined, {
  dataDir: dir, dshVersion: '0.2.1-alpha.2',
  githubFetch: async url => {
    if (url.startsWith('https://raw.githubusercontent.com/')) return Response.json(manifest)
    if (url.endsWith('/releases/latest')) return Response.json({
      id: 123, draft: false, prerelease: false, tag_name: 'v0.2.0', html_url: 'https://github.com/Aero123421/dsh-remora/releases/tag/v0.2.0',
      assets: [
        { name: 'dsh-remora-0.2.0.tgz', browser_download_url: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.2.0/dsh-remora-0.2.0.tgz' },
        { name: 'SHA256SUMS', browser_download_url: 'https://github.com/Aero123421/dsh-remora/releases/download/v0.2.0/SHA256SUMS' },
      ],
    })
    if (url.endsWith('SHA256SUMS')) return new Response(`${sha}  dsh-remora-0.2.0.tgz\n`)
    process.send?.({ event: 'download' })
    await download
    return new Response(tarball)
  },
})
await core.ready
await core.checkUpdate(true)
process.on('message', (command: { id: number; method: string }) => {
  if (command.method === 'release') release()
  else if (command.method === 'stop') {
    release()
    void core.dispose().then(() => process.disconnect())
  } else {
    void rpc(host.routes, command.method, command.method === 'update-install' ? { version: '0.2.0' } : {}).then(value => {
      process.send?.({ id: command.id, value })
    })
  }
})
process.send?.({ event: 'ready' })
