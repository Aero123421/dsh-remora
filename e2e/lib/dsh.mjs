// Real DSH from npm, in an isolated world.
//
//   install   npm install @deepseek-ai/dsh@<version> into .cache/e2e/dsh-<version>
//             (outside every workspace; reused across runs, `--fresh-dsh` reinstalls)
//   world     a temp dir with its own HOME, DSH_HOME, DSH_AGENTS_HOME and working dir,
//             so nothing is read from or written to the developer's ~/.dsh
//   plugin    `dsh plugin --profile web add <tarball>` — DSH's supported install path
//   web       `dsh web --patch <world>/e2e.patch.yml --no-open --host <ip> --port <port>`
//
// The model: DSH's native DeepSeek adapter speaks Anthropic Messages and
// honours $DEEPSEEK_BASE_URL, so DEEPSEEK_API_KEY=<anything> plus
// DEEPSEEK_BASE_URL=<mock> sends every model call (and the session-log
// contribution that rides on them) to e2e/lib/mock-llm.mjs. No settings,
// catalog or Models-page edits are needed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { childEnv, run, start } from './procs.mjs'

export const DSH_PACKAGE = '@deepseek-ai/dsh'

/** Install (or reuse) DSH from the npm registry; returns the absolute path of its `dsh` bin script. */
export async function installDsh({ version, dir, fresh = false, logFile }) {
  const manifest = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const installed = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : undefined
  if (fresh || installed !== version) {
    await rm(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'remora-e2e-dsh', private: true, dependencies: { [DSH_PACKAGE]: version } }, null, 2)}\n`)
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    await run('npm install dsh', npm, ['install', '--no-audit', '--no-fund', '--save-exact'], { cwd: dir, env: childEnv(), logFile, timeoutMs: 600_000 })
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  if (pkg.version !== version) throw new Error(`expected ${DSH_PACKAGE}@${version}, found ${pkg.version}`)
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh
  if (!bin) throw new Error(`${DSH_PACKAGE} has no "dsh" bin`)
  return { bin: resolve(dirname(manifest), bin), version: pkg.version }
}

/** Create the isolated world. `documents` is where DSH creates its default workspace. */
export async function createWorld() {
  const root = await mkdtemp(join(tmpdir(), 'remora-e2e-'))
  const world = {
    root,
    home: join(root, 'home'),
    dshHome: join(root, 'dsh-home'),
    agentsHome: join(root, 'agents-home'),
    work: join(root, 'work'),
    documents: join(root, 'home', 'Documents'),
    patch: join(root, 'e2e.patch.yml'),
    hubState: join(root, 'hub-state'),
  }
  for (const dir of [world.home, world.dshHome, world.agentsHome, world.work, world.documents, world.hubState]) mkdirSync(dir, { recursive: true })
  // Linux resolves "Documents" through xdg-user-dir, which minimal images and
  // containers lack ("spawn xdg-user-dir ENOENT" → no default workspace).
  // The workspace controller's documented override pins it instead.
  writeFileSync(world.patch, [
    '# Remora E2E overlay (passed with --patch; never written into the profile).',
    '- id: workspace-controller',
    '  config:',
    `    documentsDirectory: ${JSON.stringify(world.documents)}`,
    '',
  ].join('\n'))
  return world
}

export function removeWorld(world) {
  return rm(world.root, { recursive: true, force: true, maxRetries: 3 })
}

/** Environment every DSH process of the world gets. */
export function dshEnv(world, { mockUrl } = {}) {
  return childEnv({
    HOME: world.home,
    USERPROFILE: world.home,
    XDG_CONFIG_HOME: join(world.home, '.config'),
    XDG_DATA_HOME: join(world.home, '.local', 'share'),
    XDG_CACHE_HOME: join(world.home, '.cache'),
    DSH_HOME: world.dshHome,
    DSH_AGENTS_HOME: world.agentsHome,
    // No OTel upload, and no credentials from the developer's environment.
    DSH_TELEMETRY_MODE: 'DISABLED',
    DEEPSEEK_API_KEY: 'remora-e2e-mock-key',
    ...(mockUrl ? { DEEPSEEK_BASE_URL: mockUrl, DEEPSEEK_SEARCH_BASE_URL: mockUrl } : {}),
    // Keep a stray browser launch away (dsh web --no-open is passed as well).
    BROWSER: 'none',
  })
}

/** `dsh plugin --profile web add <tarball>`; returns the profile manifest after the install. */
export async function installPlugin({ dsh, world, tarball, logFile }) {
  await run('dsh plugin add', process.execPath, [dsh.bin, 'plugin', '--profile', 'web', 'add', tarball], { cwd: world.work, env: dshEnv(world), logFile, timeoutMs: 300_000 })
  const profile = JSON.parse(readFileSync(join(world.dshHome, 'profiles', 'web', 'package.json'), 'utf8'))
  return profile
}

/** Print the composed Web profile tree (no boot) — evidence that the plugin row is mounted. */
export async function dumpConfig({ dsh, world, logFile }) {
  return run('dsh --dump-config', process.execPath, [dsh.bin, '--profile', 'web', '--patch', world.patch, '--dump-config'], { cwd: world.work, env: dshEnv(world), logFile, timeoutMs: 120_000 })
}

/**
 * Start DSH Web and wait for its startup line, which carries the
 * authenticated URL (`?token=`).
 */
export async function startWeb({ dsh, world, host = '127.0.0.1', port, mockUrl, logFile, extraArgs = [], timeoutMs = 120_000 }) {
  const proc = start('dsh web', process.execPath, [dsh.bin, 'web', '--patch', world.patch, '--no-open', '--host', host, '--port', String(port), ...extraArgs], { cwd: world.work, env: dshEnv(world, { mockUrl }), logFile })
  const match = await proc.waitFor(/dsh web: (https?:\/\/\S+)/, timeoutMs, 'the "dsh web: <url>" startup line')
  const url = new URL(match[1])
  return { proc, url: url.href, origin: url.origin, token: url.searchParams.get('token') }
}
