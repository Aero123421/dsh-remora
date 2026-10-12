import { describe, expect, it } from 'vitest'
import { Browser, SETUP_TOKEN, hubFetch, login, reauth, setupOwner } from './helpers.ts'

describe('owner authentication', () => {
  it('runs first-run setup once, then signs in with the passkey', async () => {
    const home = await hubFetch('/')
    expect(home.status).toBe(303)
    expect(home.headers.get('location')).toBe('/setup')

    const wrong = await new Browser().postJson('/auth/setup/options', { setupToken: 'nope' })
    expect(wrong.status).toBe(403)

    const owner = await setupOwner()
    expect(owner.recoveryCodes).toHaveLength(10)
    const cookie = [...owner.browser.cookies.keys()]
    expect(cookie).toContain('__Host-remora_sid')

    // SETUP_TOKEN is dead now.
    const again = await new Browser().postJson('/auth/setup/options', { setupToken: SETUP_TOKEN })
    expect(again.status).toBe(403)

    const page = await owner.browser.fetch('/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(await page.text()).toContain('はじめに')

    // A fresh browser has to log in.
    const fresh = await new Browser().fetch('/settings')
    expect(fresh.status).toBe(303)
    expect(fresh.headers.get('location')).toContain('/login')

    owner.browser.cookies.clear()
    await login(owner)
    expect((await owner.browser.fetch('/settings')).status).toBe(200)

    // Cross-origin POSTs are refused even with the cookie.
    const forged = await owner.browser.fetch('/auth/reauth/options', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
    expect(forged.status).toBe(403)

    // Adding a passkey needs a fresh re-authentication; logging in counts as one.
    await reauth(owner)
    const add = await owner.browser.postJson('/auth/passkeys/options', {})
    expect(add.status).toBe(200)

    // Recovery codes work once.
    const recovery = new Browser()
    const first = await recovery.postForm('/auth/recovery', { code: owner.recoveryCodes[0] as string })
    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toContain('/settings')
    const reuse = await new Browser().postForm('/auth/recovery', { code: owner.recoveryCodes[0] as string })
    expect(reuse.headers.get('location')).toContain('error=recovery')

    // Logout ends the session.
    await owner.browser.postForm('/auth/logout', {})
    expect((await owner.browser.fetch('/settings')).status).toBe(303)
  })
})
