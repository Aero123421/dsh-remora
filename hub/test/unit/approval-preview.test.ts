import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalSignedPayloads } from '../../src/ui/approval-preview.ts'

test('allow and reject previews differ only by answer.approve', () => {
  const params = { hostId: 'host-1', sessionId: 'session-1', attentionId: 'attention-1' }
  const signed = approvalSignedPayloads(params)
  const allow = JSON.parse(signed.allow) as { answer: { approve: boolean } }
  const reject = JSON.parse(signed.reject) as { answer: { approve: boolean } }
  assert.equal(allow.answer.approve, true)
  assert.equal(reject.answer.approve, false)
  const { answer: allowAnswer, ...allowRest } = allow
  const { answer: rejectAnswer, ...rejectRest } = reject
  assert.deepEqual(allowRest, rejectRest)
  assert.deepEqual(allowRest, { operation: 'approval.respond', ...params })
  assert.notEqual(allowAnswer.approve, rejectAnswer.approve)
})
