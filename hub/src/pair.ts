/**
 * Pairing a DSH host (see vendor/protocol/pairing.ts): unauthenticated,
 * rate-limited start and signed polls for the plugin; an owner page that
 * needs a login and a passkey re-authentication to approve.
 */
import { getSession } from './auth.ts'
import { RATE_LIMITS, hubOrigin } from './config.ts'
import { clientIp, errorResponse, html, json, readForm, readJson, redirect, sameOrigin } from './http.ts'
import { hostStub, hubStub } from './meter.ts'
import { flash, h, narrowHtml, pageHead, raw, uiFor, type Raw, type Ui } from './ui/layout.ts'
import { pairSteps } from './ui/routes.ts'
import { revokeHostEverywhere } from './ops.ts'
import { isRawEd25519Key, newHostId, verifyEd25519 } from './util.ts'
import { ENDPOINTS, PAIRING_POLL_INTERVAL_MS, formatUserCode, isSupportedProtocol, normalizeUserCode, type PairPollRequest, type PairStartRequest, type PairStartResponse, type UnpairRequest, unpairMessage } from './vendor/protocol/index.ts'

export async function pairStart(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
  const [max, window] = RATE_LIMITS.pairStart
  if (!(await hubStub(env).hit(`pair:${clientIp(request)}`, max, window))) return errorResponse({ code: 'rate_limited', message: 'Too many pairing attempts; try again later.' })
  let body: Partial<PairStartRequest>
  try {
    body = (await readJson(request, 4096)) as Partial<PairStartRequest>
  } catch {
    return errorResponse({ code: 'invalid_request', message: 'invalid JSON' })
  }
  if (!isSupportedProtocol(body.protocol)) return errorResponse({ code: 'protocol_mismatch', message: 'This hub does not speak the protocol version of this plugin. Update the plugin or the hub.' })
  if (!isRawEd25519Key(body.publicKey)) return errorResponse({ code: 'invalid_request', message: 'publicKey must be a raw 32-byte Ed25519 key in base64url' })
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
  const pluginVersion = typeof body.pluginVersion === 'string' ? body.pluginVersion.slice(0, 40) : ''
  if (!name) return errorResponse({ code: 'invalid_request', message: 'name is required' })
  let started
  try {
    started = await hubStub(env).pairStart({ publicKey: body.publicKey, name, pluginVersion, protocol: body.protocol }, clientIp(request))
  } catch {
    return errorResponse({ code: 'rate_limited', message: 'Too many pending pairings on this hub.' })
  }
  const origin = hubOrigin(request, env)
  const response: PairStartResponse = {
    pairingId: started.pairingId,
    userCode: started.userCode,
    verifyUrl: `${origin}${ENDPOINTS.pairApprove}?code=${formatUserCode(started.userCode)}`,
    expiresAt: started.expiresAt,
    pollIntervalMs: PAIRING_POLL_INTERVAL_MS,
  }
  return json(response)
}

export async function pairPoll(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
  let body: Partial<PairPollRequest>
  try {
    body = (await readJson(request, 4096)) as Partial<PairPollRequest>
  } catch {
    return errorResponse({ code: 'invalid_request', message: 'invalid JSON' })
  }
  if (typeof body.pairingId !== 'string' || typeof body.signature !== 'string' || body.pairingId.length > 100) return errorResponse({ code: 'invalid_request', message: 'pairingId and signature are required' })
  const hub = hubStub(env)
  const [max, window] = RATE_LIMITS.pairPoll
  if (!(await hub.hit(`pairpoll:${clientIp(request)}`, max, window))) return errorResponse({ code: 'rate_limited', message: 'Polling too fast.' })
  const result = await hub.pairPoll(body.pairingId, body.signature, hubOrigin(request, env))
  if (result.status === 'invalid') return errorResponse({ code: 'denied', message: 'The poll signature does not match the key that started this pairing.' })
  return json(result)
}

function pairPage(ui: Ui, title: string, body: Raw): Response {
  return html(narrowHtml(ui, title, body))
}

export async function pairApprovePage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const ui = uiFor(request)
  const { t, i18n } = ui
  const session = await getSession(request, env)
  if (!session) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`)
  const code = normalizeUserCode(url.searchParams.get('code') ?? '')
  const done = url.searchParams.get('done')
  if (done === 'denied') return pairPage(ui, t('pair.deniedTitle'), h`${pageHead(t('pair.deniedTitle'), { subtitle: t('pair.deniedLead') })}<div class="actions"><a class="btn" href="/">${t('notFound.home')}</a></div>`)
  const info = code ? await hubStub(env).pairLookup(code) : null
  if (!info || info.status !== 'pending') {
    return pairPage(ui, t('pair.title'), h`${pageHead(t('pair.title'), { subtitle: t('pair.lead') })}
