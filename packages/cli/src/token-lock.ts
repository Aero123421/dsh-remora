import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { configDir } from './config.ts'
import type { Ctx } from './ctx.ts'
import { CliError, EXIT } from './errors.ts'

const LOCK_WAIT_MS = 120_000
interface LockOwner { pid: number; host: string; token: string }

function code(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

async function owner(path: string): Promise<LockOwner | null> {
  let text: string
  try {
    text = await readFile(join(path, 'owner.json'), 'utf8')
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    throw error
  }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('Invalid token lock owner') }
  if (!value || typeof value !== 'object') throw new Error('Invalid token lock owner')
  const body = value as Partial<LockOwner>
  if (typeof body.pid !== 'number' || !Number.isSafeInteger(body.pid) || body.pid <= 0 || typeof body.host !== 'string' || typeof body.token !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(body.token)) throw new Error('Invalid token lock owner')
  return { pid: body.pid, host: body.host, token: body.token }
}

function exited(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch (error) { return code(error) === 'ESRCH' }
}

function collision(error: unknown): boolean {
  return ['ENOENT', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM'].includes(code(error) ?? '')
}

/** Retain the old generation so a delayed reaper cannot rename a live replacement over it. */
async function recover(path: string): Promise<void> {
  const previous = await owner(path)
  if (previous === null || previous.host !== hostname() || !exited(previous.pid)) return
  try {
    await rename(path, `${path}.stale-${previous.token}`)
  } catch (error) {
    if (!collision(error)) throw error
  }
}

/** Serialize reading, rotating and saving a hub's tokens, including other CLI processes. */
export async function withTokenLock<T>(ctx: Pick<Ctx, 'env' | 'platform'>, hubUrl: string, run: () => Promise<T>): Promise<T> {
  const dir = configDir(ctx.env, ctx.platform)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const id = createHash('sha256').update(hubUrl).digest('hex').slice(0, 16)
  const path = join(dir, `tokens-${id}.lock`)
  const deadline = Date.now() + LOCK_WAIT_MS
  const body: LockOwner = { pid: process.pid, host: hostname(), token: randomUUID() }
  const candidate = await mkdtemp(`${path}.candidate-`)
  let claimed = false
  try {
    // Publish only a complete, nonempty directory: a crash while preparing
    // leaves a private candidate rather than an ownerless claimed lock.
    const handle = await open(join(candidate, 'owner.json'), 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(body)); await handle.sync() } finally { await handle.close() }
    for (;;) {
      try {
        await rename(candidate, path)
        claimed = true
        break
      } catch (error) {
        if (!collision(error)) throw error
        await recover(path)
        if (Date.now() >= deadline) throw new CliError(`トークンの保存先が使用中です（${path}）。`, EXIT.unavailable, { code: 'token_store_busy' })
        await delay(50)
      }
    }
    return await run()
  } finally {
    await rm(candidate, { recursive: true, force: true })
    if (claimed && (await owner(path))?.token === body.token) {
      // Delete away from the claim path, after the atomic release. A new
      // owner may claim immediately without racing our recursive removal.
      const released = `${path}.released-${body.token}`
      await rename(path, released)
      await rm(released, { recursive: true, force: true })
    }
  }
}
