import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostDO } from '../../src/host-do.ts'
import type { HubFrame } from '../../src/vendor/protocol/index.ts'
import { decryptPush, newReceiver, verifyVapid, type Receiver } from '../push-crypto.ts'
import { FakeHost, eventually, setupOwner, sleep } from './helpers.ts'

const hub = () => env.HUB.get(env.HUB.idFromName('hub'))

interface Sent {
  endpoint: string
  headers: Headers
  body: Uint8Array
}

/** Capture requests to push services; everything else goes through. */
function mockPushService(status: (endpoint: string) => number): Sent[] {
  const sent: Sent[] = []
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).hostname.endsWith('.googleapis.com')) {
      sent.push({ endpoint: request.url, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) })
      return new Response(null, { status: status(request.url) })
    }
    return realFetch(input, init)
  })
  return sent
}

async function payloadOf(sent: Sent, receiver: Receiver): Promise<Record<string, unknown>> {
  return JSON.parse(await decryptPush(sent.body, receiver)) as Record<string, unknown>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Web Push notifications', () => {
  it('subscribes a device, pushes encrypted, VAPID-signed notifications and drops gone subscriptions', async () => {
    const owner = await setupOwner()
    const phone = await newReceiver()
    const laptop = await newReceiver()
    const phoneEndpoint = 'https://fcm.googleapis.com/fcm/send/phone-1'
    const laptopEndpoint = 'https://fcm.googleapis.com/fcm/send/laptop-1'

    const settings = await (await owner.browser.fetch('/settings')).text()
    const vapidKey = await hub().vapidPublicKey()
    expect(settings).toContain(`data-vapid-key="${vapidKey}"`)
    expect(settings).toContain('ホーム画面に追加')

    // Subscribe: bad endpoints and keys are refused, then two devices.
    const bad = await owner.browser.postJson('/push/subscribe', { subscription: { endpoint: 'https://evil.example/push', keys: { p256dh: phone.p256dh, auth: phone.auth } } })
    expect(bad.status).toBe(400)
    const badKeys = await owner.browser.postJson('/push/subscribe', { subscription: { endpoint: phoneEndpoint, keys: { p256dh: phone.auth, auth: phone.auth } } })
    expect(badKeys.status).toBe(400)
    const forged = await owner.browser.fetch('/push/subscribe', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
    expect(forged.status).toBe(403)
    expect((await owner.browser.postJson('/push/subscribe', { subscription: { endpoint: phoneEndpoint, expirationTime: null, keys: { p256dh: phone.p256dh, auth: phone.auth } }, label: 'iPhone Safari（ホーム画面）' })).status).toBe(200)
    expect((await owner.browser.postJson('/push/subscribe', { subscription: { endpoint: laptopEndpoint, keys: { p256dh: laptop.p256dh, auth: laptop.auth } }, label: 'Mac Chrome' })).status).toBe(200)
    const devices = await hub().listPushDevices()
    expect(devices.map(device => device.label)).toEqual(['iPhone Safari（ホーム画面）', 'Mac Chrome'])
    // The laptop only wants task notifications.
    const laptopId = devices[1]?.id as string
    await owner.browser.postForm('/settings/push/types', { id: laptopId, type: ['tasks'] })
    expect((await hub().listPushDevices())[1]?.types).toEqual(['tasks'])

    const sent = mockPushService(() => 201)
    const host = await FakeHost.create()
    await host.pair(owner, 'desk')
    host.respond = frame => frame.op === 'task.start' ? { ok: true, result: { taskId: frame.taskId, state: 'accepted', createdAt: Date.now(), updatedAt: Date.now() } } : { ok: true, result: {} }
    await host.connect()
    await host.next('ready')

    // A new approval: one push to the phone only, encrypted and signed.
    const expiresAt = Date.now() + 5 * 60_000
    const approval = { attentionId: 'approval:42', hostId: '', sessionId: 's1', kind: 'approval', title: `Approve shell: deploy with token sk-${'x'.repeat(30)} ${'and more words '.repeat(10)}`, answerable: true, answerVia: 'hub-passkey', expiresAt, createdAt: Date.now() }
    host.sendEvent([{ kind: 'attention', sessionId: 's1', items: [approval] }])
    await eventually(async () => expect(sent).toHaveLength(1))
    const push = sent[0] as Sent
    expect(push.endpoint).toBe(phoneEndpoint)
    expect(push.headers.get('content-encoding')).toBe('aes128gcm')
    expect(push.headers.get('urgency')).toBe('high')
    expect(Number(push.headers.get('ttl'))).toBeGreaterThan(200)
    const claims = await verifyVapid(push.headers.get('authorization') as string, vapidKey)
    expect(claims.aud).toBe('https://fcm.googleapis.com')
    expect(claims.sub).toBe('https://hub.example.com')
    const payload = await payloadOf(push, phone)
    expect(payload).toMatchObject({ kind: 'approval', host: 'desk', url: `/attention/${host.hostId}/approval%3A42`, expiresAt, count: 1 })
    const title = payload.title as string
    expect(Array.from(title).length).toBeLessThanOrEqual(80)
    expect(title).not.toContain('sk-x')
    expect(JSON.stringify(payload)).not.toContain('deploy with token sk')

    // The same list again is not news.
    host.sendEvent([{ kind: 'attention', sessionId: 's1', items: [approval] }])
    await sleep(300)
    expect(sent).toHaveLength(1)

    // A finished task: both devices want task notifications.
    const stub = env.HOST.get(env.HOST.idFromName(host.hostId))
    const started = await stub.execute({ op: 'task.start', params: { target: { sessionId: 's1' }, prompt: 'p', idempotencyKey: 'push-1' }, actor: { clientId: 'hub-ui', clientName: 'UI' }, scopes: ['dsh.tasks'], grant: { level: 'request' } })
    const taskId = (started as unknown as { result: { taskId: string } }).result.taskId
    host.sendEvent([{ kind: 'task', taskId, state: 'completed', updatedAt: Date.now() }])
    await eventually(async () => expect(sent).toHaveLength(3))
    const taskPushes = sent.slice(1)
    expect(taskPushes.map(item => item.endpoint).sort()).toEqual([laptopEndpoint, phoneEndpoint].sort())
    const forLaptop = taskPushes.find(item => item.endpoint === laptopEndpoint) as Sent
    expect(await payloadOf(forLaptop, laptop)).toMatchObject({ kind: 'task-completed', host: 'desk', url: `/tasks/${taskId}` })

    // Offline for a minute (checked by the alarm), then back: one push each.
    host.socket?.close(1000, 'bye')
    await eventually(async () => expect((await stub.summary()).online).toBe(false))
    await runInDurableObject(stub, (_instance: HostDO, state) => state.storage.sql.exec("UPDATE info SET value = ? WHERE key = 'offline_since'", String(Date.now() - 120_000)))
    await runDurableObjectAlarm(stub)
    await eventually(async () => expect(sent.filter(item => item.endpoint === phoneEndpoint)).toHaveLength(3))
    expect(await payloadOf(sent.at(-1) as Sent, phone)).toMatchObject({ kind: 'host-offline', host: 'desk' })
    const back = await FakeHost.create()
    Object.assign(back, { keys: host.keys, publicKey: host.publicKey, hostId: host.hostId })
    await back.connect()
    await back.next('ready')
    await eventually(async () => expect(sent.filter(item => item.endpoint === phoneEndpoint)).toHaveLength(4))
    expect(await payloadOf(sent.at(-1) as Sent, phone)).toMatchObject({ kind: 'host-online', host: 'desk' })

    // A push service that says the subscription is gone (410) removes it.
    vi.restoreAllMocks()
    mockPushService(endpoint => (endpoint === laptopEndpoint ? 410 : 201))
    const test = await owner.browser.postForm('/settings/push/test', {})
    expect(test.headers.get('location')).toContain('push-test-sent')
    expect((await hub().listPushDevices()).map(device => device.label)).toEqual(['iPhone Safari（ホーム画面）'])

    // Unsubscribe the phone.
    expect((await owner.browser.postJson('/push/unsubscribe', { endpoint: phoneEndpoint })).status).toBe(200)
    expect(await hub().listPushDevices()).toEqual([])
    const frames: HubFrame[] = back.frames
    expect(frames.some(frame => frame.t === 'ready')).toBe(true)
  })
})
