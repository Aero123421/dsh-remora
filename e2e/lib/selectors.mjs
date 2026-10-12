// Every selector the harness uses, in one place.
//
// DSH Web selectors target DSH 0.2.1-alpha.2 with the English locale (the
// browser context is created with locale en-US).
//
// Remora and hub selectors prefer `data-testid` hooks — the contract proposed
// to the plugin and hub streams (see docs/e2e.md, "テスト用フック") — and fall
// back to accessible names in English or Japanese, so the harness works
// before and after the hooks land. Each entry is a function (page|locator) => Locator; `firstPresent`
// in lib/browser.mjs tries alternatives in order.

const css = selector => scope => scope.locator(selector)
const role = (name, options) => scope => scope.getByRole(name, options)
const text = (value, options = { exact: true }) => scope => scope.getByText(value, options)
const testid = id => scope => scope.locator(`[data-testid="${id}"]`)

/** DSH Web 0.2.1-alpha.2 (English). */
export const dsh = {
  /** "Preview Notice" shown on first use; dismissed when present. */
  previewNoticeContinue: role('button', { name: 'Continue', exact: true }),
  /** Sidebar entry that opens the settings dialog. */
  settingsOpen: [role('button', { name: 'Settings', exact: true }), text('Settings')],
  settingsDialog: [role('dialog'), css('[role="dialog"]')],
  /** Left nav entry registered by Remora through the `settings.section` slot. */
  settingsNavRemora: [scope => scope.getByRole('dialog').getByText('Remora', { exact: true }), text('Remora')],
  settingsNavGeneral: text('General'),
  settingsClose: role('button', { name: 'Close', exact: true }),
  /** Sidebar entry of the Plugins page. */
  pluginsOpen: [role('button', { name: 'Plugins', exact: true }), text('Plugins')],
  /** Chat composer of the selected session (present once a workspace exists). */
  composer: css('[data-composer-input][contenteditable="true"]'),
}

/** The Remora settings tab (packages/dsh-remora/src/client.tsx). */
export const remora = {
  section: [testid('remora-section'), css('section.dsh-remora')],
  heading: role('heading', { name: 'Remora', exact: true }),
  // Scoped to the section located above.
  /** Kill switch toggle; its state is aria-pressed. */
  killSwitch: [testid('remora-kill-switch'), css('button[aria-pressed]')],
  /** Plugin and protocol version line, e.g. "0.0.1 · protocol 1". */
  version: [testid('remora-version'), text(/· protocol \d+/, { exact: false })],
  hubStatus: [testid('remora-hub-status'), css('.dsh-remora-dot')],
  hubConnected: [css('[data-testid="remora-hub-status"][data-state="connected"]'), text('Connected')],
  loadFailed: css('[role="alert"]'),
  // Pairing (planned; P0 scaffold has none of these yet).
  hubUrlInput: [testid('remora-hub-url'), role('textbox', { name: /hub url|ハブの? ?URL/i })],
  pairStart: [testid('remora-pair-start'), role('button', { name: /^(pair|connect)|ペアリング|接続/i })],
  pairCode: [testid('remora-pair-code'), text(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, { exact: false })],
  /** DSH-side ceiling for remote access ("Can request" is what task.start needs). */
  ceilingRequest: [testid('remora-ceiling-request'), role('radio', { name: /request|依頼/i }), role('option', { name: /request|依頼/i })],
}

/** Hub pages (hub/src/ui.ts). */
export const hub = {
  setupTokenInput: [testid('hub-setup-token'), role('textbox', { name: /setup token|セットアップ/i })],
  registerPasskey: [testid('hub-register-passkey'), role('button', { name: /(register|create).*passkey|passkey.*(register|create)|パスキー.*(登録|作成)/i })],
  signInPasskey: [testid('hub-sign-in'), role('button', { name: /sign in|ログイン|サインイン/i })],
  signedIn: [testid('hub-signed-in'), role('button', { name: /sign out|ログアウト|サインアウト/i })],
  recoveryCodes: [testid('hub-recovery-codes')],
  recoveryAcknowledge: [testid('hub-recovery-ack'), role('button', { name: /saved|continue|done|保存しました|続ける/i })],
  /** /pair?code=XXXX-XXXX */
  pairCode: [testid('hub-pair-code')],
  pairApprove: [testid('hub-pair-approve'), role('button', { name: /approve|承認/i })],
  pairApproved: [testid('hub-pair-approved'), text(/paired|approved|承認しました|ペアリングしました/i, { exact: false })],
  /** Personal tokens page (path in HUB_PATHS.tokens). */
  tokenName: [testid('hub-token-name'), role('textbox', { name: /name|名前/i })],
  tokenScopeRequest: [testid('hub-token-scope-tasks'), role('checkbox', { name: /dsh\.tasks|request/i })],
  tokenCreate: [testid('hub-token-create'), role('button', { name: /create token|new token|issue|発行|作成/i })],
  tokenValue: [testid('hub-token-value')],
  /** OAuth consent at /oauth/authorize. */
  consentApprove: [testid('hub-consent-approve'), role('button', { name: /^(allow|approve|authorize)|許可|承認/i })],
}

export const HUB_PATHS = {
  home: '/',
  setup: '/setup',
  tokens: '/tokens',
}
