/**
 * The two payloads a passkey may sign for one approval. Allow and reject differ
 * only in `answer.approve`. The page shows both; the clicked button selects one
 * (`public/js/webauthn.js`).
 */
export function approvalSignedPayloads(params: { hostId: string; sessionId: string; attentionId: string }): { allow: string; reject: string } {
  const base = { operation: 'approval.respond', ...params }
  return {
    allow: JSON.stringify({ ...base, answer: { approve: true } }, null, 2),
    reject: JSON.stringify({ ...base, answer: { approve: false } }, null, 2),
  }
}
