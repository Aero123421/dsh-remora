// Builds the DSH plugin into dist/: a Node ESM host entry and a browser
// module for DSH Web. @dsh-remora/protocol is bundled in, so the published
// package has no runtime dependencies and no install scripts.
import { build } from 'esbuild'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { ensureUpstream } from './upstream.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(root, '../..')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const define = { __REMORA_VERSION__: JSON.stringify(manifest.version) }

await rm(resolve(root, 'dist'), { recursive: true, force: true })
await mkdir(resolve(root, 'dist'), { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  define,
  legalComments: 'none',
})

// The settings tab renders DSH's own primitives, compiled from pinned source.
const upstream = await ensureUpstream()
const primitivesDir = resolve(upstream, 'packages/client/ui-primitives/src')
const officialEntry = resolve(root, '.cache/official-primitives.ts')
await mkdir(dirname(officialEntry), { recursive: true })
await writeFile(officialEntry, ['Button', 'Switch', 'Input', 'Modal', 'SegmentedControl', 'Tag', 'StateDot']
  .map(name => `export { ${name} } from ${JSON.stringify(resolve(primitivesDir, `${name}.tsx`))}`).join('\n') + '\n')
const registry = resolve(root, 'src/ui/css-registry.ts')
const officialPrimitives = {
  name: 'official-primitives',
  setup(builder) {
    builder.onResolve({ filter: /^remora-official-primitives$/ }, () => ({ path: officialEntry }))
    // CSS modules: class names get a stable per-file prefix; the CSS text is
    // registered at load and injected by the client together with styles.css.
    builder.onLoad({ filter: /\.module\.css$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      const prefix = `remora_${createHash('sha256').update(path.slice(upstream.length)).digest('hex').slice(0, 8)}_`
      const classes = Object.fromEntries([...source.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => [match[1], prefix + match[1]]))
      let css = source.replace(/:global\(([^)]+)\)/g, (_, selector) => selector.replaceAll('.', '__GLOBAL_DOT__'))
      css = css.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${classes[name]}`).replaceAll('__GLOBAL_DOT__', '.')
      return { contents: `import { addOfficialCss } from ${JSON.stringify(registry)};\naddOfficialCss(${JSON.stringify(css)});\nexport default ${JSON.stringify(classes)};`, loader: 'js' }
    })
  },
}

const client = await build({
  entryPoints: [resolve(root, 'src/client.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  loader: { '.css': 'text' },
  define,
  minify: true,
  write: false,
  plugins: [officialPrimitives],
  nodePaths: [resolve(root, 'node_modules')],
  legalComments: 'eof',
})
// DSH Web loads third-party client code through its module loader; the
// factory receives the host's `require` for the shared React instance.
await writeFile(resolve(root, 'dist/client.js'),
  `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory(require){const module={exports:{}};const exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`)

// Files listed in package.json "files" that live at the repository root.
await mkdir(resolve(root, 'assets'), { recursive: true })
await copyFile(resolve(repo, 'LICENSE'), resolve(root, 'LICENSE'))
await copyFile(resolve(repo, 'NOTICE.md'), resolve(root, 'NOTICE.md'))
await copyFile(resolve(repo, 'assets/remora-mark.svg'), resolve(root, 'assets/remora-mark.svg'))

console.log(`${manifest.name}@${manifest.version}: built`)
