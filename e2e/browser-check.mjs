// Browser check: the Remora settings tab inside real DSH Web.
//
// Proves the project's biggest unknown end to end: a self-built client bundle
// (dist/client.js registering through window.__ModuleLoader__) is served by
// DSH Web from the installed plugin, mounts into the `settings.section` slot,
// and talks to the plugin's authenticated routes (/api/remora/*).
import { dsh as DSH, remora as REMORA } from './lib/selectors.mjs'
import { firstPresent, instrument, mustBePresent, shot } from './lib/browser.mjs'
import assert from 'node:assert/strict'

/** Latin letters that change line without a space are a mid-word break. CJK may wrap per character. */
async function narrowColumnReport(section) {
  return section.evaluate(root => {
    const column = root.getBoundingClientRect()
    const problems = []
    const visit = element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let textNode
      while ((textNode = walker.nextNode())) {
        const text = textNode.textContent ?? ''
        const range = document.createRange()
        let lastTop = null
        for (let i = 0; i < text.length; i++) {
          range.setStart(textNode, i)
          range.setEnd(textNode, i + 1)
          const rect = range.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue
          if (lastTop !== null && rect.top - lastTop > 2 && /[A-Za-z]/.test(text[i - 1] ?? '') && /[A-Za-z]/.test(text[i] ?? '')) {
            problems.push(`${text[i - 1]}|${text[i]} in ${text.slice(Math.max(0, i - 8), i + 8)}`)
          }
          lastTop = rect.top
        }
      }
    }
    for (const tab of root.querySelectorAll('.rmr-tabs > [role="tab"], [data-testid="remora-hub-status"]')) visit(tab)
    const inputOverflow = [...root.querySelectorAll('input, textarea')].flatMap(input => {
      const box = input.getBoundingClientRect()
      const overflow = Math.max(0, box.right - column.right, column.left - box.left)
      return overflow > 1 ? [{ overflow: Math.round(overflow), label: input.getAttribute('aria-label') }] : []
    })
    return { problems, inputOverflow, columnWidth: Math.round(column.width) }
  })
}

