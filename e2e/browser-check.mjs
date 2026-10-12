// Browser check: the Remora settings tab inside real DSH Web.
//
// Proves the project's biggest unknown end to end: a self-built client bundle
// (dist/client.js registering through window.__ModuleLoader__) is served by
// DSH Web from the installed plugin, mounts into the `settings.section` slot,
// and talks to the plugin's authenticated routes (/api/remora/*).
import { dsh as DSH, remora as REMORA } from './lib/selectors.mjs'
import { firstPresent, instrument, mustBePresent, shot } from './lib/browser.mjs'

/** Open DSH Web in a fresh English context and dismiss the first-use notice. */
export async function openDsh({ browser, web, artifacts, log, label = 'dsh', trace = true }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US', timezoneId: 'UTC' })
  if (trace) await context.tracing.start({ screenshots: true, snapshots: true, title: label })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const issues = instrument(page, label, log)
  await page.goto(web.url)
  const notice = await firstPresent(page, DSH.previewNoticeContinue, 6000)
  if (notice) await notice.click()
  await mustBePresent(page, DSH.settingsOpen, 'the Settings entry in the DSH sidebar', 30_000)
  return { context, page, issues, artifacts }
}

export async function openSettings(page) {
  const open = await mustBePresent(page, DSH.settingsOpen, 'the Settings entry in the DSH sidebar')
  await open.click()
  await mustBePresent(page, DSH.settingsDialog, 'the settings dialog')
}

/** Open the Remora tab and wait until it rendered the plugin state. */
export async function openRemoraTab(page) {
  const nav = await mustBePresent(page, DSH.settingsNavRemora, '"Remora" in the settings left nav')
  const state = page.waitForResponse(response => /\/api\/remora\/state$/.test(response.url()), { timeout: 15_000 }).catch(() => null)
  await nav.click()
  const response = await state
  const section = await mustBePresent(page, REMORA.section, 'the Remora section (section.dsh-remora)')
  const killSwitch = await mustBePresent(section, REMORA.killSwitch, 'the kill switch button (rendered once /api/remora/state answered)')
  return { section, killSwitch, response }
}

async function rpcBody(response) {
  if (!response) return undefined
  try { return await response.json() } catch { return undefined }
}

/** Click the kill switch and wait for the plugin to confirm the new value. */
async function toggleKillSwitch(page, killSwitch) {
  const before = await killSwitch.getAttribute('aria-pressed')
  const reply = page.waitForResponse(response => /\/api\/remora\/kill-switch$/.test(response.url()), { timeout: 15_000 })
  await killSwitch.click()
  const body = await rpcBody(await reply)
  if (!body?.result?.ok) throw new Error(`kill-switch RPC failed: ${JSON.stringify(body)}`)
  const expected = before === 'true' ? 'false' : 'true'
  let after
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await page.waitForTimeout(200)) {
    after = await killSwitch.getAttribute('aria-pressed')
    if (after === expected) break
  }
  if (after !== expected) throw new Error(`kill switch stayed aria-pressed=${after} (expected ${expected})`)
  if (body.result.value?.killSwitch !== (expected === 'true')) throw new Error(`server state killSwitch=${body.result.value?.killSwitch}, expected ${expected}`)
  return after
}

/**
 * Register the browser-check steps on the runner.
 * @returns {Promise<{ session?: { context, page, issues } }>} the DSH page, reused by the flow
 */
