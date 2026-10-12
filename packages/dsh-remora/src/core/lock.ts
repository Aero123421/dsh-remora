/**
 * Single-instance lock: only one DSH process per data directory may hold the
 * hub connection (the hub would otherwise see two connections with the same
 * key and stop both). The lock is a file created with O_EXCL that holds the
 * owner's pid and hostname; a lock whose process is gone is taken over.
 */
import { open, readFile, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Lock files held by plugin instances in this process (a reload can overlap the old instance). */
const heldInProcess = new Set<string>()

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

  constructor(dataDir: string) {
    this.path = join(dataDir, 'hub.lock')
  }

  get held(): boolean {
    return this.token !== null
  }

  /** Try to take the lock. Returns false while another live process holds it. */
  async acquire(): Promise<boolean> {
    if (this.token !== null) return true
    for (let attempt = 0; attempt < 2; attempt++) {
      const body: LockBody = { pid: process.pid, host: hostname(), token: randomUUID(), at: Date.now() }
      try {
        const handle = await open(this.path, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify(body)) } finally { await handle.close() }
        this.token = body.token
        heldInProcess.add(this.path)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      let existing: LockBody | null = null
      try { existing = JSON.parse(await readFile(this.path, 'utf8')) as LockBody } catch { existing = null }
      // A lock from another machine (shared folder) is never broken automatically.
      if (existing && (existing.host !== hostname() || (existing.pid === process.pid ? heldInProcess.has(this.path) : alive(existing.pid)))) return false
      await rm(this.path, { force: true })
    }
    return false
  }

  async release(): Promise<void> {
    if (this.token === null) return
    const token = this.token
    this.token = null
    heldInProcess.delete(this.path)
    try {
      const existing = JSON.parse(await readFile(this.path, 'utf8')) as LockBody
      if (existing.token === token) await rm(this.path, { force: true })
    } catch { /* already gone: nothing to release */ }
  }
}
