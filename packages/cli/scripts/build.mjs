// Bundles the CLI into one ESM file. scripts/build-binaries.mjs turns it into
// a standalone executable (Node single executable application) per platform.
import { build } from 'esbuild'
import { chmod, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const outfile = resolve(root, 'dist/remora.mjs')

// Runs before anything else in remora.mjs: the launcher picks whatever `node`
// it finds, so an old one must fail with advice instead of a stack trace.
const NODE_GUARD = [
  '{const [major, minor] = process.versions.node.split(".").map(Number);',
  'if (major < 22 || (major === 22 && minor < 19)) {',
  'process.stderr.write(`remora: Node.js 22.19 以上が必要です（実行中: ${process.version}、${process.execPath}）。` +',
  '"新しい Node.js を入れるか、REMORA_NODE で使う node を指定するか、REMORA_FORM=binary でインストールし直して単体実行ファイル版を使ってください。\\n");',
  'process.exit(1)}}',
].join('\n')

await build({
  entryPoints: [resolve(root, 'src/bin.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: `#!/usr/bin/env node\n${NODE_GUARD}` },
  define: { __REMORA_VERSION__: JSON.stringify(manifest.version) },
  legalComments: 'none',
  // Japanese messages stay readable and take half the bytes of \\u escapes.
  charset: 'utf8',
})
await chmod(outfile, 0o755)
console.log(`remora@${manifest.version}: built`)
