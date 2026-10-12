// Bundles the CLI into one ESM file. Standalone binaries (Node SEA or Bun
// compile — decided in P0) are produced from this file by the release job.
import { build } from 'esbuild'
import { chmod, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const outfile = resolve(root, 'dist/remora.mjs')

await build({
  entryPoints: [resolve(root, 'src/bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: { __REMORA_VERSION__: JSON.stringify(manifest.version) },
  legalComments: 'none',
})
await chmod(outfile, 0o755)
console.log(`remora@${manifest.version}: built`)
