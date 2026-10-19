import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { Browser, SETUP_TOKEN, SoftAuthenticator, hubFetch, login, reauth, setupOwner } from './helpers.ts'

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
    expect(await page.text()).toContain('使い始める')

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

    // Recovery authenticates the owner without access to the lost passkey.
    const replacement = new SoftAuthenticator()
    const prepared = await recovery.postJson('/auth/passkeys/options', {})
    expect(prepared.status).toBe(200)
    const registration = await prepared.json() as { challengeId: string; options: Parameters<SoftAuthenticator['create']>[0] }
    const response = await replacement.create(registration.options)
    const added = await recovery.postJson('/auth/passkeys/verify', { challengeId: registration.challengeId, response, label: 'replacement' })
    expect(added.status).toBe(200)
    expect(await (await recovery.fetch('/settings')).text()).toContain('replacement')

    // A page URL cannot make a stale session fresh, and an outstanding ceremony
    // must still be fresh at verification time.
    const pending = await (await recovery.postJson('/auth/passkeys/options', {})).json() as typeof registration
    const hub = env.HUB.get(env.HUB.idFromName('hub'))
    await runInDurableObject(hub, (_instance, state) => { state.storage.sql.exec('UPDATE sessions SET reauth_at = 0') })
    expect((await recovery.fetch('/settings?recovered=1')).status).toBe(200)
    const staleOptions = await recovery.postJson('/auth/passkeys/options', {})
    expect(staleOptions.status).toBe(403)
    expect(await staleOptions.json()).toMatchObject({ error: { code: 'reauth_required' } })
    const staleVerify = await recovery.postJson('/auth/passkeys/verify', { challengeId: pending.challengeId, response: await new SoftAuthenticator().create(pending.options) })
    expect(staleVerify.status).toBe(403)
    const anonymous = await new Browser().postJson('/auth/passkeys/options', {})
    expect(anonymous.status).toBe(403)

    // Logout ends the session.
    await owner.browser.postForm('/auth/logout', {})
    expect((await owner.browser.fetch('/settings')).status).toBe(303)
  })
})
