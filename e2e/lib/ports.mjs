// Port ranges reserved for the harness, so parallel work on the same machine
// (other worktrees, a developer's own DSH on 3080) is never disturbed.
import { createServer } from 'node:net'

export const PORTS = {
  dsh: [4100, 4199],
  mockLlm: [4200, 4299],
  hub: 8788,
}

/** Whether `port` can be bound on `host` right now. */
export function isFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

/** First free port in [from, to] on `host`. */
export async function freePort([from, to], host = '127.0.0.1') {
  for (let port = from; port <= to; port++) {
    if (await isFree(port, host)) return port
  }
  throw new Error(`no free port in ${from}-${to} on ${host}`)
}
