// Remora hub: times in the reader's own time zone, live countdowns for items
// waiting for a human, and a fresh page when the owner comes back to it.
'use strict'

;(() => {
  let strings = {}
  try { strings = JSON.parse(document.body.dataset.i18n || '{}') } catch { strings = {} }
  const tr = (key, vars) => String(strings[key] || key).replace(/\{(\w+)\}/g, (match, name) => (vars && name in vars ? String(vars[name]) : match))

  const left = ms => {
    if (ms <= 0) return tr('time.expired')
    const total = Math.ceil(ms / 1000)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = String(total % 60).padStart(2, '0')
    return h > 0 ? tr('time.leftHours', { h, m }) : tr('time.leftMinutes', { m, s })
  }

  // On a narrow screen the nav scrolls sideways: keep the current page's link in view.
  const current = document.querySelector('.nav a[aria-current="page"]')
  if (current) {
    const nav = current.parentElement
    const overflow = current.getBoundingClientRect().right - nav.getBoundingClientRect().right
    if (overflow > -20) nav.scrollLeft += overflow + 24
  }

  const tick = () => {
    const now = Date.now()
    for (const element of document.querySelectorAll('[data-expires-at]')) {
      const at = Number(element.getAttribute('data-expires-at'))
      if (!Number.isFinite(at)) continue
      const ms = at - now
      element.textContent = left(ms)
      if (ms > 0) continue
      element.classList.add('expired')
      const card = element.closest('[data-expiring]')
      if (!card || card.classList.contains('expired')) continue
      card.classList.add('expired')
      for (const control of card.querySelectorAll('button, input, textarea, select')) control.disabled = true
      for (const link of card.querySelectorAll('a.btn')) link.hidden = true
    }
  }

  // <time data-ts>: the server writes UTC; show it in this device's time zone and the page language.
  const localTimes = () => {
    let format
    try {
      format = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' })
    } catch { return }
    for (const element of document.querySelectorAll('time[data-ts]')) {
      const at = Number(element.getAttribute('data-ts'))
      if (Number.isFinite(at)) element.textContent = format.format(at)
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    localTimes()
    if (document.querySelector('[data-expires-at]')) {
      tick()
      setInterval(tick, 1000)
    }
    // Lists that change on their own (home, needs-you): reload when the tab is shown again after a while.
    if (document.querySelector('[data-refresh-on-show]')) {
      let hiddenAt = 0
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') hiddenAt = Date.now()
        else if (hiddenAt && Date.now() - hiddenAt > 30_000) location.reload()
      })
    }
  })
})()
