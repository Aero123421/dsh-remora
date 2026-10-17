import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { SnapshotStore } from '../src/ui/snapshot-store.ts'

interface Snapshot { workspaces: string[] }
interface Pending {
  method: string
  payload: unknown
  signal: AbortSignal
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

function fixture() {
  const requests: Pending[] = []
  const store = new SnapshotStore<Snapshot>(
    (method, payload, signal) => new Promise((resolve, reject) => { requests.push({ method, payload, signal, resolve, reject }) }),
    (value): value is Snapshot => !!value && typeof value === 'object' && 'workspaces' in value,
  )
  const take = (method: string) => {
    const request = requests.shift()
    assert.equal(request?.method, method)
    return request!
  }
  return { store, requests, take }
}

test('a poll begun before a save cannot remove the saved workspace from the next edit', async () => {
  const { store, take } = fixture()
  const release = store.retain()
  take('state').resolve({ workspaces: ['a'] })
  await setImmediate()
  void store.reload()
  const stale = take('state')
  const saving = store.run('settings', { workspaces: ['a', 'b'] })
  assert.equal(stale.signal.aborted, true)
  take('settings').resolve({ workspaces: ['a', 'b'] })
  assert.equal(await saving, true)
  const refresh = take('state')
  stale.resolve({ workspaces: ['a'] }) // Simulate a transport ignoring abort.
  await setImmediate()
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['a', 'b'])

  const next = store.run('settings', { workspaces: [...store.getSnapshot().snapshot!.workspaces, 'c'] })
  const write = take('settings')
  assert.deepEqual(write.payload, { workspaces: ['a', 'b', 'c'] })
  refresh.reject(new Error('old poll disconnected'))
  write.resolve({ workspaces: ['a', 'b', 'c'] })
  assert.equal(await next, true)
  assert.equal(store.getSnapshot().failed, false)
  release()
})

test('polling pauses for writes, deduplicates slow reads, and reconciles non-snapshot replies', async () => {
  const { store, take, requests } = fixture()
  const release = store.retain()
  await store.reload()
  assert.equal(requests.length, 1)
  take('state').resolve({ workspaces: ['a'] })
  await setImmediate()
  const action = store.run('reconnect')
  const write = take('reconnect')
  await store.reload()
  assert.equal(requests.length, 0)
  write.resolve({ ok: true })
  assert.equal(await action, true)
  take('state').resolve({ workspaces: ['b'] })
  await setImmediate()
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['b'])
  release()
})

test('an older action failure cannot replace a later success or clear busy while a write is pending', async () => {
  const { store, take, requests } = fixture()
  const release = store.retain()
  take('state').resolve({ workspaces: [] })
  await setImmediate()
  const first = store.run('settings', { workspaces: ['a'] })
  const firstWrite = take('settings')
  const second = store.run('settings', { workspaces: ['b'] })
  take('settings').resolve({ workspaces: ['b'] })
  assert.equal(await second, true)
  assert.equal(store.getSnapshot().busy, true)
  assert.equal(requests.length, 0)
  firstWrite.reject(new Error('earlier save failed'))
  assert.equal(await first, false)
  assert.equal(store.getSnapshot().busy, false)
  assert.equal(store.getSnapshot().actionError, null)
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['b'])
  assert.equal(take('state').method, 'state')
  release()
})

test('older action successes cannot roll back the current view; final poll reflects actual server order', async () => {
  const { store, take } = fixture()
  const release = store.retain()
  take('state').resolve({ workspaces: [] })
  await setImmediate()
  const first = store.run('settings', { workspaces: ['a'] })
  const firstWrite = take('settings')
  const second = store.run('settings', { workspaces: ['b'] })
  take('settings').resolve({ workspaces: ['b'] })
  await second
  firstWrite.resolve({ workspaces: ['a'] })
  assert.equal(await first, false)
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['b'])
  take('state').resolve({ workspaces: ['a', 'b'] })
  await setImmediate()
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['a', 'b'])
  release()
})

