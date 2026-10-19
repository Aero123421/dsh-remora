// Remora hub: passkey ceremonies and small enhancements. No inline script is
// allowed by the CSP, so pages mark elements with data-* attributes instead.
// Text comes from <body data-i18n>, rendered by the server in the page language.
'use strict'

;(() => {
  let strings = {}
  try {
    const body = typeof document !== 'undefined' && document.body
    strings = JSON.parse((body && body.dataset && body.dataset.i18n) || '{}')
  } catch { strings = {} }
  const tr = (key, vars) => String(strings[key] || key).replace(/\{(\w+)\}/g, (match, name) => (vars && name in vars ? String(vars[name]) : match))

  const toBytes = text => {
    const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }
  const toText = buffer => {
    const bytes = new Uint8Array(buffer)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  const creationOptions = json => {
    if (window.PublicKeyCredential && PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(json)
    return {
      ...json,
      challenge: toBytes(json.challenge),
      user: { ...json.user, id: toBytes(json.user.id) },
      excludeCredentials: (json.excludeCredentials || []).map(c => ({ ...c, id: toBytes(c.id) })),
    }
  }
  const requestOptions = json => {
    if (window.PublicKeyCredential && PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(json)
    return { ...json, challenge: toBytes(json.challenge), allowCredentials: (json.allowCredentials || []).map(c => ({ ...c, id: toBytes(c.id) })) }
  }
  const credentialJson = credential => {
    if (typeof credential.toJSON === 'function') {
      try { return credential.toJSON() } catch { /* fall back below */ }
    }
    const r = credential.response
    const out = { id: credential.id, rawId: toText(credential.rawId), type: credential.type, clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment || undefined, response: {} }
    out.response.clientDataJSON = toText(r.clientDataJSON)
    if (r.attestationObject) {
      out.response.attestationObject = toText(r.attestationObject)
      out.response.transports = typeof r.getTransports === 'function' ? r.getTransports() : []
    } else {
      out.response.authenticatorData = toText(r.authenticatorData)
      out.response.signature = toText(r.signature)
      out.response.userHandle = r.userHandle ? toText(r.userHandle) : null
    }
    return out
  }

  const post = async (url, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' })
    let data = {}
    try { data = await response.json() } catch { /* empty body */ }
    if (!response.ok) {
      const error = new Error((data.error && data.error.message) || `HTTP ${response.status}`)
      error.code = data.error && data.error.code
      error.reason = data.error && data.error.reason
      throw error
    }
    return data
  }

  // Messages go to the [data-status] of the form or section that was used, never to another one.
  const say = (element, message, kind) => {
    const target = element && element.querySelector ? element.querySelector('[data-status]') : null
    if (!target) { if (kind === 'error') alert(message); return }
    target.textContent = message
    target.className = `notice ${kind === 'error' ? 'error' : 'ok'}`
    target.setAttribute && target.setAttribute('role', kind === 'error' ? 'alert' : 'status')
    target.hidden = false
  }

  const explain = error => {
    if (error && error.name === 'NotAllowedError') return tr('js.passkeyCancelled')
    if (error && error.name === 'InvalidStateError') return tr('js.passkeyExists')
    if (error && error.name === 'SecurityError') return tr('js.passkeyAddress')
    if (error && error.reason && strings[`js.error.${error.reason}`]) return tr(`js.error.${error.reason}`)
    return tr('js.errorGeneric', { message: (error && error.message) || String(error) })
  }

  // While a passkey prompt is open: buttons disabled, the main one says what is happening.
  const busy = (button, on) => {
    if (!button || !button.getAttribute) return
    const label = button.getAttribute('data-busy-label')
    if (on) {
      button.disabled = true
      if (label) { button.dataset.idleLabel = button.textContent; button.textContent = label }
    } else {
      button.disabled = false
      if (button.dataset.idleLabel) { button.textContent = button.dataset.idleLabel; delete button.dataset.idleLabel }
    }
  }

  const supported = () => !!(window.PublicKeyCredential && navigator.credentials)

  const reauth = async () => {
    const { challengeId, options } = await post('/auth/reauth/options')
    const credential = await navigator.credentials.get({ publicKey: requestOptions(options) })
    await post('/auth/reauth/verify', { challengeId, response: credentialJson(credential) })
  }

  const register = async (prefix, extra) => {
    let prepared
    try { prepared = await post(`${prefix}/options`, extra) } catch (error) {
      // Only the server decides whether login/recovery is still fresh enough.
      if (prefix !== '/auth/passkeys' || error.code !== 'reauth_required') throw error
      await reauth()
      prepared = await post(`${prefix}/options`, extra)
    }
    const { challengeId, options } = prepared
    const credential = await navigator.credentials.create({ publicKey: creationOptions(options) })
    return post(`${prefix}/verify`, { challengeId, response: credentialJson(credential), label: (extra && extra.label) || '' })
  }

  // Same rule as safeNext() in src/next.ts: a path on this origin only.
  const safeNext = value => {
    if (!value || !value.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value)) return '/'
    try {
      const url = new URL(value, location.origin)
      return url.origin === location.origin ? url.pathname + url.search + url.hash : '/'
    } catch { return '/' }
  }

  const deviceLabel = () => {
    const ua = navigator.userAgent || ''
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
    return [os, browser].filter(Boolean).join(' ')
  }

  const submitButton = form => (form.querySelector && form.querySelector('button[type="submit"]')) || null

  document.addEventListener('DOMContentLoaded', () => {
    if (!supported()) {
      for (const element of document.querySelectorAll('[data-needs-webauthn]')) element.hidden = false
    }

    // A sensible default name for a new passkey: this device and browser.
    for (const input of document.querySelectorAll('input[data-device-label]')) {
      const guess = deviceLabel()
      if (guess && !input.value) input.placeholder = guess
    }

    // First-run setup: SETUP_TOKEN + the first passkey, then show the recovery codes once.
    for (const form of document.querySelectorAll('form[data-setup]')) {
      form.addEventListener('submit', async event => {
        event.preventDefault()
        const data = new FormData(form)
        const button = submitButton(form)
        busy(button, true)
        try {
          const label = String(data.get('label') || '') || deviceLabel()
          const result = await register('/auth/setup', { setupToken: String(data.get('setupToken') || ''), label })
          const codes = document.querySelector('[data-recovery-codes]')
          if (codes) {
            codes.textContent = result.recoveryCodes.join('\n')
            codes.closest('[data-after-setup]').hidden = false
          }
          form.hidden = true
          const title = document.querySelector('[data-after-title]')
          if (title) title.textContent = title.getAttribute('data-after-title')
          for (const element of document.querySelectorAll('[data-before-setup]')) element.hidden = true
        } catch (error) {
          say(form, explain(error), 'error')
        } finally {
          busy(button, false)
        }
      })
    }

    for (const button of document.querySelectorAll('[data-login]')) {
      button.addEventListener('click', async () => {
        busy(button, true)
        try {
          const { challengeId, options } = await post('/auth/login/options')
          const credential = await navigator.credentials.get({ publicKey: requestOptions(options) })
          await post('/auth/login/verify', { challengeId, response: credentialJson(credential) })
          location.assign(safeNext(button.getAttribute('data-next')))
        } catch (error) {
          busy(button, false)
          say(button.closest('section') || document.body, explain(error), 'error')
        }
      })
    }

    // Forms that need a fresh passkey check before the server accepts them.
    for (const form of document.querySelectorAll('form[data-reauth]')) {
      form.addEventListener('submit', async event => {
        const submitter = event.submitter
        if (form.dataset.reauthed === '1' || (submitter && submitter.hasAttribute('data-no-reauth'))) return
        event.preventDefault()
        const select = form.querySelector('select[data-autosubmit]')
        const controls = [...form.querySelectorAll('button, select')]
        for (const control of controls) control.disabled = true
        try {
          await reauth()
          form.dataset.reauthed = '1'
          if (submitter && submitter.name) {
            const hidden = document.createElement('input')
            hidden.type = 'hidden'
            hidden.name = submitter.name
            hidden.value = submitter.value
            form.appendChild(hidden)
          }
          for (const control of controls) control.disabled = false
          form.submit()
        } catch (error) {
          for (const control of controls) control.disabled = false
          if (select) select.value = [...select.options].find(option => option.defaultSelected)?.value || select.options[0].value
          say(form, explain(error) + (select ? ` ${tr('js.grantUnsaved')}` : ''), 'error')
        }
      })
    }

    for (const form of document.querySelectorAll('form[data-add-passkey]')) {
      form.addEventListener('submit', async event => {
        event.preventDefault()
        const button = submitButton(form)
        busy(button, true)
        try {
          const label = String(new FormData(form).get('label') || '') || deviceLabel()
          await register('/auth/passkeys', { label })
          location.assign('/settings?msg=passkey-added#passkeys')
        } catch (error) {
          busy(button, false)
          say(form, explain(error), 'error')
        }
      })
    }

    // Dangerous operations: a passkey assertion over confirmationChallenge(...), checked by the DSH plugin.
    for (const form of document.querySelectorAll('form[data-confirm-op]')) {
      form.addEventListener('submit', async event => {
        event.preventDefault()
        const submitter = event.submitter
        const hostId = form.getAttribute('data-host')
        const operation = form.getAttribute('data-confirm-op')
        let params
        try { params = JSON.parse(form.getAttribute('data-params') || '{}') } catch { params = {} }
        if (submitter && submitter.hasAttribute('data-approve')) params.answer = { approve: submitter.getAttribute('data-approve') === 'true' }
        // A request a client parked for the owner: the hub signs over its stored params.
        const pendingId = form.getAttribute('data-pending')
        const pending = pendingId ? { pendingId } : {}
        const buttons = [...form.querySelectorAll('button')]
        for (const button of buttons) button.disabled = true
        try {
          // The hub returns the exact params it signed over (hostId filled in); send those back.
          const { requestId, issuedAt, params: signed, options } = await post('/auth/confirm/options', { hostId, operation, params, ...pending })
          const credential = await navigator.credentials.get({ publicKey: requestOptions(options) })
          const json = credentialJson(credential)
          const assertion = { credentialId: json.id, authenticatorData: json.response.authenticatorData, clientDataJSON: json.response.clientDataJSON, signature: json.response.signature, userHandle: json.response.userHandle || null }
          await post('/ops/confirmed', { hostId, operation, params: signed || params, requestId, issuedAt, assertion, ...pending })
          location.assign(form.getAttribute('data-done') || location.href)
        } catch (error) {
          for (const button of buttons) button.disabled = false
          say(form, explain(error), 'error')
        }
      })
    }

    for (const button of document.querySelectorAll('[data-copy]')) {
      button.addEventListener('click', async () => {
        const source = document.querySelector(button.getAttribute('data-copy'))
        if (!source) return
        const label = button.dataset.label || button.textContent
        button.dataset.label = label
        try {
          await navigator.clipboard.writeText(source.textContent.trim())
          button.textContent = tr('js.copied')
        } catch {
          button.textContent = tr('js.copyFailed')
        }
        setTimeout(() => { button.textContent = label }, 2000)
      })
    }

    for (const button of document.querySelectorAll('[data-download]')) {
      button.addEventListener('click', () => {
        const source = document.querySelector(button.getAttribute('data-download'))
        if (!source) return
        const link = document.createElement('a')
        link.href = URL.createObjectURL(new Blob([`${source.textContent.trim()}\n`], { type: 'text/plain' }))
        link.download = button.getAttribute('data-filename') || 'remora.txt'
        document.body.appendChild(link)
        link.click()
        setTimeout(() => { URL.revokeObjectURL(link.href); link.remove() }, 0)
      })
    }

    for (const select of document.querySelectorAll('select[data-autosubmit]')) {
      // Choosing a level saves it; the button stays only for pages without script.
      const fallback = select.form && select.form.querySelector && select.form.querySelector('[data-autosubmit-fallback]')
      if (fallback && fallback.hidden !== undefined && fallback.getAttribute) fallback.hidden = true
      select.addEventListener('change', () => {
        const form = select.form
        if (!form) return
        if (form.hasAttribute('data-reauth')) form.requestSubmit()
        else form.submit()
      })
    }

    // Schedule form: show only the fields the chosen "when" uses; default to this device's time zone.
    for (const form of document.querySelectorAll('form[data-schedule-form]')) {
      const kind = form.querySelector('select[data-when-select]')
      const zone = form.querySelector('input[data-default-time-zone]')
      if (zone && !zone.value) {
        try { zone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { /* keep empty: UTC */ }
      }
      const sync = () => {
        for (const field of form.querySelectorAll('[data-when]')) field.hidden = !field.getAttribute('data-when').split(' ').includes(kind.value)
      }
      if (kind) {
        kind.addEventListener('change', sync)
        sync()
      }
    }
  })
})()