export async function browserSteps(r, { browser, web, artifacts, plugin, prefix = 'browser', label = 'loopback', minimal = false }) {
  const out = {}
  const failShot = name => async () => { if (out.session?.page) await shot(out.session.page, artifacts, `${prefix}-FAILED-${name}`).catch(() => {}) }

  await r.step(`${prefix}.open`, `DSH Web (${label}) opens with the authenticated URL; the module loader exists`, { needs: ['setup.dsh-web'], timeoutMs: 90_000, onFailure: failShot('open') }, async () => {
    out.session = await openDsh({ browser, web, artifacts, log: line => r.log(line), label })
    const loader = await out.session.page.evaluate(() => typeof window.__ModuleLoader__)
    if (loader !== 'object' && loader !== 'function') throw new Error(`window.__ModuleLoader__ is ${loader}`)
    const pluginScript = await out.session.page.evaluate(() => [...document.scripts].map(script => script.src).find(src => src.includes('dsh-remora')) ?? null)
    const path = await shot(out.session.page, artifacts, `${prefix}-01-home`)
    return `${web.origin}; client bundle ${pluginScript ? `loaded from ${new URL(pluginScript).pathname.slice(0, 120)}` : 'served through the combined /plugins/?? bundle'}; ${path}`
  })

  await r.step(`${prefix}.settings-nav`, 'Settings shows "Remora" in the left nav (settings.section slot)', { needs: [`${prefix}.open`], onFailure: failShot('settings-nav') }, async () => {
    const { page } = out.session
    await openSettings(page)
    await mustBePresent(page, DSH.settingsNavRemora, '"Remora" in the settings left nav')
    return shot(page, artifacts, `${prefix}-02-settings-nav`)
  })

  await r.step(`${prefix}.remora-tab`, 'The Remora tab renders the plugin state from /api/remora/state', { needs: [`${prefix}.settings-nav`], onFailure: failShot('remora-tab') }, async () => {
    const { page } = out.session
    const { section, killSwitch, response } = await openRemoraTab(page)
    const body = await rpcBody(response)
    if (response && !body?.result?.ok) throw new Error(`/api/remora/state answered ${response.status()} ${JSON.stringify(body)}`)
    const state = body?.result?.value
    const textContent = await section.innerText()
    if (plugin?.version && !textContent.includes(plugin.version)) throw new Error(`tab does not show plugin version ${plugin.version}:\n${textContent}`)
    const path = await shot(page, artifacts, `${prefix}-03-remora-tab`)
    return `state: version=${state?.version} protocol=${state?.protocol} hub.connected=${state?.hub?.connected} permission=${state?.permission?.level} killSwitch=${await killSwitch.getAttribute('aria-pressed')} available=[${state?.features?.available?.join(', ') ?? '?'}]; ${path}`
  })

  if (minimal) return out

  await r.step(`${prefix}.kill-switch`, 'The kill switch toggles through the authenticated route and survives a reload', { needs: [`${prefix}.remora-tab`], onFailure: failShot('kill-switch') }, async () => {
    const { page } = out.session
    let { killSwitch } = await openRemoraTab(page)
    if (await killSwitch.getAttribute('aria-pressed') === 'true') await toggleKillSwitch(page, killSwitch)
    await toggleKillSwitch(page, killSwitch)
    const on = await shot(page, artifacts, `${prefix}-04-kill-switch-on`)
    await page.reload()
    const notice = await firstPresent(page, DSH.previewNoticeContinue, 3000)
    if (notice) await notice.click()
    await openSettings(page)
    ;({ killSwitch } = await openRemoraTab(page))
    const persisted = await killSwitch.getAttribute('aria-pressed')
    if (persisted !== 'true') throw new Error(`after reload the kill switch is aria-pressed=${persisted}`)
    await toggleKillSwitch(page, killSwitch)
    const off = await shot(page, artifacts, `${prefix}-05-kill-switch-off`)
    return `on → reload (still on) → off; ${on}, ${off}`
  })

  await r.step(`${prefix}.plugins-page`, 'The Plugins page lists dsh-remora (informational)', { needs: [`${prefix}.open`], onFailure: failShot('plugins-page') }, async () => {
    const { page } = out.session
    const close = await firstPresent(page, DSH.settingsClose, 1000)
    if (close) await close.click()
    const open = await mustBePresent(page, DSH.pluginsOpen, 'the Plugins entry in the DSH sidebar')
    await open.click()
    const row = await firstPresent(page, [scope => scope.getByText(/dsh-remora|Remora/).first()], 10_000)
    const path = await shot(page, artifacts, `${prefix}-06-plugins-page`)
    return `${row ? 'dsh-remora is listed' : 'dsh-remora not found on the Plugins page (not fatal)'}; ${path}`
  })

  await r.step(`${prefix}.no-plugin-errors`, 'No page or console errors attributable to the plugin', { needs: [`${prefix}.open`] }, async () => {
    const { issues } = out.session
    // DSH serves every plugin's client code in one combined /plugins/?? bundle,
    // so script URLs cannot attribute an error; the message text can.
    const ours = issues.filter(issue => (issue.kind === 'pageerror' || issue.kind === 'console.error' || issue.kind === 'http5xx') && /remora/i.test(issue.text))
    const others = issues.filter(issue => !ours.includes(issue))
    if (ours.length) throw new Error(`plugin errors:\n${ours.map(issue => `${issue.kind}: ${issue.text}`).join('\n')}`)
    return `${others.length} unrelated issue(s) recorded${others.length ? `: ${others.slice(0, 3).map(issue => `${issue.kind}: ${issue.text.split('\n')[0].slice(0, 120)}`).join(' | ')}` : ''}`
  })

  return out
}
