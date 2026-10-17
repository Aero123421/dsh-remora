// Playwright helpers: launching Chromium in this and other environments,
// page instrumentation (errors, console, failed requests), "first present"
// selector resolution, screenshots and the WebAuthn virtual authenticator.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Skip } from './steps.mjs'

let playwright
export async function loadPlaywright() {
  if (playwright) return playwright
  try {
    playwright = await import('playwright')
  } catch (error) {
    throw new Error(`playwright is not installed for the harness: run \`npm --prefix e2e ci\` (or \`pnpm e2e:install\`) first.\n${error.message}`)
  }
  return playwright
}

/**
 * Chromium to launch, in order: $REMORA_E2E_CHROMIUM, Playwright's own
 * download (PLAYWRIGHT_BROWSERS_PATH is honoured), then the preinstalled
 * /opt/pw-browsers/chromium of sandboxed dev boxes.
 */
export async function launchChromium({ headed = false } = {}) {
  const { chromium } = await loadPlaywright()
  const candidates = [process.env.REMORA_E2E_CHROMIUM, safe(() => chromium.executablePath()), '/opt/pw-browsers/chromium'].filter(Boolean)
  const executablePath = candidates.find(path => existsSync(path))
  if (!executablePath) throw new Error(`no Chromium found (tried ${candidates.join(', ')}); run \`npx --prefix e2e playwright install chromium\` or set REMORA_E2E_CHROMIUM`)
  // Only local servers are involved; never route them through an HTTP(S)_PROXY
  // from the environment (a proxy would see non-loopback test traffic).
  // The harness owns signal handling (it also stops DSH, the hub and the mock).
  const browser = await chromium.launch({ headless: !headed, executablePath, args: ['--no-proxy-server'], handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false })
  return { browser, executablePath }
}

function safe(fn) { try { return fn() } catch { return undefined } }

/** Record page errors, console errors and failed requests for the report. */
export function instrument(page, label, log) {
  const issues = []
  page.on('pageerror', error => { issues.push({ kind: 'pageerror', text: `${error.message}\n${error.stack ?? ''}` }); log(`  [${label}] pageerror: ${error.message}`) })
  page.on('console', message => {
    if (message.type() !== 'error' && message.type() !== 'warning') return
    issues.push({ kind: `console.${message.type()}`, text: message.text(), url: message.location()?.url })
    if (message.type() === 'error') log(`  [${label}] console.error: ${message.text().slice(0, 300)}`)
  })
  page.on('requestfailed', request => {
    issues.push({ kind: 'requestfailed', text: `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}` })
  })
  page.on('response', response => {
    if (response.status() >= 500) issues.push({ kind: 'http5xx', text: `${response.status()} ${response.url()}` })
  })
  return issues
}

/**
 * Resolve the first alternative that matches a visible element.
 * @param scope - Page or Locator
 * @param alternatives - one selector function or an array of them (lib/selectors.mjs)
 * @returns the Locator, or null when none shows up within `timeoutMs`
 */
export async function firstPresent(scope, alternatives, timeoutMs = 5000) {
  const list = (Array.isArray(alternatives) ? alternatives : [alternatives]).map(make => make(scope).first())
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const locator of list) {
      if (await locator.isVisible().catch(() => false)) return locator
    }
    if (Date.now() > deadline) return null
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

/** Like firstPresent, but a missing element is a Skip with `reason`. */
export async function requirePresent(scope, alternatives, reason, timeoutMs = 5000) {
  const locator = await firstPresent(scope, alternatives, timeoutMs)
  if (!locator) throw new Skip(reason)
  return locator
}

/** Like firstPresent, but a missing element fails the step. */
export async function mustBePresent(scope, alternatives, what, timeoutMs = 15_000) {
  const locator = await firstPresent(scope, alternatives, timeoutMs)
  if (!locator) throw new Error(`not found within ${timeoutMs} ms: ${what}`)
  return locator
}

export async function shot(page, artifacts, name) {
  const path = join(artifacts, `${name}.png`)
  await page.screenshot({ path, fullPage: false })
  return path
}

/**
 * Attach a CTAP2 platform authenticator to `page` (Chrome DevTools Protocol).
 * It is resident-key capable, user-verifying and auto-confirms, so passkey
 * registration and sign-in run without any prompt.
 */
export async function addVirtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  return {
    authenticatorId,
    credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    clearCredentials: () => cdp.send('WebAuthn.clearCredentials', { authenticatorId }),
    detach: () => cdp.detach().catch(() => {}),
  }
}
