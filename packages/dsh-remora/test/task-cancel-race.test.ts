import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAdapter } from '../src/adapter/index.ts'
import { context, createFake, harness } from './fake-dsh.ts'
import { until } from './helpers.ts'

function setup() {
  const dsh = createFake()
  dsh.addWorkspace('ws-a', '/work/a', 'Project A')
  const h = harness(dsh, { workspaces: ['ws-a'], presets: ['standard'] })
  const adapter = buildAdapter(dsh.ctx(), h.deps)
  return { dsh, adapter, handlers: adapter.handlers as Required<typeof adapter.handlers> }
}

const createNew = (taskId: string) => ({ target: { new: { workspaceId: 'ws-a', agentPreset: 'standard', title: 'Fresh' } }, prompt: 'go', idempotencyKey: taskId })

test('cancel during session create does not prompt, and a retry does not resurrect the task', async () => {
  const { dsh, handlers } = setup()
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const original = dsh.sessionController.create.bind(dsh.sessionController)
  dsh.sessionController.create = async request => {
    dsh.calls.push({ method: 'create-held', args: request })
    await hold
    return original(request)
  }
  const pending = handlers['task.start'](createNew('t-race'), context({ taskId: 't-race' }))
  await until(() => dsh.calls.some(call => call.method === 'create-held'))
  assert.deepEqual(await handlers['task.cancel']({ taskId: 't-race' }, context()), { cancelled: true, how: 'removed-from-queue' })
  release()
  const started = await pending
  assert.equal(started.state, 'cancelled')
  assert.equal(dsh.log.filter(line => line.startsWith('prompt:')).length, 0)
  const created = dsh.calls.find(call => call.method === 'create')
  const sessionId = created && typeof created.args === 'object' && created.args !== null && 'sessionId' in created.args ? String((created.args as { sessionId: unknown }).sessionId) : ''
  assert.notEqual(sessionId, '')
  assert.equal(dsh.sessions.has(sessionId), true)
  const again = await handlers['task.start'](createNew('t-race'), context({ taskId: 't-race' }))
  assert.equal(again.state, 'cancelled')
  assert.equal(dsh.log.filter(line => line.startsWith('prompt:')).length, 0)
})

test('cancel after the session exists and before the prompt does not submit the prompt', async () => {
  const { dsh, handlers } = setup()
  const original = dsh.sessionController.create.bind(dsh.sessionController)
  dsh.sessionController.create = async request => {
    const created = await original(request)
    assert.deepEqual(await handlers['task.cancel']({ taskId: 't-gap' }, context()), { cancelled: true, how: 'removed-from-queue' })
    return created
  }
  const started = await handlers['task.start'](createNew('t-gap'), context({ taskId: 't-gap' }))
  assert.equal(started.state, 'cancelled')
  assert.equal(dsh.log.filter(line => line.startsWith('prompt:')).length, 0)
  assert.equal(dsh.calls.filter(call => call.method === 'create').length, 1)
})

test('a normal new-session start still prompts', async () => {
  const { dsh, handlers } = setup()
  const started = await handlers['task.start'](createNew('t-ok'), context({ taskId: 't-ok' }))
  assert.equal(started.state, 'accepted')
  assert.equal(dsh.log.filter(line => line.startsWith('prompt:')).length, 1)
  assert.deepEqual(await handlers['task.cancel']({ taskId: 't-ok' }, context()), { cancelled: true, how: 'removed-from-queue' })
})
