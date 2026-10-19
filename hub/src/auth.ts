/**
 * Owner authentication: first-run setup gated by SETUP_TOKEN, passkey
 * registration and login (SimpleWebAuthn), server-side sessions in HubDO,
 * recovery codes, re-authentication for sensitive actions, and passkey
 * confirmations of dangerous operations.
 */
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { cose, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers'
import { RATE_LIMITS, SESSION_COOKIE, SESSION_MAX_MS, hubOrigin, secrets } from './config.ts'
import { clearCookie, clientIp, getCookie, json, readForm, readJson, redirect, sameOrigin, sessionCookie } from './http.ts'
import { hubStub } from './meter.ts'
import { confirmations, finalParams } from './ops.ts'
import type { PasskeyRecord } from './types.ts'
import { randomToken, safeEqual, sha256Hex } from './util.ts'
import { confirmationChallenge, fromBase64Url, toBase64Url } from './vendor/protocol/index.ts'

export interface OwnerSession {
  hash: string
  /** A passkey (or recovery code) was used within the re-authentication window. */
  fresh: boolean
}

/** A copy backed by a plain ArrayBuffer, as the WebAuthn library's types require. */
function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(fromBase64Url(text))
}

export function rpIdOf(origin: string): string {
  return new URL(origin).hostname
}

export async function getSession(request: Request, env: Env): Promise<OwnerSession | null> {
  const token = getCookie(request, SESSION_COOKIE)
  if (!token || token.length > 100) return null
  const hash = await sha256Hex(`remora-session/v1\n${token}`)
  const state = await hubStub(env).touchSession(hash)
  return state.valid ? { hash, fresh: state.fresh } : null
}

async function startSession(env: Env): Promise<string> {
  const token = randomToken(32)
  await hubStub(env).createSession(await sha256Hex(`remora-session/v1\n${token}`))
  return sessionCookie(SESSION_COOKIE, token, Math.floor(SESSION_MAX_MS / 1000))
}

/**
 * `reason` names the failure for the page script, which shows it in the
 * reader's language (`js.error.<reason>`); `message` stays for API callers.
 */
const fail = (status: number, message: string, reason: string) => json({ error: { code: status === 429 ? 'rate_limited' : status === 403 ? 'denied' : status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'invalid_request', message, reason } }, { status })

function algorithmOf(publicKey: Uint8Array<ArrayBuffer>): number {
  const alg = decodeCredentialPublicKey(publicKey).get(cose.COSEKEYS.alg)
  if (typeof alg !== 'number') throw new Error('credential public key has no algorithm')
  return alg
}

async function verifyRegistration(env: Env, origin: string, challengeId: unknown, response: unknown, kind: string, label: unknown): Promise<PasskeyRecord | null> {
  if (typeof challengeId !== 'string' || typeof response !== 'object' || response === null) return null
  const stored = await hubStub(env).takeChallenge(challengeId, kind)
  if (!stored) return null
  try {
    const verification = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpIdOf(origin),
      requireUserVerification: true,
    })
    if (!verification.verified) return null
    const { credential } = verification.registrationInfo
    return {
      credentialId: credential.id,
      publicKey: toBase64Url(credential.publicKey),
      algorithm: algorithmOf(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : 'Passkey',
      createdAt: Date.now(),
      lastUsedAt: null,
    }
  } catch {
    return null
  }
}

