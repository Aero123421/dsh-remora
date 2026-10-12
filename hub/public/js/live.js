// Remora hub: live countdowns for items waiting for a human. When an item
// expires, its card says so and its answer buttons are disabled.
'use strict'

;(() => {
  const text = left => {
    if (left <= 0) return '期限切れ'
    const total = Math.ceil(left / 1000)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    return hours > 0 ? `あと ${hours} 時間 ${minutes} 分` : `あと ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
  }

  const tick = () => {
    const now = Date.now()
    for (const element of document.querySelectorAll('[data-expires-at]')) {
      const at = Number(element.getAttribute('data-expires-at'))
      if (!Number.isFinite(at)) continue
      const left = at - now
      element.textContent = text(left)
      if (left > 0) continue
      element.classList.add('expired')
      const card = element.closest('[data-expiring]')
      if (!card || card.classList.contains('expired')) continue
      card.classList.add('expired')
      for (const control of card.querySelectorAll('button, input, textarea, select')) control.disabled = true
      for (const link of card.querySelectorAll('a.button')) link.hidden = true
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!document.querySelector('[data-expires-at]')) return
    tick()
    setInterval(tick, 1000)
  })
})()
