// Remora hub: turn Web Push notifications on or off for this device
// (settings page). The service worker is /sw.js.
'use strict'

;(() => {
  const toBytes = text => {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  const sameKey = (subscription, key) => {
    const current = subscription.options && subscription.options.applicationServerKey
    if (!current) return true
    const a = new Uint8Array(current)
    const b = toBytes(key)
    return a.length === b.length && a.every((value, index) => value === b[index])
  }
  const post = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
    let data = {}
    try { data = await response.json() } catch { /* empty */ }
    if (!response.ok) throw new Error((data.error && data.error.message) || `HTTP ${response.status}`)
    return data
  }
  const deviceLabel = () => {
    const ua = navigator.userAgent
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'デバイス'
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
    const standalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches
    return [os, browser, standalone ? '（ホーム画面）' : ''].filter(Boolean).join(' ')
  }

  document.addEventListener('DOMContentLoaded', async () => {
    const root = document.querySelector('[data-push]')
    if (!root) return
    const key = root.getAttribute('data-vapid-key')
    const on = root.querySelector('[data-push-on]')
    const off = root.querySelector('[data-push-off]')
    const status = root.querySelector('[data-push-status]')
    const say = (message, kind) => {
      status.textContent = message
      status.className = `flash ${kind || 'ok'}`
      status.hidden = false
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      root.querySelector('[data-push-unsupported]').hidden = false
      return
    }
    let registration
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    } catch (error) {
      say(`サービスワーカーを登録できませんでした: ${error.message}`, 'error')
      return
    }
    let subscription = await registration.pushManager.getSubscription()
    const mark = () => {
      for (const item of root.querySelectorAll('[data-push-endpoint]')) {
        const mine = subscription && item.getAttribute('data-push-endpoint') === subscription.endpoint
        item.querySelector('[data-this-device]').hidden = !mine
      }
      const known = subscription && [...root.querySelectorAll('[data-push-endpoint]')].some(item => item.getAttribute('data-push-endpoint') === subscription.endpoint)
      on.hidden = !!known
      off.hidden = !known
    }
    mark()
    if (Notification.permission === 'denied') say('このサイトの通知はブラウザでブロックされています。ブラウザ（iPhone は設定アプリ）の通知設定から許可してください。', 'error')

    on.addEventListener('click', async () => {
      try {
        // Ask first, while the click still counts as a user gesture (Safari requires it).
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
          say('通知が許可されませんでした。', 'error')
          return
        }
        if (subscription && !sameKey(subscription, key)) {
          await subscription.unsubscribe()
          subscription = null
        }
        subscription = subscription || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) })
        await post('/push/subscribe', { subscription: subscription.toJSON(), label: deviceLabel() })
        location.assign('/settings?msg=push-saved#notifications')
      } catch (error) {
        say(`通知をオンにできませんでした: ${error.message}`, 'error')
      }
    })

    off.addEventListener('click', async () => {
      try {
        if (subscription) {
          const endpoint = subscription.endpoint
          await subscription.unsubscribe()
          await post('/push/unsubscribe', { endpoint })
        }
        location.assign('/settings?msg=push-removed#notifications')
      } catch (error) {
        say(`通知を止められませんでした: ${error.message}`, 'error')
      }
    })
  })
})()
