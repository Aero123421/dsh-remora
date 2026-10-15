// Fetch the pinned official DSH source (upstream.json at the repository root)
// into .cache/upstream and compile entry points against it with esbuild.
// `@deepseek-ai/*` imports resolve to the package sources in that checkout;
// third-party packages (zod, mime-types, ...) resolve from this package's
// devDependencies. Nothing here ships in the plugin.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const repoRoot = resolve(packageRoot, '../..')
export const cacheRoot = join(packageRoot, '.cache')
export const pinned = JSON.parse(await readFile(join(repoRoot, 'upstream.json'), 'utf8'))
const override = process.env.DSH_UPSTREAM_COMMIT?.trim()
if (override !== undefined && override !== '' && !/^[0-9a-f]{40}$/i.test(override)) {
  throw new Error('DSH_UPSTREAM_COMMIT must be a 40-character commit sha')
}
/** Pin from upstream.json, unless DSH_UPSTREAM_COMMIT names another full sha. */
export const upstreamCommit = override && override !== '' ? override.toLowerCase() : pinned.commit
export const upstreamRoot = process.env.DSH_UPSTREAM_DIR ? resolve(process.env.DSH_UPSTREAM_DIR) : join(cacheRoot, 'upstream')

function git(args) {
  const result = spawnSync('git', args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed`)
}

export async function ensureUpstream() {
  const marker = join(upstreamRoot, 'packages/api/session-controller/src/index.ts')
  try {
    await access(marker)
    if (process.env.DSH_UPSTREAM_DIR) return
    const head = spawnSync('git', ['-C', upstreamRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    if (head === upstreamCommit) return
  } catch {}
  if (process.env.DSH_UPSTREAM_DIR) throw new Error(`DSH_UPSTREAM_DIR=${upstreamRoot} has no DSH source`)
  await mkdir(upstreamRoot, { recursive: true })
  git(['init', '-q', upstreamRoot])
  git(['-C', upstreamRoot, 'fetch', '-q', '--depth=1', pinned.repository, upstreamCommit])
  git(['-C', upstreamRoot, 'checkout', '-q', '--detach', 'FETCH_HEAD'])
}

/** `paths` of the official tsconfig.base.json (JSONC): the source-level resolution DSH itself uses. */
async function sourcePaths() {
  const text = await readFile(join(upstreamRoot, 'tsconfig.base.json'), 'utf8')
  const paths = new Map()
  for (const match of text.matchAll(/^\s*"(@deepseek-ai\/[^"]+)":\s*\["([^"]+)"\]/gm)) paths.set(match[1], join(upstreamRoot, match[2]))
  return paths
}

async function existing(candidates) {
  for (const path of candidates) {
    try {
      await access(path)
      if (path.endsWith('.ts') || path.endsWith('.tsx')) return path
      for (const index of ['index.ts', 'index.tsx']) {
        try {
          await access(join(path, index))
          return join(path, index)
        } catch {}
      }
    } catch {}
  }
  return undefined
}

/** Compile `entry` (TypeScript) against the pinned DSH source into an ESM bundle. */
export async function compileOfficial(entry, outfile, extra = {}) {
  await ensureUpstream()
  const paths = await sourcePaths()
  const aliases = {
    name: 'official-dsh-sources',
    setup(builder) {
      builder.onResolve({ filter: /^@dsh-compat\// }, (args) => {
        const target = extra[args.path]
        if (!target) throw new Error(`unknown compat alias ${args.path}`)
        return { path: join(upstreamRoot, target) }
      })
      builder.onResolve({ filter: /^@deepseek-ai\// }, async (args) => {
        if (extra[args.path]) return { path: resolve(packageRoot, extra[args.path]) }
        const exact = paths.get(args.path)
        const [, scope, tail] = args.path.match(/^(@deepseek-ai\/[^/]+)(.*)$/)
        const base = paths.get(scope)
        const sub = tail.replace(/^\//, '')
        const root = base ? (base.endsWith('.ts') ? dirname(base) : base) : undefined
        const path = await existing([
          ...(exact ? [exact] : []),
          ...(root && sub ? [join(root, `${sub}.ts`), join(root, sub), join(root, 'src', `${sub}.ts`), join(root, 'src', sub)] : []),
          ...(base && !sub ? [base] : []),
        ])
        if (path) return { path }
        throw new Error(`No official source entry for ${args.path}`)
      })
    },
  }
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    nodePaths: [join(packageRoot, 'node_modules'), join(repoRoot, 'node_modules')],
    plugins: [aliases],
    // Windows-only native binding of the JSONL persistence backend.
    external: ['koffi'],
    loader: { '.css': 'text', '.md': 'text' },
    logLevel: 'error',
    // DSH services use standard (TC39) decorators for @Remote; esbuild lowers them.
    tsconfigRaw: { compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true, verbatimModuleSyntax: false } },
    banner: { js: "import { createRequire as compatRequireFactory } from 'node:module'; const require = compatRequireFactory(import.meta.url);" },
  })
}

export async function writeEntry(name, source) {
  await mkdir(cacheRoot, { recursive: true })
  const path = join(cacheRoot, name)
  await writeFile(path, source)
  return path
}