async function registrationOptions(env: Env, origin: string, kind: string) {
  const hub = hubStub(env)
  const existing = await hub.listPasskeys()
  const options = await generateRegistrationOptions({
    rpName: 'Remora',
    rpID: rpIdOf(origin),
    userName: 'owner',
    userDisplayName: 'Remora owner',
    userID: bytes(await hub.ownerUserId()),
    attestationType: 'none',
    excludeCredentials: existing.map(passkey => ({ id: passkey.credentialId, transports: passkey.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  })
  const challengeId = await hub.putChallenge(kind, options.challenge)
  return { challengeId, options }
}

/** Verify an assertion from one of the owner's passkeys against a stored challenge. */
async function verifyAssertion(env: Env, origin: string, challengeId: unknown, response: unknown, kind: string): Promise<boolean> {
  if (typeof challengeId !== 'string' || typeof response !== 'object' || response === null) return false
  const hub = hubStub(env)
  const stored = await hub.takeChallenge(challengeId, kind)
  if (!stored) return false
  const assertion = response as AuthenticationResponseJSON
  const passkey = typeof assertion.id === 'string' ? await hub.getPasskey(assertion.id) : null
  if (!passkey) return false
  try {
    const verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpIdOf(origin),
      credential: { id: passkey.credentialId, publicKey: bytes(passkey.publicKey), counter: passkey.counter, transports: passkey.transports },
      requireUserVerification: true,
    })
    if (!verification.verified) return false
    await hub.recordPasskeyUse(passkey.credentialId, verification.authenticationInfo.newCounter)
    return true
  } catch {
    return false
  }
}

async function assertionOptions(env: Env, origin: string, kind: string, withCredentials: boolean) {
  const hub = hubStub(env)
  const passkeys = withCredentials ? await hub.listPasskeys() : []
  const options = await generateAuthenticationOptions({
    rpID: rpIdOf(origin),
    userVerification: 'required',
    allowCredentials: passkeys.map(passkey => ({ id: passkey.credentialId, transports: passkey.transports })),
  })
  const challengeId = await hub.putChallenge(kind, options.challenge)
  return { challengeId, options }
}

/** Routes under /auth/. All are POST, same-origin, JSON in and out (except the recovery form). */
export async function handleAuth(request: Request, env: Env, path: string): Promise<Response> {
  const origin = hubOrigin(request, env)
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
  if (!sameOrigin(request, origin)) return fail(403, 'cross-origin request refused', 'cross-origin')
  const hub = hubStub(env)
  const ip = clientIp(request)

  if (path === '/auth/logout') {
    const session = await getSession(request, env)
    if (session) await hub.deleteSession(session.hash)
    return redirect('/login', { 'set-cookie': clearCookie(SESSION_COOKIE) })
  }

  if (path === '/auth/recovery') {
    const [max, window] = RATE_LIMITS.login
    if (!(await hub.hit(`login:${ip}`, max, window))) return redirect('/login?error=rate')
    const form = await readForm(request)
    const ok = await hub.useRecoveryCode(form.get('code') ?? '')
    if (!ok) return redirect('/login?error=recovery')
    return redirect('/settings?recovered=1#passkeys', { 'set-cookie': await startSession(env) })
  }

  let body: Record<string, unknown>
  try {
    body = (await readJson(request)) as Record<string, unknown>
  } catch {
    return fail(400, 'invalid JSON', 'bad-request')
  }

  switch (path) {
    case '/auth/setup/options': {
      const [max, window] = RATE_LIMITS.setup
      if (!(await hub.hit(`setup:${ip}`, max, window))) return fail(429, 'too many attempts', 'rate-limited')
      const state = await hub.state()
      const expected = secrets(env).SETUP_TOKEN
      if (state.setupComplete) return fail(403, 'setup is already complete', 'setup-done')
      if (!expected || expected.length < 16) return fail(403, 'SETUP_TOKEN is not set (at least 16 characters)', 'setup-token-missing')
      if (typeof body.setupToken !== 'string' || !safeEqual(await sha256Hex(body.setupToken), await sha256Hex(expected))) return fail(403, 'wrong setup token', 'setup-token-wrong')
      return json(await registrationOptions(env, origin, 'setup'))
    }
    case '/auth/setup/verify': {
      const passkey = await verifyRegistration(env, origin, body.challengeId, body.response, 'setup', body.label)
      if (!passkey) return fail(400, 'passkey registration failed', 'register-failed')
      const codes = await hub.completeSetup(passkey)
      if (!codes) return fail(403, 'setup is already complete', 'setup-done')
      return json({ ok: true, recoveryCodes: codes }, { headers: { 'set-cookie': await startSession(env) } })
    }
    case '/auth/login/options': {
      const [max, window] = RATE_LIMITS.login
      if (!(await hub.hit(`login:${ip}`, max, window))) return fail(429, 'too many attempts', 'rate-limited')
      return json(await assertionOptions(env, origin, 'login', false))
    }
    case '/auth/login/verify': {
      if (!(await verifyAssertion(env, origin, body.challengeId, body.response, 'login'))) {
        await hub.audit({ actor: 'owner', actorName: 'オーナー', operation: 'login.passkey', hostId: null, outcome: 'denied', layer: null, reason: 'assertion-failed' })
        return fail(403, 'passkey sign-in failed', 'sign-in-failed')
      }
      await hub.audit({ actor: 'owner', actorName: 'オーナー', operation: 'login.passkey', hostId: null, outcome: 'ok', layer: null, reason: null })
      return json({ ok: true }, { headers: { 'set-cookie': await startSession(env) } })
    }
  }

  // Everything below needs a signed-in owner.
  const session = await getSession(request, env)
  if (!session) return fail(403, 'sign in first', 'signed-out')

  switch (path) {
    case '/auth/reauth/options':
      return json(await assertionOptions(env, origin, 'reauth', true))
    case '/auth/reauth/verify': {
      if (!(await verifyAssertion(env, origin, body.challengeId, body.response, 'reauth'))) return fail(403, 'passkey check failed', 'reauth-failed')
      await hub.markReauth(session.hash)
      return json({ ok: true })
    }
    case '/auth/passkeys/options':
      if (!session.fresh) return json({ error: { code: 'reauth_required', message: 'confirm with a passkey first' } }, { status: 403 })
      return json(await registrationOptions(env, origin, 'add-passkey'))
    case '/auth/passkeys/verify': {
      if (!session.fresh) return fail(403, 'confirm with a passkey first', 'reauth-needed')
      const passkey = await verifyRegistration(env, origin, body.challengeId, body.response, 'add-passkey', body.label)
      if (!passkey || !(await hub.addPasskey(passkey))) return fail(400, 'passkey registration failed', 'register-failed')
      return json({ ok: true })
    }
    case '/auth/confirm/options': {
      // A WebAuthn assertion bound to one request on one host, verified by the DSH plugin.
      const hostId = body.hostId
      const operation = body.operation
      if (typeof hostId !== 'string' || typeof operation !== 'string') return fail(400, 'hostId and operation are required', 'bad-request')
      const requestId = `r_${randomToken(12)}`
      const issuedAt = Date.now()
      let rawParams = typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params) ? (body.params as Record<string, unknown>) : {}
      if (typeof body.pendingId === 'string') {
        // A request a client parked for the owner: sign over exactly what it asked for.
        const pending = await confirmations(env, hostId).view(body.pendingId)
        if (!pending || pending.state !== 'pending' || pending.operation !== operation) return fail(409, 'this request is no longer waiting', 'gone')
        rawParams = pending.params
      }
      if (typeof rawParams.hostId === 'string' && rawParams.hostId !== hostId) return fail(400, 'params.hostId does not match hostId', 'bad-request')
      // The challenge covers the params the host will see, hostId included.
      const params = finalParams(operation, rawParams, hostId)
      const challenge = await confirmationChallenge({ hubOrigin: origin, hostId, requestId, operation, params, issuedAt })
      const passkeys = await hub.listPasskeys()
      const options = await generateAuthenticationOptions({
        rpID: rpIdOf(origin),
        userVerification: 'required',
        challenge: bytes(challenge),
        allowCredentials: passkeys.map(passkey => ({ id: passkey.credentialId, transports: passkey.transports })),
      })
      return json({ requestId, issuedAt, params, options })
    }
  }
  return fail(404, 'not found', 'bad-request')
}