${code ? flash(t('pair.notFound'), 'error') : ''}
<form method="get" action="${ENDPOINTS.pairApprove}" class="stack">
  <label class="field"><span class="label">${t('pair.code')}</span><input name="code" placeholder="XXXX-XXXX" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" required class="code-big"></label>
  <button class="primary" type="submit">${t('pair.next')}</button>
</form>
<details class="plain mt"${raw(code ? '' : ' open')}><summary>${t('pair.howTitle')}</summary>${pairSteps(ui, hubOrigin(request, env), false)}</details>`)
  }
  return pairPage(ui, t('pair.confirmTitle'), h`${pageHead(t('pair.confirmTitle'))}
${url.searchParams.get('msg') === 'reauth' ? flash(t('msg.reauth'), 'error') : ''}
<div class="box"><dl class="kv">
  <dt>${t('pair.host')}</dt><dd><strong class="untrusted">${info.name}</strong></dd>
  <dt>${t('pair.code')}</dt><dd><span class="code-big" data-testid="hub-pair-code">${formatUserCode(info.userCode)}</span></dd>
  <dt>${t('pair.started')}</dt><dd>${i18n.relative(info.createdAt)}</dd>
  <dt>${t('pair.plugin')}</dt><dd>${info.pluginVersion || '—'}</dd>
  <dt>${t('pair.fingerprint')}</dt><dd><code>${info.publicKeyFingerprint}</code></dd>
</dl></div>
<div class="notice warn mt">${t('pair.check')}</div>
<p class="muted small">${t('pair.effect')}</p>
<form method="post" action="${ENDPOINTS.pairApprove}" data-reauth>
  <input type="hidden" name="code" value="${info.userCode}">
  <div class="actions">
    <button class="primary" type="submit" name="decision" value="approve" data-testid="hub-pair-approve">${t('pair.approve')}</button>
    <button type="submit" name="decision" value="deny" data-no-reauth>${t('pair.deny')}</button>
  </div>
  <div data-status role="status" hidden></div>
</form>`)
}

export async function pairApprovePost(request: Request, env: Env): Promise<Response> {
  if (!sameOrigin(request, hubOrigin(request, env))) return new Response('cross-origin request refused', { status: 403 })
  const session = await getSession(request, env)
  if (!session) return redirect('/login')
  const form = await readForm(request)
  const code = normalizeUserCode(form.get('code') ?? '')
  const hub = hubStub(env)
  if (form.get('decision') !== 'approve') {
    await hub.pairDecide(code, false, '')
    return redirect(`${ENDPOINTS.pairApprove}?done=denied`)
  }
  if (!session.fresh) return redirect(`${ENDPOINTS.pairApprove}?code=${encodeURIComponent(code)}&msg=reauth`)
  const host = await hub.pairDecide(code, true, newHostId())
  if (!host) return redirect(`${ENDPOINTS.pairApprove}?code=${encodeURIComponent(code)}`)
  await hostStub(env, host.hostId).provision(host.hostId, host.publicKey, host.name)
  return redirect(`/hosts/${host.hostId}?paired=1`)
}

/** How far `issuedAt` of a self-unpair may be from now. */
export const UNPAIR_WINDOW_MS = 5 * 60_000

/**
 * A paired host removes itself: the request is signed with its host key over
 * `unpairMessage(hubOrigin, hostId, issuedAt)`. On success the host is revoked
 * exactly like the owner's revoke (socket closed, open tasks failed, audited).
 */
export async function hostUnpair(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
  const hub = hubStub(env)
  const [max, window] = RATE_LIMITS.unpair
  if (!(await hub.hit(`unpair:${clientIp(request)}`, max, window))) return errorResponse({ code: 'rate_limited', message: 'Too many unpair attempts; try again later.' })
  let body: Partial<UnpairRequest>
  try {
    body = (await readJson(request, 4096)) as Partial<UnpairRequest>
  } catch {
    return errorResponse({ code: 'invalid_request', message: 'invalid JSON' })
  }
  if (typeof body.hostId !== 'string' || typeof body.issuedAt !== 'number' || typeof body.signature !== 'string' || body.hostId.length > 64) {
    return errorResponse({ code: 'invalid_request', message: 'hostId, issuedAt and signature are required' })
  }
  if (Math.abs(Date.now() - body.issuedAt) > UNPAIR_WINDOW_MS) return errorResponse({ code: 'invalid_request', message: 'issuedAt is more than 5 minutes away from the hub clock.' })
  const host = await hub.getHost(body.hostId)
  if (!host || host.revokedAt !== null) return errorResponse({ code: 'not_found', message: 'This host is not paired with the hub.' })
  const ok = await verifyEd25519(host.publicKey, unpairMessage(hubOrigin(request, env), body.hostId, body.issuedAt), body.signature)
  if (!ok) return errorResponse({ code: 'denied', message: 'The signature does not match the key paired for this host.' })
  await revokeHostEverywhere(env, body.hostId, 'host')
  return json({ ok: true })
}
