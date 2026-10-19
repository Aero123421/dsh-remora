import { describe, expect, it } from 'vitest'
import { Browser, hubFetch, setupOwner } from './helpers.ts'

describe('page language', () => {
  it('serves the setup page in the browser language, English by default', async () => {
    const english = await (await hubFetch('/setup', { headers: { 'accept-language': 'fr-FR, en;q=0.5' } })).text()
    expect(english).toContain('<html lang="en">')
    expect(english).toContain('Set up your hub')
    const chinese = await (await hubFetch('/setup', { headers: { 'accept-language': 'zh-CN,zh;q=0.9' } })).text()
    expect(chinese).toContain('<html lang="zh-CN">')
    expect(chinese).not.toContain('Set up your hub')
    const japanese = await (await hubFetch('/setup')).text()
    expect(japanese).toContain('<html lang="ja">')
    expect(japanese).toContain('ハブの初期設定')
  })

  it('remembers a choice from the switcher and sends scripts their strings', async () => {
    const owner = await setupOwner()
    const browser = new Browser()
    browser.cookies = new Map(owner.browser.cookies)
    const switched = await browser.fetch('/lang?set=en&next=%2Fsettings%23passkeys')
    expect(switched.status).toBe(303)
    expect(switched.headers.get('location')).toBe('/settings#passkeys')
    expect(switched.headers.get('set-cookie')).toContain('remora_lang=en')
    const settings = await (await browser.fetch('/settings')).text()
    expect(settings).toContain('<html lang="en">')
    expect(settings).toContain('Passkeys')
    expect(settings).toContain('href="/lang?set=ja&amp;next=%2Fsettings"')
    const data = /data-i18n="([^"]*)"/.exec(settings)?.[1] ?? ''
    const strings = JSON.parse(data.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')) as Record<string, string>
    expect(strings['js.copied']).toBe('Copied')
    expect(Object.keys(strings).every(key => key.startsWith('js.') || key.startsWith('time.'))).toBe(true)

    // Back to automatic: the cookie is cleared and Accept-Language decides again.
    const auto = await browser.fetch('/lang?set=auto&next=https://evil.example/')
    expect(auto.headers.get('location')).toBe('/')
    expect(browser.cookies.has('remora_lang')).toBe(false)
    expect(await (await browser.fetch('/settings')).text()).toContain('<html lang="ja">')
  })

  it('names sign-in failures with a reason the page translates', async () => {
    await setupOwner()
    const wrong = await new Browser().postJson('/auth/login/verify', { challengeId: 'nope', response: {} })
    expect(wrong.status).toBe(403)
    expect(((await wrong.json()) as { error: { reason: string } }).error.reason).toBe('sign-in-failed')
  })
})
