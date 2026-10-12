/**
 * The hub never trusts a host to say which host it is: every `hostId` field
 * in what a host sends (results and attention events) is overwritten with
 * the id of the Durable Object that received it.
 */
export function stampHostId<T>(value: T, hostId: string, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (const item of value) stampHostId(item, hostId, depth + 1)
    return value
  }
  const record = value as Record<string, unknown>
  if ('hostId' in record) record.hostId = hostId
  for (const key of Object.keys(record)) {
    if (key !== 'hostId') stampHostId(record[key], hostId, depth + 1)
  }
  return value
}
