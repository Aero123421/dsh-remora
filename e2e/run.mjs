#!/usr/bin/env node
// Remora E2E harness. See docs/e2e.md.
//
//   node e2e/run.mjs [--only=browser|flow] [--strict] [--keep] [--headed]
//                    [--dsh-version=<version|dist-tag|newest>] [--fresh-dsh] [--plugin=<tgz>] [--no-pack]
//                    [--no-remote] [--hub-url=<url> --setup-token=<token>]
//
// Exit codes: 0 all good (skips allowed), 1 a step failed, 2 --strict and something was skipped.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Runner } from './lib/steps.mjs'
import { childEnv, run, stopAll } from './lib/procs.mjs'
import { PORTS, freePort, isFree } from './lib/ports.mjs'
import { startMockLlm } from './lib/mock-llm.mjs'
import { createWorld, dumpConfig, installDsh, installPlugin, removeWorld, startWeb } from './lib/dsh.mjs'
import { launchChromium } from './lib/browser.mjs'
import { browserSteps } from './browser-check.mjs'
import { flowSteps, stopFlow } from './flow.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    strict: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
    'dsh-version': { type: 'string' },
    'dsh-dir': { type: 'string' },
    'fresh-dsh': { type: 'boolean', default: false },
    plugin: { type: 'string' },
    'no-pack': { type: 'boolean', default: false },
    'no-remote': { type: 'boolean', default: false },
    'hub-url': { type: 'string' },
    'setup-token': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
})
if (args.help) {
  const header = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1)
  console.log(header.slice(0, header.findIndex(line => !line.startsWith('//'))).map(line => line.replace(/^\/\/ ?/, '')).join('\n'))
  process.exit(0)
}
if (args.only && !['browser', 'flow'].includes(args.only)) {
  console.error(`--only must be "browser" or "flow", got ${JSON.stringify(args.only)}`)
  process.exit(64)
}
const wantBrowser = args.only !== 'flow'
const wantFlow = args.only !== 'browser'

const upstream = JSON.parse(readFileSync(join(repo, 'upstream.json'), 'utf8'))
const dshVersion = args['dsh-version'] ?? process.env.REMORA_E2E_DSH_VERSION ?? upstream.version
const pluginManifest = JSON.parse(readFileSync(join(repo, 'packages', 'dsh-remora', 'package.json'), 'utf8'))
const artifacts = join(repo, 'artifacts', 'e2e')
rmSync(artifacts, { recursive: true, force: true })
mkdirSync(artifacts, { recursive: true })

const r = new Runner({ artifacts, strict: args.strict })
const ctx = { world: undefined, mock: undefined, web: undefined, browser: undefined, flow: undefined, sessions: [] }

let cleaning
async function cleanup() {
  cleaning ??= (async () => {
    for (const session of ctx.sessions) {
      try { await session.context.tracing.stop({ path: join(artifacts, `trace-${session.label}.zip`) }) } catch { /* no trace */ }
      await session.context.close().catch(() => {})
    }
    await stopFlow(ctx.flow).catch(() => {})
    await ctx.browser?.close().catch(() => {})
    await ctx.web?.proc.stop().catch(() => {})
    await ctx.mock?.close().catch(() => {})
    await stopAll().catch(() => {})
    if (ctx.world && !args.keep) await removeWorld(ctx.world).catch(() => {})
    else if (ctx.world) r.log(`kept the world at ${ctx.world.root}`)
  })()
  return cleaning
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => { r.log(`${signal}: cleaning up`); void cleanup().finally(() => process.exit(130)) })
}

r.log(`Remora E2E: DSH ${dshVersion}, plugin ${pluginManifest.version}, only=${args.only ?? 'all'}, artifacts ${artifacts}`)

// --- setup ------------------------------------------------------------------

await r.step('setup.plugin-tarball', 'The plugin tarball exists and matches SHA256SUMS', { timeoutMs: 180_000 }, async () => {
  let tarball = args.plugin ? resolve(args.plugin) : join(repo, 'artifacts', `${pluginManifest.name}-${pluginManifest.version}.tgz`)
  if (!args.plugin && !args['no-pack']) {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    await run('pnpm pack:plugin', pnpm, ['pack:plugin'], { cwd: repo, env: childEnv(), logFile: join(artifacts, 'pack.log'), timeoutMs: 180_000 })
  }
  if (!existsSync(tarball)) throw new Error(`missing ${tarball}; run \`pnpm pack:plugin\` at the repo root`)
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const sums = join(dirname(tarball), 'SHA256SUMS')
  if (existsSync(sums)) {
    const listed = readFileSync(sums, 'utf8').split('\n').find(line => line.trim().endsWith(` ${tarball.split(/[\\/]/).pop()}`))
    if (listed && !listed.startsWith(digest)) throw new Error(`SHA256SUMS does not match ${tarball}`)
  }
  ctx.tarball = tarball
  return `${tarball} sha256 ${digest.slice(0, 16)}…`
})