test('unmount/remount ignores the old read and old action without disturbing the new action', async () => {
  const { store, take } = fixture()
  const release = store.retain()
  const oldRead = take('state')
  const oldAction = store.run('settings', { workspaces: ['old'] })
  const oldWrite = take('settings')
  release()
  assert.equal(oldRead.signal.aborted, true)
  assert.equal(oldWrite.signal.aborted, true)
  assert.equal(await store.run('settings'), false)
  const releaseAgain = store.retain()
  take('state').resolve({ workspaces: ['new'] })
  await setImmediate()
  const newAction = store.run('settings', { workspaces: ['new', 'b'] })
  const newWrite = take('settings')
  oldRead.reject(new Error('old connection failed'))
  oldWrite.resolve({ workspaces: ['old'] })
  assert.equal(await oldAction, false)
  assert.equal(store.getSnapshot().busy, true)
  assert.equal(store.getSnapshot().failed, false)
  assert.equal(store.getSnapshot().actionError, null)
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['new'])
  newWrite.resolve({ workspaces: ['new', 'b'] })
  assert.equal(await newAction, true)
  releaseAgain()
})

test('an old action failure after remount cannot surface an error on the new page', async () => {
  const { store, take } = fixture()
  const release = store.retain()
  const read = take('state')
  const oldAction = store.run('settings')
  const write = take('settings')
  release()
  const releaseAgain = store.retain()
  take('state').resolve({ workspaces: ['new'] })
  await setImmediate()
  read.resolve({ workspaces: ['old'] })
  write.reject(new Error('old action failure'))
  assert.equal(await oldAction, false)
  assert.equal(store.getSnapshot().actionError, null)
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['new'])
  releaseAgain()
})

test('settings and sidebar consumers share one request and keep it alive until both unmount', async () => {
  const { store, take, requests } = fixture()
  const releasePage = store.retain()
  const releaseChip = store.retain()
  assert.equal(requests.length, 1)
  const read = take('state')
  releasePage()
  releasePage() // Releasing the same consumer twice must not close the connection.
  assert.equal(read.signal.aborted, false)
  read.resolve({ workspaces: ['a'] })
  await setImmediate()
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['a'])
  releaseChip()
  assert.equal(store.getSnapshot().snapshot, undefined)
})

test('a current read failure is shown and a successful action clears it', async () => {
  const { store, take } = fixture()
  const release = store.retain()
  take('state').reject(new Error('offline'))
  await setImmediate()
  assert.equal(store.getSnapshot().failed, true)
  const failed = store.run('settings')
  const error = new Error('save denied')
  take('settings').reject(error)
  assert.equal(await failed, false)
  assert.equal(store.getSnapshot().actionError, error)
  const staleRead = take('state')
  const saved = store.run('settings')
  take('settings').resolve({ workspaces: ['a'] })
  assert.equal(await saved, true)
  staleRead.reject(new Error('stale failure'))
  await setImmediate()
  assert.equal(store.getSnapshot().failed, false)
  assert.equal(store.getSnapshot().actionError, null)
  release()
})

test('a failed refresh retains the previous view and last-check time until recovery', async () => {
  const { store, take } = fixture()
  const release = store.retain()
  take('state').resolve({ workspaces: ['a'] })
  await setImmediate()
  const checked = store.getSnapshot().lastChecked
  assert.equal(typeof checked, 'number')
  const refreshing = store.reload()
  take('state').reject(new Error('connection lost'))
  await refreshing
  assert.equal(store.getSnapshot().failed, true)
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['a'])
  assert.equal(store.getSnapshot().lastChecked, checked)
  const retry = store.reload()
  take('state').resolve({ workspaces: ['b'] })
  await retry
  assert.equal(store.getSnapshot().failed, false)
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['b'])
  release()
  assert.equal(store.getSnapshot().lastChecked, null)
})

test('a hidden consumer waits for an explicit visibility refresh and preserves generation safety', async () => {
  const { store, take, requests } = fixture()
  const releaseHidden = store.retain(false)
  assert.equal(requests.length, 0)
  const visible = store.reload()
  const oldRead = take('state')
  releaseHidden()
  const releaseVisible = store.retain()
  take('state').resolve({ workspaces: ['current'] })
  await setImmediate()
  oldRead.reject(new Error('hidden page was disconnected'))
  await visible
  assert.equal(store.getSnapshot().failed, false)
  assert.deepEqual(store.getSnapshot().snapshot?.workspaces, ['current'])
  releaseVisible()
})