/** Check the rendered selection surface, including constrained grid tracks. */
export async function checkSettingsLayout(page, section) {
  const viewport = page.viewportSize()
  try {
    for (const width of [1280, 600]) {
      await page.setViewportSize({ width, height: viewport.height })
      for (const value of ['connection', 'permissions', 'scope', 'activity', 'compat']) {
        const tab = section.locator(`#rmr-tabs-${value}`)
        await tab.click()
        assert.equal(await tab.getAttribute('aria-selected'), 'true')
        await page.waitForFunction(() => {
          const indicator = document.querySelector('.rmr-tabs > [aria-hidden="true"]')
          return !indicator || indicator.getAnimations().every(animation => animation.playState !== 'running')
        })
        const indicator = section.locator('.rmr-tabs > [aria-hidden="true"]')
        const surface = await indicator.isVisible() ? indicator : tab
        const [selectedBox, surfaceBox] = await Promise.all([tab.boundingBox(), surface.boundingBox()])
        assert.ok(selectedBox && surfaceBox)
        for (const dimension of ['x', 'y', 'width', 'height']) {
          assert.ok(Math.abs(selectedBox[dimension] - surfaceBox[dimension]) < 1, `${value} selection ${dimension} is misaligned at ${width}px`)
        }
        const background = await surface.evaluate(element => getComputedStyle(element).backgroundColor)
        assert.ok(background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)', 'the selected tab has a visible background')
        const panel = section.locator(`#rmr-tabs-${value}-panel`)
        await panel.waitFor({ state: 'visible' })
        assert.equal(await panel.getAttribute('aria-labelledby'), `rmr-tabs-${value}`)
        if (value === 'permissions') {
          const grid = await section.locator('.rmr-levels').evaluate(element => ({
            rows: new Set([...element.children].map(child => child.getBoundingClientRect().y)).size,
            columns: new Set([...element.children].map(child => child.getBoundingClientRect().x)).size,
            overflow: element.scrollWidth - element.clientWidth,
          }))
          assert.deepEqual(grid, { rows: width === 1280 ? 2 : 4, columns: width === 1280 ? 2 : 1, overflow: 0 })
        }
      }
      await section.locator('#rmr-tabs-permissions').click()
      await section.locator('#rmr-tabs-permissions').press('ArrowRight')
      await section.locator('#rmr-tabs-scope-panel').waitFor({ state: 'visible' })
      assert.equal(await section.locator('#rmr-tabs-scope').evaluate(element => element === document.activeElement), true)
    }
    await page.setViewportSize({ width: 390, height: viewport.height })
    await section.locator('#rmr-tabs-connection').click()
    const narrow = await narrowColumnReport(section)
    assert.deepEqual(narrow.problems, [], `390px mid-word break: ${narrow.problems.join('; ')}`)
    assert.deepEqual(narrow.inputOverflow, [], `390px input overflow: ${JSON.stringify(narrow.inputOverflow)}`)
    for (const value of ['permissions', 'scope', 'activity', 'compat']) {
      await section.locator(`#rmr-tabs-${value}`).click()
      const tab = await narrowColumnReport(section)
      assert.deepEqual(tab.problems, [], `${value} mid-word break at 390px: ${tab.problems.join('; ')}`)
      assert.deepEqual(tab.inputOverflow, [], `${value} input overflow at 390px: ${JSON.stringify(tab.inputOverflow)}`)
    }
  } finally {
    await page.setViewportSize(viewport)
    await section.locator('#rmr-tabs-connection').click()
  }
  return 'Five tabs and keyboard navigation: selection matches its panel at 1280px and 600px; permission cards use two columns or one without overflow; at 390px tab names and status stay on word boundaries and inputs stay in the column'
}

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
  await mustBePresent(page, DSH.shellReady, 'the DSH shell (sidebar Settings, or the account menu)', 30_000)
  return { context, page, issues, artifacts }
}

export async function openSettings(page) {
  const direct = await firstPresent(page, DSH.settingsOpen, 1_500)
  if (direct) {
    await direct.click()
  } else {
    const menu = await mustBePresent(page, DSH.accountMenu, 'the DSH account menu')
    await menu.click()
    const item = await mustBePresent(page, DSH.settingsMenuItem, 'Settings in the account menu')
    await item.click()
  }
  await mustBePresent(page, DSH.settingsDialog, 'the settings dialog')
}

/** Open the Remora page and wait until it rendered the plugin state. */
export async function openRemoraTab(page) {
  const open = await firstPresent(page, REMORA.section, 300)
  if (open) {
    const killSwitch = await mustBePresent(open, REMORA.killSwitch, 'the kill switch card')
    return { section: open, killSwitch, response: null }
  }
  const nav = await mustBePresent(page, DSH.settingsNavRemora, '"Remora" in the settings left nav')
  const state = page.waitForResponse(response => /\/api\/remora\/state$/.test(response.url()), { timeout: 15_000 }).catch(() => null)
  await nav.click()
  const response = await state
  const section = await mustBePresent(page, REMORA.section, 'the Remora page (div.rmr with the kill switch)')
  const killSwitch = await mustBePresent(section, REMORA.killSwitch, 'the kill switch card (rendered once /api/remora/state answered)')
  return { section, killSwitch, response }
}

/** Select one of the page's tabs (Connection, Permissions, Scope, ...). */
export async function openRemoraSubTab(section, name) {
  const tab = await mustBePresent(section, REMORA.tab(name), `the "${name}" tab of the Remora page`)
  await tab.click()
}

export async function rpcBody(response) {
  if (!response) return undefined
  try { return await response.json() } catch { return undefined }
}

export async function killSwitchOn(killSwitch) {
  return (await killSwitch.getAttribute('data-on')) === 'true'
}

