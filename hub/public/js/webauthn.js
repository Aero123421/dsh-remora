// Remora hub: passkey ceremonies and small enhancements. No inline script is
// allowed by the CSP, so pages mark elements with data-* attributes instead.
'use strict'

;(() => {
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
      throw error
    }
    return data
  }

  const say = (element, message, kind) => {
    const target = (element && element.querySelector('[data-status]')) || document.querySelector('[data-status]')
    if (!target) { if (kind === 'error') alert(message); return }
    target.textContent = message
    target.className = `flash ${kind || 'ok'}`
    target.hidden = false
  }

  const explain = error => {
    if (error && error.name === 'NotAllowedError') return 'パスキーの操作が取り消されたか、時間切れになりました。'
    if (error && error.name === 'InvalidStateError') return 'このパスキーはすでに登録されています。'
    return (error && error.message) || String(error)
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

  // Same rule as safeNext() in src/util.ts: a path on this origin only.
  const safeNext = value => {
    if (!value || !value.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(value)) return '/'
    try {
      const url = new URL(value, location.origin)
      return url.origin === location.origin ? url.pathname + url.search + url.hash : '/'
    } catch { return '/' }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!supported()) {
      for (const element of document.querySelectorAll('[data-needs-webauthn]')) element.hidden = false
    }

    // First-run setup: SETUP_TOKEN + the first passkey, then show the recovery codes once.
    for (const form of document.querySelectorAll('form[data-setup]')) {
      form.addEventListener('submit', async event => {
        event.preventDefault()
        const data = new FormData(form)
        try {
          const result = await register('/auth/setup', { setupToken: String(data.get('setupToken') || ''), label: String(data.get('label') || '') })
          const codes = document.querySelector('[data-recovery-codes]')
          if (codes) {
            codes.textContent = result.recoveryCodes.join('\n')
            codes.closest('[data-after-setup]').hidden = false
          }
          form.hidden = true
        } catch (error) {
          say(form, explain(error), 'error')
        }
      })
    }

    for (const button of document.querySelectorAll('[data-login]')) {
      button.addEventListener('click', async () => {
        try {
          const { challengeId, options } = await post('/auth/login/options')
          const credential = await navigator.credentials.get({ publicKey: requestOptions(options) })
          await post('/auth/login/verify', { challengeId, response: credentialJson(credential) })
          location.assign(safeNext(button.getAttribute('data-next')))
        } catch (error) {
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
          say(form, explain(error) + (select ? ' 変更は保存されていません。範囲を選び直して保存してください。' : ''), 'error')
        }
      })
    }

    for (const form of document.querySelectorAll('form[data-add-passkey]')) {
      form.addEventListener('submit', async event => {
        event.preventDefault()
        try {
          await register('/auth/passkeys', { label: String(new FormData(form).get('label') || '') })
          location.assign('/settings?msg=passkey-added#passkeys')
        } catch (error) {
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
        try {
          // The hub returns the exact params it signed over (hostId filled in); send those back.
          const { requestId, issuedAt, params: signed, options } = await post('/auth/confirm/options', { hostId, operation, params, ...pending })
          const credential = await navigator.credentials.get({ publicKey: requestOptions(options) })
          const json = credentialJson(credential)
          const assertion = { credentialId: json.id, authenticatorData: json.response.authenticatorData, clientDataJSON: json.response.clientDataJSON, signature: json.response.signature, userHandle: json.response.userHandle || null }
          await post('/ops/confirmed', { hostId, operation, params: signed || params, requestId, issuedAt, assertion, ...pending })
          location.assign(form.getAttribute('data-done') || location.href)
        } catch (error) {
          say(form, explain(error), 'error')
        }
      })
    }

    for (const button of document.querySelectorAll('[data-copy]')) {
      button.addEventListener('click', async () => {
        const source = document.querySelector(button.getAttribute('data-copy'))
        if (!source) return
        try {
          await navigator.clipboard.writeText(source.textContent.trim())
          const label = button.textContent
          button.textContent = 'コピーしました'
          setTimeout(() => { button.textContent = label }, 1500)
        } catch { /* clipboard unavailable */ }
      })
    }

    for (const select of document.querySelectorAll('select[data-autosubmit]')) {
      select.addEventListener('change', () => {
        const form = select.form
        if (!form) return
        if (form.hasAttribute('data-reauth')) form.requestSubmit()
        else form.submit()
      })
    }
  })
})()
