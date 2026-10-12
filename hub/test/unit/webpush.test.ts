import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encryptPayload, fromBase64Url, generateVapidKeys, isPushEndpoint, isSubscriptionKey, toBase64Url, vapidAuthorization } from '../../src/webpush.ts'
import { decryptPush, importReceiver, newReceiver, verifyVapid } from '../push-crypto.ts'

// RFC 8291 Appendix A.
const VECTOR = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('RFC 8291 test vector: decrypting the published message gives the plaintext', async () => {
  const receiver = await importReceiver(VECTOR.uaPrivate, VECTOR.uaPublic, VECTOR.auth)
  const plain = await decryptPush(fromBase64Url(VECTOR.message), receiver)
  assert.equal(plain, new TextDecoder().decode(fromBase64Url(VECTOR.plaintext)))
})

test('RFC 8291 test vector: our encryption reproduces the published message byte for byte', async () => {
  const sender = await importReceiver(VECTOR.asPrivate, VECTOR.asPublic, VECTOR.auth)
  const body = await encryptPayload(fromBase64Url(VECTOR.plaintext), VECTOR.uaPublic, VECTOR.auth, { salt: fromBase64Url(VECTOR.salt), senderKeys: sender.keys })
  const expected = fromBase64Url(VECTOR.message)
  assert.equal(toBase64Url(body), toBase64Url(expected))
})

test('round trip with fresh keys, and a valid VAPID JWT', async () => {
  const receiver = await newReceiver()
  const payload = JSON.stringify({ kind: 'approval', host: 'desk', title: '日本語のタイトル', url: '/attention/x/y' })
  const body = await encryptPayload(new TextEncoder().encode(payload), receiver.p256dh, receiver.auth)
  assert.equal(await decryptPush(body, receiver), payload)

  const keys = await generateVapidKeys()
  assert.equal(fromBase64Url(keys.publicKey).length, 65)
  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://hub.example.com')
  const claims = await verifyVapid(header, keys.publicKey)
  assert.equal(claims.aud, 'https://fcm.googleapis.com')
  assert.equal(claims.sub, 'https://hub.example.com')
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600)
})

test('only known push services and well-formed keys are accepted', async () => {
  assert.equal(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x'), true)
  assert.equal(isPushEndpoint('https://web.push.apple.com/QGx'), true)
  assert.equal(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true)
  assert.equal(isPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x'), true)
  for (const bad of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://googleapis.com.evil.example/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 42]) {
    assert.equal(isPushEndpoint(bad), false, String(bad))
  }
  const receiver = await newReceiver()
  assert.equal(isSubscriptionKey(receiver.p256dh, 65), true)
  assert.equal(isSubscriptionKey(receiver.auth, 16), true)
  assert.equal(isSubscriptionKey(receiver.auth, 65), false)
  assert.equal(isSubscriptionKey('not base64!', 16), false)
})