/** Click the kill switch button and wait for the plugin to confirm the new value. */
export async function toggleKillSwitch(page, killSwitch) {
  const before = await killSwitchOn(killSwitch)
  const button = await mustBePresent(killSwitch, REMORA.killSwitchButton, 'the kill switch button')
  if (await button.isDisabled()) throw new Error(`the kill switch button is disabled (title: ${await button.getAttribute('title')})`)
  const reply = page.waitForResponse(response => /\/api\/remora\/kill-switch$/.test(response.url()), { timeout: 15_000 })
  await button.click()
  const body = await rpcBody(await reply)
  if (!body?.result?.ok) throw new Error(`kill-switch RPC failed: ${JSON.stringify(body)}`)
  const expected = !before
  let after
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await page.waitForTimeout(200)) {
    after = await killSwitchOn(killSwitch)
    if (after === expected) break
  }
  if (after !== expected) throw new Error(`kill switch stayed data-on=${after} (expected ${expected})`)
  if (body.result.value?.settings?.killSwitch !== expected) throw new Error(`server state killSwitch=${body.result.value?.settings?.killSwitch}, expected ${expected}`)
  return after
}

/**
 * Register the browser-check steps on the runner.
 * @returns {Promise<{ session?: { context, page, issues } }>} the DSH page, reused by the flow
 */
export async function browserSteps(r, { browser, web, artifacts, plugin, prefix = 'browser', label = 'loopback', minimal = false, local = true }) {
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
    const { killSwitch, response } = await openRemoraTab(page)
    const body = await rpcBody(response)
    if (response && !body?.result?.ok) throw new Error(`/api/remora/state answered ${response.status()} ${JSON.stringify(body)}`)
    const state = body?.result?.value
    if (plugin?.version && state && state.version !== plugin.version) throw new Error(`plugin reports version ${state.version}, expected ${plugin.version}`)
    const path = await shot(page, artifacts, `${prefix}-03-remora-tab`)
    return `state: version=${state?.version} protocol=${state?.protocol} dsh=${state?.dshVersion} local=${state?.local} paired=${state?.hub?.paired} ceiling=${state?.settings?.ceiling?.level} killSwitch=${await killSwitchOn(killSwitch)} operations=${state?.operations?.filter(op => op.available !== false).length ?? '?'}; ${path}`
  })

  if (minimal) return out

  await r.step(`${prefix}.settings-layout`, 'The selected tab matches its panel and the permission grid fits the settings column', { needs: [`${prefix}.remora-tab`], onFailure: failShot('settings-layout') }, async () => {
    const { page } = out.session
    const { section } = await openRemoraTab(page)
    return checkSettingsLayout(page, section)
  })

  await r.step(`${prefix}.kill-switch`, local
    ? 'The kill switch turns on through the authenticated route, survives a reload, and turns off'
    : 'From another device the kill switch turns on and survives a reload; resuming is refused (local only)', { needs: [`${prefix}.remora-tab`], onFailure: failShot('kill-switch') }, async () => {
    const { page } = out.session
    let { killSwitch } = await openRemoraTab(page)
    if (await killSwitchOn(killSwitch)) {
      if (!local) throw new Error('the kill switch is already on; a remote browser cannot turn it off')
      await toggleKillSwitch(page, killSwitch)
    }
    await toggleKillSwitch(page, killSwitch)
    const on = await shot(page, artifacts, `${prefix}-04-kill-switch-on`)
    await page.reload()
    const notice = await firstPresent(page, DSH.previewNoticeContinue, 3000)
    if (notice) await notice.click()
    await openSettings(page)
    ;({ killSwitch } = await openRemoraTab(page))
    if (!(await killSwitchOn(killSwitch))) throw new Error('after reload the kill switch is off')
    if (!local) {
      const resume = await mustBePresent(killSwitch, REMORA.killSwitchButton, 'the Resume button')
      if (!(await resume.isDisabled())) throw new Error('a non-loopback browser may resume after the kill switch (expected local-only)')
      return `on → reload (still on); Resume is disabled here (title "${await resume.getAttribute('title')}"); ${on}`
    }
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
