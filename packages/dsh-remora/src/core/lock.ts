/**
 * Single-instance lock: only one DSH process per data directory may hold the
 * hub connection (the hub would otherwise see two connections with the same
 * key and stop both). A prepared directory is claimed with one atomic rename;
 * dead-owner generations are retained so a late reaper cannot take a new lock.
 */
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

interface LockBody { pid: number; host: string; token: string; at: number }

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class InstanceLock {
  readonly path: string
  private token: string | null = null
  private acquiring: Promise<boolean> | null = null
  private releasing: Promise<void> | null = null

  constructor(dataDir: string, file = 'hub.lock') {
    this.path = join(dataDir, file)
  }

  get held(): boolean {
    return this.token !== null
  }

  /** Whether another live instance still owns the connection. */
  async occupied(): Promise<boolean> {
    const existing = await this.owner()
    return existing !== null && (existing.body.host !== hostname() || alive(existing.body.pid))
  }

  /** Try to take the lock. Returns false while another live process holds it. */
  acquire(): Promise<boolean> {
    if (this.releasing) return this.releasing.then(() => this.acquire())
    if (this.acquiring) return this.acquiring
    const pending = this.claim()
    this.acquiring = pending
    void pending.finally(() => { this.acquiring = null }).catch(() => undefined)
    return pending
  }

  private async owner(): Promise<{ body: LockBody; legacy: boolean } | null> {
    let text: string
    let legacy = false
    try { text = await readFile(join(this.path, 'owner.json'), 'utf8') } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOTDIR') { text = await readFile(this.path, 'utf8'); legacy = true }
      else if (code === 'ENOENT') return null
      else throw error
    }
    let raw: unknown
    try { raw = JSON.parse(text) } catch { throw new Error('Invalid lock owner') }
    if (typeof raw !== 'object' || raw === null) throw new Error('Invalid lock owner')
    const body = raw as Partial<LockBody>
    if (typeof body.pid !== 'number' || !Number.isInteger(body.pid) || body.pid <= 0 || typeof body.host !== 'string' || typeof body.token !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(body.token)) throw new Error('Invalid lock owner')
    return { body: { pid: body.pid, host: body.host, token: body.token, at: typeof body.at === 'number' ? body.at : 0 }, legacy }
  }

  private async claim(): Promise<boolean> {
    if (this.token !== null) return true
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.owner()
      if (existing) {
        if (existing.body.host !== hostname() || alive(existing.body.pid)) return false
        const stale = `${this.path}.stale-${existing.body.token}`
        try {
          if (existing.legacy) {
            // Older Remora used a file. Once moved, the nonempty directory also
            // prevents another stale file reaper from moving a new directory.
            await mkdir(stale, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
            await rename(this.path, join(stale, 'owner.json'))
          } else await rename(this.path, stale)
        } catch (error) {
          if (!['ENOENT', 'EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
        continue
      }
      const body: LockBody = { pid: process.pid, host: hostname(), token: randomUUID(), at: Date.now() }
      const candidate = await mkdtemp(`${this.path}.candidate-`)
      try {
        const handle = await open(join(candidate, 'owner.json'), 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify(body)); await handle.sync() } finally { await handle.close() }
        await rename(candidate, this.path)
        this.token = body.token
        return true
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      } finally {
        await rm(candidate, { recursive: true, force: true })
      }
    }
    return false
  }

  release(): Promise<void> {
    if (this.releasing) return this.releasing
    const pending = this.drop()
    this.releasing = pending
    void pending.finally(() => { this.releasing = null }).catch(() => undefined)
    return pending
  }

  private async drop(): Promise<void> {
    await this.acquiring
    if (this.token === null) return
    const token = this.token
    try {
      const existing = await this.owner()
      if (existing?.body.token === token) {
        const released = `${this.path}.released-${token}`
        await rename(this.path, released)
        await rm(released, { recursive: true, force: true })
      }
      this.token = null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.token = null
      else throw error
    }
  }
}

/** Serialize a short durable mutation across DSH processes sharing a folder. */
export async function withFileLock<T>(dir: string, file: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const lock = new InstanceLock(dir, file)
  const deadline = Date.now() + 10_000
  while (!(await lock.acquire())) {
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring ${file}`)
    await delay(10)
  }
  try { return await run() } finally { await lock.release() }
}
