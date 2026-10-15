import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { runOperation, type Caller } from '../../src/ops.ts'
import type { AttentionItem, StatusResult } from '../../src/vendor/protocol/index.ts'
import { FakeHost, eventually, setupOwner } from './helpers.ts'

const caller: Caller = { clientId: 'attention-reader', clientName: 'Attention', kind: 'client', scopes: ['dsh.read', 'dsh.content', 'dsh.tasks'] }

function item(sessionId: string, attentionId: string, title: string): AttentionItem {
  return { attentionId, hostId: '', sessionId, kind: 'question', title, answerable: false, answerVia: 'dsh-web' }
}

describe('attention snapshot', () => {
  it('replaces the table on snapshot and leaves it alone when a frame has no snapshot', async () => {
    const owner = await setupOwner()
    const host = await FakeHost.create()
    await host.pair(owner)
    await env.HUB.get(env.HUB.idFromName('hub')).upsertClient({ clientId: caller.clientId, name: caller.clientName, kind: 'cimd', domain: null, redirectHost: null })
    await env.HUB.get(env.HUB.idFromName('hub')).setGrant(caller.clientId, host.hostId, 'request', 'request')
    await host.connect()
    await host.next('ready')
    const stub = env.HOST.get(env.HOST.idFromName(host.hostId))
    host.sendEvent([
      { kind: 'attention', sessionId: 's', items: [item('s', 'a', 'Keep')] },
      { kind: 'attention', sessionId: 't', items: [item('t', 'b', 'Drop')] },
    ])
    await eventually(async () => expect((await stub.summary()).attention.map(entry => entry.title).sort()).toEqual(['Drop', 'Keep']))
    host.sendEvent([{ kind: 'host-status', ceiling: { level: 'request' }, killSwitch: false, operations: ['task.get'] }])
    await eventually(async () => expect((await stub.summary()).attention.map(entry => entry.sessionId).sort()).toEqual(['s', 't']))
    host.sendEvent([{ kind: 'attention-snapshot', sessions: [{ sessionId: 's', items: [item('s', 'a', 'Keep')] }] }])
    await eventually(async () => expect((await stub.summary()).attention.map(entry => entry.sessionId)).toEqual(['s']))
    const status = await runOperation(env, caller, 'status', {})
    expect(status.ok).toBe(true)
    if (status.ok) expect((status.result as StatusResult).attention.map(entry => entry.sessionId)).toEqual(['s'])
    host.socket?.close(1000, 'done')
  })
})
