// Remora hub service worker: shows Web Push notifications and opens the
// right hub page when one is tapped. Payloads carry no conversation content.
'use strict'

const LABELS = {
  approval: '承認待ち',
  question: 'AI からの質問',
  'plan-review': 'プランの確認',
  'task-completed': 'タスクが完了しました',
  'task-failed': 'タスクが失敗しました',
  'host-offline': 'オフラインになりました',
  'host-online': '再接続しました',
  test: 'Remora のテスト通知',
}

const left = expiresAt => {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return '期限切れ'
  const minutes = Math.ceil(ms / 60000)
  return minutes >= 60 ? `あと ${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分` : `あと ${minutes} 分`
}

const sameOriginPath = url => {
  try {
    const target = new URL(url || '/', self.location.origin)
    return target.origin === self.location.origin ? target.href : self.location.origin + '/'
  } catch {
    return self.location.origin + '/'
  }
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))

self.addEventListener('push', event => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const kind = String(data.kind || 'test')
  const host = String(data.host || '').slice(0, 60)
  const label = LABELS[kind] || 'Remora'
  const title = kind.startsWith('host-') ? `${host} が${label}` : host && kind !== 'test' ? `${label}（${host}）` : label
  const lines = []
  if (data.title) lines.push(String(data.title).slice(0, 80))
  if (typeof data.expiresAt === 'number') lines.push(left(data.expiresAt))
  if (typeof data.count === 'number' && data.count > 1) lines.push(`ほか ${data.count - 1} 件`)
  const attention = kind === 'approval' || kind === 'question' || kind === 'plan-review'
  event.waitUntil(self.registration.showNotification(title, {
    body: lines.join('\n'),
    icon: '/remora-192.png',
    tag: String(data.tag || kind),
    renotify: attention,
    requireInteraction: attention,
    data: { url: sameOriginPath(data.url) },
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = sameOriginPath(event.notification.data && event.notification.data.url)
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue
      await client.focus()
      if ('navigate' in client) await client.navigate(target)
      return
    }
    await self.clients.openWindow(target)
  })())
})