await r.step('setup.dsh-install', `@deepseek-ai/dsh@${dshVersion} installed from npm into an isolated directory`, { timeoutMs: 660_000 }, async () => {
  let version = dshVersion
  if (version === 'newest') {
    // The highest published version, prereleases included (npm lists versions in semver order).
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    version = JSON.parse(await run('npm view dsh versions', npm, ['view', '@deepseek-ai/dsh', 'versions', '--json'], { env: childEnv(), timeoutMs: 60_000 })).at(-1)
    r.log(`  newest @deepseek-ai/dsh is ${version}`)
  } else if (!/^\d+\.\d+\.\d+/.test(version)) {
    // An npm dist-tag such as "latest" or "next": resolve it to the exact version.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    version = (await run('npm view dsh', npm, ['view', `@deepseek-ai/dsh@${dshVersion}`, 'version'], { env: childEnv(), timeoutMs: 60_000 })).trim().split('\n').pop().replace(/^.*'(.+)'$/, '$1')
    r.log(`  @deepseek-ai/dsh@${dshVersion} is ${version}`)
  }
  const dir = args['dsh-dir'] ? resolve(args['dsh-dir']) : join(repo, '.cache', 'e2e', `dsh-${version}`)
  ctx.dsh = await installDsh({ version, dir, fresh: args['fresh-dsh'], logFile: join(artifacts, 'dsh-install.log') })
  const printed = (await run('dsh --version', process.execPath, [ctx.dsh.bin, '--version'], { env: childEnv(), timeoutMs: 60_000 })).trim()
  if (printed !== version) throw new Error(`dsh --version printed ${printed}, expected ${version}`)
  ctx.dshVersion = version
  return `${ctx.dsh.bin} (dsh --version: ${printed})`
})

await r.step('setup.world', 'Isolated HOME / DSH_HOME / workspace in a temp dir', {}, async () => {
  ctx.world = await createWorld()
  return ctx.world.root
})

await r.step('setup.mock-llm', `Mock model server on ${PORTS.mockLlm.join('–')}`, {}, async () => {
  const port = await freePort(PORTS.mockLlm)
  const log = line => { r.log(`  [mock-llm] ${line}`) }
  ctx.mock = await startMockLlm({ port, log })
  return ctx.mock.url
})

await r.step('setup.plugin-install', 'dsh plugin --profile web add <tarball> (DSH\'s supported install path)', { needs: ['setup.plugin-tarball', 'setup.dsh-install', 'setup.world'], timeoutMs: 330_000 }, async () => {
  const profile = await installPlugin({ dsh: ctx.dsh, world: ctx.world, tarball: ctx.tarball, logFile: join(artifacts, 'dsh-plugin-add.log') })
  if (!profile.dsh?.profile?.bundles?.includes(pluginManifest.name)) throw new Error(`profile bundles do not include ${pluginManifest.name}: ${JSON.stringify(profile.dsh)}`)
  const dump = await dumpConfig({ dsh: ctx.dsh, world: ctx.world, logFile: join(artifacts, 'dsh-dump-config.log') })
  if (!new RegExp(`- id: ${pluginManifest.name}\\b`).test(dump)) throw new Error(`--dump-config has no ${pluginManifest.name} row`)
  return `profile bundles: ${profile.dsh.profile.bundles.join(', ')}; composed tree has the ${pluginManifest.name} row`
})

await r.step('setup.dsh-web', `dsh web on 127.0.0.1:${PORTS.dsh.join('–')} with the model pointed at the mock`, { needs: ['setup.plugin-install', 'setup.mock-llm'], timeoutMs: 150_000 }, async () => {
  const port = await freePort(PORTS.dsh)
  ctx.web = await startWeb({ dsh: ctx.dsh, world: ctx.world, port, mockUrl: ctx.mock.url, logFile: join(artifacts, 'dsh-web.log') })
  return `${ctx.web.origin} (authenticated URL from the startup line; log artifacts/e2e/dsh-web.log)`
})

await r.step('setup.chromium', 'Chromium launches', { needs: ['setup.dsh-web'], timeoutMs: 60_000 }, async () => {
  const launched = await launchChromium({ headed: args.headed })
  ctx.browser = launched.browser
  return `${launched.executablePath} (${ctx.browser.version()})`
})

