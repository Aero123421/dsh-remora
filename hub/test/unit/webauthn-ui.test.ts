import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../public/js/webauthn.js', import.meta.url), 'utf8')

function ui(kind: 'add' | 'grant', stale = false) {
  const calls: string[] = []
  const status = { textContent: '', className: '', hidden: true }
  const select = { value: 'full', disabled: false, options: [{ value: 'view', defaultSelected: false }, { value: 'full', defaultSelected: true }] }
  const button = { disabled: false }
  let submit: (event: { preventDefault(): void }) => Promise<void>
  let change: () => void
  let ready: () => void
  let cancelled = false
  const form = {
    dataset: {} as Record<string, string>,
    addEventListener(_type: string, handler: typeof submit) { submit = handler },
    querySelector(selector: string) { return selector === '[data-status]' ? status : kind === 'grant' ? select : null },
    querySelectorAll() { return [select, button] },
    hasAttribute(name: string) { return name === 'data-reauth' && kind === 'grant' },
    submit() { calls.push(`submit:${select.value}`) },
    requestSubmit() { return submit({ preventDefault() {} }) },
  }
  const enhancedSelect = Object.assign(select, { form, addEventListener(_type: string, handler: () => void) { change = handler } })
  let optionRequests = 0
  const credentials = {
    async get() {
      calls.push('get')
      if (cancelled) throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
      return { toJSON: () => ({ id: 'old-key', response: {} }) }
    },
    async create() {
      calls.push('create')
      return { toJSON: () => ({ id: 'new-key', response: {} }) }
    },
  }
  runInNewContext(source, {
    window: { PublicKeyCredential: {} },
    PublicKeyCredential: { parseCreationOptionsFromJSON: (options: unknown) => options, parseRequestOptionsFromJSON: (options: unknown) => options },
    navigator: { credentials },
    document: {
      addEventListener(_type: string, handler: () => void) { ready = handler },
      querySelectorAll(selector: string) {
        if (kind === 'add' && selector === 'form[data-add-passkey]') return [form]
        if (kind === 'grant' && selector === 'form[data-reauth]') return [form]
        if (kind === 'grant' && selector === 'select[data-autosubmit]') return [enhancedSelect]
        return []
      },
      querySelector() { return status },
    },
    FormData: class { get() { return 'replacement key' } },
    location: { assign(path: string) { calls.push(`navigate:${path}`) } },
    fetch: async (path: string) => {
      calls.push(path)
      if (path === '/auth/passkeys/options' && stale && optionRequests++ === 0) return { ok: false, json: async () => ({ error: { code: 'reauth_required', message: 'confirm first' } }) }
      return { ok: true, json: async () => ({ challengeId: 'test', options: {} }) }
    },
  })
  ready!()
  return { calls, status, select, button, submit: () => form.requestSubmit(), change: () => change!(), cancel: (value: boolean) => { cancelled = value } }
}

test('a server-approved fresh recovery session registers a replacement without the lost key', async () => {
  const page = ui('add')
  await page.submit()
  assert.deepEqual(page.calls, ['/auth/passkeys/options', 'create', '/auth/passkeys/verify', 'navigate:/settings?msg=passkey-added#passkeys'])
})

test('a stale session reauthenticates only after the server requires it, then retries registration', async () => {
  const page = ui('add', true)
  await page.submit()
  assert.deepEqual(page.calls, ['/auth/passkeys/options', '/auth/reauth/options', 'get', '/auth/reauth/verify', '/auth/passkeys/options', 'create', '/auth/passkeys/verify', 'navigate:/settings?msg=passkey-added#passkeys'])
})

test('cancelled grant autosave shows the saved scope, preserves an accessible retry and sends no change', async () => {
  const page = ui('grant')
  page.cancel(true)
  page.select.value = 'view'
  await page.change()
  // change handlers trigger the async submit; let its awaited assertion settle.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.select.value, 'full')
  assert.equal(page.status.hidden, false)
  assert.match(page.status.textContent, /変更は保存されていません/)
  assert.equal(page.button.disabled, false)
  assert.equal(page.select.disabled, false)
  assert.ok(!page.calls.some(call => call.startsWith('submit:')))
  page.cancel(false)
  page.select.value = 'view'
  await page.submit()
  assert.equal(page.calls.at(-1), 'submit:view')
})
