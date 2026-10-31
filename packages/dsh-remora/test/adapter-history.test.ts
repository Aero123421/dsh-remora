import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAdapter } from '../src/adapter/index.ts'
import type { DshSessionController, DshSessionEvent } from '../src/adapter/dsh-types.ts'
import { OperationError } from '../src/ops/types.ts'
import { context, createFake, harness } from './fake-dsh.ts'

function setup() {
  const dsh = createFake()
  dsh.addWorkspace('ws', '/work')
  dsh.addSession('s', { workspace: 'ws' })
  const h = harness(dsh, { workspaces: ['ws'] })
  const service = dsh.sessionController as DshSessionController
  delete service.inspect
  const adapter = buildAdapter(dsh.ctx(), h.deps)
  return { dsh, service, adapter }
}

const event = (seq: number): DshSessionEvent => ({ seq, time: seq, type: 'turn/start', data: { turn: seq } })

test('0.2.2 history pages pin the first cut and restore chronological order without waking an Agent', async t => {
  const { dsh, service, adapter } = setup()
  t.after(() => adapter.dispose())
  const requests: unknown[] = []
  service.events = async request => {
    requests.push(request)
    return request.beforeSeq === undefined
      ? { cursor: 5, hasMore: true, records: [3, 4, 5].map(seq => ({ type: 'event', event: event(seq) })) }
      : { cursor: 5, hasMore: false, records: [0, 1, 2].map(seq => ({ type: 'event', event: event(seq) })) }
  }
  const events = await adapter.runtime.events('s', context().signal)
  assert.deepEqual(events.map(item => item.seq), [0, 1, 2, 3, 4, 5])
  assert.deepEqual(requests, [
    { address: { kind: 'session', sessionId: 's' }, maxMessages: 1000 },
    { address: { kind: 'session', sessionId: 's' }, throughSeq: 5, beforeSeq: 3, maxMessages: 1000 },
  ])
  assert.equal(dsh.calls.filter(call => call.method === 'resolveAgent').length, 0)
})

test('0.2.2 subagent history uses the durable parent address', async t => {
  const { dsh, service, adapter } = setup()
  t.after(() => adapter.dispose())
  dsh.addSession('child', { origin: 'subagent', parent: 's' })
  await adapter.runtime.catalog(context().signal)
  service.events = async request => {
    assert.deepEqual(request.address, { kind: 'subagent', parentSessionId: 's', childSessionId: 'child', mode: 'unknown' })
    return { cursor: -1, hasMore: false, records: [] }
  }
  assert.deepEqual(await adapter.runtime.events('child', context().signal), [])
})

for (const hasMore of [true, false]) test(`0.2.2 history cancellation rejects a late page (hasMore=${hasMore})`, async t => {
  const { service, adapter } = setup()
  t.after(() => adapter.dispose())
  const abort = new AbortController()
  let calls = 0
  service.events = async (_request, signal) => {
    assert.equal(signal, abort.signal)
    calls++
    abort.abort(new OperationError('unavailable', 'cancelled'))
    return { cursor: 5, hasMore, records: [{ type: 'event', event: event(3) }] }
  }
  await assert.rejects(adapter.runtime.events('s', abort.signal), /cancelled/)
  assert.equal(calls, 1)
})

test('0.2.2 history refuses a non-advancing page and preserves native not-found errors', async t => {
  const { service, adapter } = setup()
  t.after(() => adapter.dispose())
  service.events = async () => ({ cursor: 5, hasMore: true, records: [{ type: 'event', event: event(3) }] })
  await assert.rejects(adapter.runtime.events('s', context().signal), /did not advance/)
  adapter.runtime.markSeen('s')
  service.events = async () => { throw { code: 'session/not-found', message: 'missing' } }
  await assert.rejects(adapter.runtime.events('s', context().signal), { code: 'gone' })
})

test('0.2.2 transcript reads recheck authorization after history resolves', async t => {
  const { service, adapter } = setup()
  t.after(() => adapter.dispose())
  let authorized = true
  service.events = async () => {
    authorized = false
    return { cursor: -1, hasMore: false, records: [] }
  }
  const request = { ...context(), assertAuthorized() { if (!authorized) throw new OperationError('denied', 'revoked') } }
  await assert.rejects(adapter.handlers['session.read']!({ sessionId: 's', depth: 'page' }, request), { code: 'denied' })
})
