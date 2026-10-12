/**
 * The hub never trusts a host to say which host it is: every `hostId` field
 * in what a host sends (results and attention events) is overwritten with
 * the id of the Durable Object that received it. Iterative, so no nesting
 * depth can hide a `hostId`; shared or cyclic references are visited once.
 */
export function stampHostId<T>(value: T, hostId: string): T {
  const stack: unknown[] = [value]
  const seen = new Set<object>()
  while (stack.length > 0) {
    const item = stack.pop()
    if (item === null || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    if (Array.isArray(item)) {
      for (const child of item) stack.push(child)
      continue
    }
    const record = item as Record<string, unknown>
    if ('hostId' in record) record.hostId = hostId
    for (const key of Object.keys(record)) if (key !== 'hostId') stack.push(record[key])
  }
  return value
}
