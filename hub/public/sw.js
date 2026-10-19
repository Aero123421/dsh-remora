// Remora hub service worker: shows Web Push notifications and opens the
// right hub page when one is tapped. Payloads carry no conversation content,
// only codes; the text is chosen here in the device's language (the hub
// stores the page language with each subscription).
'use strict'

const TEXT = {
  en: {
    kinds: {
      approval: 'Approval needed',
      question: 'Question from the agent',
      'plan-review': 'Plan to review',
      confirmation: 'Passkey confirmation needed',
      'task-completed': 'Task completed',
      'task-failed': 'Task failed',
      'host-offline': 'went offline',
      'host-online': 'is back online',
      test: 'Remora test notification',
    },
    ops: { 'terminal.run': 'Run a terminal command', 'host.rotate-key': 'Rotate host key', 'audit.export': 'Export audit log', 'hub.export': 'Export hub settings' },
    test: 'If you can read this, notifications work.',
    expired: 'Expired',
    hours: (h, m) => `${h} h ${m} min left`,
    minutes: m => `${m} min left`,
    more: n => `and ${n} more`,
    hostEvent: (host, label) => `${host} ${label}`,
    titled: (label, host) => `${label} · ${host}`,
  },
  ja: {
    kinds: {
      approval: '承認待ち',
      question: 'AI からの質問',
      'plan-review': 'プランの確認',
      confirmation: 'パスキーでの確認待ち',
      'task-completed': 'タスクが完了しました',
      'task-failed': 'タスクが失敗しました',
      'host-offline': 'がオフラインになりました',
      'host-online': 'が再接続しました',
      test: 'Remora のテスト通知',
    },
    ops: { 'terminal.run': 'ターミナルでコマンドを実行', 'host.rotate-key': 'ホスト鍵の更新', 'audit.export': '監査ログの書き出し', 'hub.export': 'ハブ設定の書き出し' },
    test: 'これが読めていれば、通知は届いています。',
    expired: '期限切れ',
    hours: (h, m) => `あと ${h} 時間 ${m} 分`,
    minutes: m => `あと ${m} 分`,
    more: n => `ほか ${n} 件`,
    hostEvent: (host, label) => `${host} ${label}`,
    titled: (label, host) => `${label}（${host}）`,
  },
  zh: {
    kinds: {
      approval: '需要审批',
      question: '智能体提问',
      'plan-review': '需要审阅计划',
      confirmation: '需要通行密钥确认',
      'task-completed': '任务已完成',
      'task-failed': '任务失败',
      'host-offline': '已离线',
      'host-online': '已重新连接',
      test: 'Remora 测试通知',
    },
    ops: { 'terminal.run': '运行终端命令', 'host.rotate-key': '轮换主机密钥', 'audit.export': '导出审计日志', 'hub.export': '导出中枢设置' },
    test: '能看到这条消息，说明通知已送达。',
    expired: '已过期',
    hours: (h, m) => `剩余 ${h} 小时 ${m} 分`,
    minutes: m => `剩余 ${m} 分钟`,
    more: n => `另有 ${n} 条`,
    hostEvent: (host, label) => `${host} ${label}`,
    titled: (label, host) => `${label}（${host}）`,
  },
}

const pick = lang => {
  const base = String(lang || (self.navigator && self.navigator.language) || 'en').toLowerCase().split('-')[0]
  return TEXT[base] || TEXT.en
}

const left = (text, expiresAt) => {
  const ms = expiresAt - Date.now()
  if (ms <= 0) return text.expired
  const minutes = Math.ceil(ms / 60000)
  return minutes >= 60 ? text.hours(Math.floor(minutes / 60), minutes % 60) : text.minutes(minutes)
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
  const text = pick(data.lang)
  const kind = String(data.kind || 'test')
  const host = String(data.host || '').slice(0, 60)
  const label = text.kinds[kind] || 'Remora'
  const title = kind.startsWith('host-') ? text.hostEvent(host, label) : host && kind !== 'test' ? text.titled(label, host) : label
  const lines = []
  if (kind === 'test') lines.push(text.test)
  if (data.op) lines.push(text.ops[String(data.op)] || String(data.op))
  if (data.title) lines.push(String(data.title).slice(0, 80))
  if (typeof data.expiresAt === 'number') lines.push(left(text, data.expiresAt))
  if (typeof data.count === 'number' && data.count > 1) lines.push(text.more(data.count - 1))
  const attention = kind === 'approval' || kind === 'question' || kind === 'plan-review' || kind === 'confirmation'
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
