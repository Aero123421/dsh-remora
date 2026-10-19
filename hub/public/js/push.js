// Remora hub: turn Web Push notifications on or off for this device
// (settings page). The service worker is /sw.js.
'use strict'

;(() => {
  let strings = {}
  try { strings = JSON.parse(document.body.dataset.i18n || '{}') } catch { strings = {} }
  const tr = (key, vars) => String(strings[key] || key).replace(/\{(\w+)\}/g, (match, name) => (vars && name in vars ? String(vars[name]) : match))

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
  const standalone = () => !!(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true
  const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const deviceLabel = () => {
    const ua = navigator.userAgent
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : tr('js.deviceFallback')
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
    return [os, browser, standalone() ? tr('js.deviceHome') : ''].filter(Boolean).join(' ')
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
      status.className = `notice ${kind === 'error' ? 'error' : 'ok'}`
      status.hidden = false
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      // Safari on iPhone and iPad gets Web Push only in a Home Screen app.
      root.querySelector(isIos() && !standalone() ? '[data-push-ios]' : '[data-push-unsupported]').hidden = false
      return
    }
    let registration
    try {
      registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    } catch (error) {
      say(tr('js.pushWorkerFailed', { message: error.message }), 'error')
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
    if (Notification.permission === 'denied') say(tr('js.pushBlocked'), 'error')

    on.addEventListener('click', async () => {
      on.disabled = true
      try {
        // Ask first, while the click still counts as a user gesture (Safari requires it).
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
          say(tr('js.pushNotAllowed'), 'error')
          return
        }
        if (subscription && !sameKey(subscription, key)) {
          await subscription.unsubscribe()
          subscription = null
        }
        subscription = subscription || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) })
        await post('/push/subscribe', { subscription: subscription.toJSON(), label: deviceLabel() })
        location.assign('/settings?msg=push-on#notifications')
      } catch (error) {
        say(tr('js.pushOnFailed', { message: error.message }), 'error')
      } finally {
        on.disabled = false
      }
    })

    off.addEventListener('click', async () => {
      off.disabled = true
      try {
        if (subscription) {
          const endpoint = subscription.endpoint
          await subscription.unsubscribe()
          await post('/push/unsubscribe', { endpoint })
        }
        location.assign('/settings?msg=push-removed#notifications')
      } catch (error) {
        off.disabled = false
        say(tr('js.pushOffFailed', { message: error.message }), 'error')
      }
    })
  })
})()