// --- browser check ------------------------------------------------------------

if (ctx.browser) {
  const browserOut = await browserSteps(r, { browser: ctx.browser, web: ctx.web, artifacts, plugin: pluginManifest, minimal: !wantBrowser })
  if (browserOut.session) ctx.sessions.push({ ...browserOut.session, label: 'loopback' })

  // --- the model path (no hub needed): DSH Web → mock LLM ----------------------
  if (wantBrowser) {
    await r.step('browser.mock-model', 'A chat turn in DSH Web is answered by the mock model (ask_user_question card for the attention marker)', { needs: ['browser.open'], timeoutMs: 120_000 }, async () => {
      const { page } = browserOut.session
      const { dsh: DSH } = await import('./lib/selectors.mjs')
      const { firstPresent, mustBePresent, shot } = await import('./lib/browser.mjs')
      const close = await firstPresent(page, DSH.settingsClose, 500)
      if (close) await close.click()
      await page.goto(ctx.web.url)
      const input = await mustBePresent(page, DSH.composer, 'the chat composer (a default workspace and blank session exist)', 30_000)
      await input.fill('Remora E2E smoke nonce=smoke1')
      await input.press('Enter')
      await page.getByText('REMORA-MOCK-REPLY smoke1').filter({ visible: true }).first().waitFor({ timeout: 60_000 })
      const reply = await shot(page, artifacts, 'browser-07-mock-reply')
      await input.fill('Remora E2E question remora-e2e:ask nonce=smoke2')
      await input.press('Enter')
      await page.getByText('Which color should the E2E pick? (smoke2)', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 60_000 })
      const question = await shot(page, artifacts, 'browser-08-question-card')
      return `${ctx.mock.requests.length} model request(s) served; ${reply}, ${question}`
    })
  }

  // --- flow ---------------------------------------------------------------------
  if (wantFlow) {
    const hubPort = PORTS.hub
    const hubUrl = args['hub-url'] ?? process.env.REMORA_E2E_HUB_URL
    const setupToken = args['setup-token'] ?? process.env.REMORA_E2E_SETUP_TOKEN
    if (!hubUrl && !(await isFree(hubPort))) {
      await r.step('hub.port', `port ${hubPort} is free for the hub`, {}, async () => { throw new Error(`port ${hubPort} is in use (another wrangler dev?)`) })
    } else {
      ctx.flow = await flowSteps(r, { browser: ctx.browser, artifacts, hubDir: join(repo, 'hub'), hubPort, hubUrl, setupToken, world: ctx.world, mock: ctx.mock, dshSession: browserOut.session, log: line => r.log(line) })
    }
  }

  // --- the same tab from "another device" (non-loopback address) ----------------
  if (wantBrowser && !args['no-remote']) {
    const address = Object.values(networkInterfaces()).flat().find(entry => entry && entry.family === 'IPv4' && !entry.internal)?.address
    await r.step('remote.dsh-web', 'DSH Web restarted on a non-loopback address (the "other device" case)', { needs: ['browser.remora-tab'], timeoutMs: 150_000 }, async () => {
      if (!address) {
        const { Skip } = await import('./lib/steps.mjs')
        throw new Skip('no non-loopback IPv4 interface on this machine')
      }
      for (const session of ctx.sessions.splice(0)) {
        await session.context.tracing.stop({ path: join(artifacts, `trace-${session.label}.zip`) }).catch(() => {})
        await session.context.close().catch(() => {})
      }
      await stopFlow(ctx.flow)
      ctx.flow = undefined
      await ctx.web.proc.stop()
      const port = await freePort(PORTS.dsh, address)
      ctx.web = await startWeb({ dsh: ctx.dsh, world: ctx.world, host: address, port, mockUrl: ctx.mock.url, logFile: join(artifacts, 'dsh-web-remote.log') })
      return `${ctx.web.origin}: the browser connects from ${address}, which DSH treats as a non-loopback client`
    })
    if (r.status('remote.dsh-web') === 'pass') {
      const remoteOut = await browserSteps(r, { browser: ctx.browser, web: ctx.web, artifacts, plugin: pluginManifest, prefix: 'remote', label: 'remote' })
      if (remoteOut.session) ctx.sessions.push({ ...remoteOut.session, label: 'remote' })
    }
  }
}

const code = r.finish({ dsh: ctx.dshVersion ?? dshVersion, plugin: pluginManifest.version, only: args.only ?? 'all' })
await cleanup()
process.exit(code)
