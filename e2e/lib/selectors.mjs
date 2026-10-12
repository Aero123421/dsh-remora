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

/** The Remora settings page (packages/dsh-remora/src/ui/page.tsx), English locale. */
export const remora = {
  section: [testid('remora-page'), css('div.rmr:has(#kill-switch)')],
  heading: role('heading', { name: 'Remora', exact: true }),
  // Scoped to the section located above.
  /** Kill switch card; its state is data-on="true|false", the button inside toggles it. */
  killSwitch: [testid('remora-kill-switch'), css('#kill-switch')],
  killSwitchButton: [css('button')],
  /** Tabs inside the page (SegmentedControl). */
  tab: name => [scope => scope.locator('.rmr-tabs, #rmr-tabs').getByText(name, { exact: true }), scope => scope.getByRole('radio', { name, exact: true }), scope => scope.getByRole('tab', { name, exact: true }), scope => scope.getByText(name, { exact: true })],
  tabs: { connection: 'Connection', permissions: 'Permissions', scope: 'Scope', activity: 'Clients & audit log', compat: 'Compatibility & updates' },
  loadFailed: css('[role="alert"]'),
  // Connection tab.
  hubUrlInput: [testid('remora-hub-url'), role('textbox', { name: /hub url|ハブの ?URL/i })],
  pairStart: [testid('remora-pair-start'), role('button', { name: /^(start pairing|re-?pair)|ペアリング/i })],
  pairCode: [testid('remora-pair-code'), css('.rmr-code')],
  hubConnected: [css('[data-testid="remora-hub-status"][data-state="connected"]'), text('Connected')],
  // Permissions tab: the DSH-side ceiling ("Can request" is what task.start needs).
  ceilingRequest: [testid('remora-ceiling-request'), css('button[role="radio"][data-level="request"]')],
  /** "Full remote access" and the dialog that turns it on. */
  ceilingFull: [testid('remora-ceiling-full'), css('button[role="radio"][data-level="full"]')],
  fullConfirm: [role('button', { name: 'Turn on', exact: true }), role('button', { name: '有効にする', exact: true })],
  // Scope tab: the workspace allow list (Switch per workspace).
  scopeSwitches: [css('[role="switch"]')],
  // Permissions tab, "Answers from outside".
  answers: [testid('remora-answers'), css('#answers')],
  approvalsFromRemote: [role('switch', { name: 'Allow approvals from MCP and CLI', exact: true }), role('switch', { name: '承認を MCP・CLI からも許可する', exact: true })],
}

/** Hub pages (hub/src/ui/routes.ts, hub/src/pair.ts), Japanese UI. */
export const hub = {
  setupTokenInput: [testid('hub-setup-token'), css('form[data-setup] input[name="setupToken"]')],
  setupLabelInput: [testid('hub-setup-label'), css('form[data-setup] input[name="label"]')],
  registerPasskey: [testid('hub-register-passkey'), css('form[data-setup] button[type="submit"]')],
  setupStatus: [css('form[data-setup] [data-status]')],
  recoveryCodes: [testid('hub-recovery-codes'), css('[data-recovery-codes]')],
  recoveryAcknowledge: [testid('hub-recovery-ack'), css('[data-after-setup] a.button.primary')],
  /** The signed-in navigation (absent on the narrow setup and login pages). */
  signedIn: [css('[data-testid="hub-signed-in"] a[href="/settings"]'), css('nav.nav a[href="/settings"]')],
  loginButton: [css('button[data-login]')],
  /** /pair?code=XXXX-XXXX */
  pairCode: [testid('hub-pair-code'), css('strong.code')],
  pairApprove: [testid('hub-pair-approve'), css('button[name="decision"][value="approve"]')],
  pairApproved: [testid('hub-pair-approved'), text(/追加しました|承認しました|paired|approved/i, { exact: false })],
  /** Personal tokens on /settings#tokens. */
  tokenForm: [css('form[action="/settings/tokens"]')],
  tokenName: [testid('hub-token-name'), css('input[name="name"]')],
  tokenScope: scope => form => form.locator(`input[name="scope"][value="${scope}"]`),
  tokenCreate: [testid('hub-token-create'), css('button[type="submit"]')],
  tokenValue: [testid('hub-secret'), css('pre#secret')],
  /** /connections: one card per client, a level <select> per host. */
  clientCard: name => scope => scope.locator('article.card').filter({ hasText: name }),
  grantSelect: [testid('hub-grant-level'), css('select[name="level"]')],
  /** The page an attention item's answerUrl opens (/attention/<hostId>/<attentionId>). */
  attentionItem: [testid('hub-attention-item'), css('article.attention-item')],
  questionOption: label => scope => scope.locator('label.check').filter({ hasText: label }).locator('input[type="radio"]'),
  questionAnswer: [testid('hub-question-answer')],
  approvalAllow: [testid('hub-approval-allow')],
  approvalReject: [testid('hub-approval-reject')],
  /** Host page: the terminal form (inside a <details>) and session search. */
  terminalOpen: scope => scope.locator('details.card').filter({ hasText: 'ターミナル' }).locator('summary'),
  terminalForm: [css('form[action$="/terminal"]')],
  /** /confirm/<hostId>/<id>: a parked command and its outcome. */
  confirmCommand: [testid('hub-confirm-command')],
  confirmRun: [testid('hub-confirm-run')],
  confirmDeny: [testid('hub-confirm-deny')],
  confirmState: [testid('hub-confirm-state')],
  terminalStdout: [testid('hub-terminal-stdout')],
  /** OAuth consent at /oauth/authorize. */
  consentApprove: [testid('hub-consent-approve'), role('button', { name: /^(allow|approve|authorize)|許可|承認/i })],
}

export const HUB_PATHS = {
  home: '/',
  setup: '/',
  tokens: '/settings#tokens',
  connections: '/connections',
}
