/**
 * Durable JSON documents for the plugin's own state.
 *
 * DSH's `ctx.storageDomain` validates records with zod schemas that a
 * dependency-free plugin cannot ship, and it has no migrations, so Remora
 * keeps its own small files next to it: `<DSH home>/storages/dsh-remora/`.
 * Every document carries a schema version; older versions are migrated step
 * by step on load, and a file written by a NEWER plugin is refused instead of
 * being silently downgraded.
 *
 * Writes are atomic (same-directory temp file, fsync, rename, directory
 * fsync) and serialized per document, so a crash leaves either the old or the
 * new content, never a torn file. Files are created 0600 inside a 0700
 * directory.
 */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** `$DSH_HOME` > `~/.dsh`, as DSH resolves it (`@deepseek-ai/dsh-home-paths`). */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.DSH_HOME
  const selected = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  if (selected === '~') return homedir()
  if (selected.startsWith('~/') || selected.startsWith('~\\')) return resolve(join(homedir(), selected.slice(2)))
  return resolve(selected)
}

/** Where Remora keeps its files. `dshHomePath` is the function DSH provides as a service, when present. */
export function remoraDataDir(dshHomePath?: (...segments: string[]) => string): string {
  if (typeof dshHomePath === 'function') return dshHomePath('storages', 'dsh-remora')
  return join(resolveDshHome(), 'storages', 'dsh-remora')
}

export class StorageError extends Error {
  readonly code: 'newer-version' | 'malformed'
  constructor(code: 'newer-version' | 'malformed', message: string) {
    super(message)
    this.name = 'StorageError'
    this.code = code
  }
}

/** Durably replace `path` with `data`. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    await fsyncDirectory(dirname(path))
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/**
 * One migration step: receives the document at version `n` and returns it at
 * version `n + 1`. `migrations[0]` upgrades 1 → 2, and so on.
 */
export type Migration = (data: unknown) => unknown

export interface DocumentSpec<T> {
  /** File name inside the data directory. */
  file: string
  /** Current schema version (≥ 1). */
  version: number
  migrations: readonly Migration[]
  initial: () => T
  /** Validate and normalize the migrated data; throw to reject. */
  parse: (data: unknown) => T
}

interface Envelope { version: number; data: unknown }

/**
 * A JSON document with a schema version. `value` is the in-memory copy;
 * `update` applies a change and resolves once it is durable on disk.
 */
export class JsonDocument<T> {
  readonly path: string
  private current: T
  private readonly spec: DocumentSpec<T>
  private queue: Promise<void> = Promise.resolve()

  private constructor(path: string, spec: DocumentSpec<T>, value: T) {
    this.path = path
    this.spec = spec
    this.current = value
  }

  static async open<T>(dir: string, spec: DocumentSpec<T>): Promise<JsonDocument<T>> {
    if (spec.migrations.length !== spec.version - 1) throw new Error(`${spec.file}: expected ${spec.version - 1} migrations`)
    const path = join(dir, spec.file)
    let text: string | undefined
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (text === undefined) return new JsonDocument(path, spec, spec.initial())
    let envelope: Envelope
    try {
      const raw = JSON.parse(text) as Partial<Envelope>
      if (typeof raw !== 'object' || raw === null || typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) throw new Error('missing version')
      envelope = { version: raw.version, data: raw.data }
    } catch (error) {
      throw new StorageError('malformed', `${spec.file}: ${(error as Error).message}`)
    }
    if (envelope.version > spec.version) {
      throw new StorageError('newer-version', `${spec.file} was written by a newer Remora (schema ${envelope.version} > ${spec.version}); update the plugin`)
    }
    let data = envelope.data
    for (let version = envelope.version; version < spec.version; version++) {
      const migrate = spec.migrations[version - 1]
      if (!migrate) throw new Error(`${spec.file}: no migration from ${version}`)
      data = migrate(data)
    }
    let value: T
    try {
      value = spec.parse(data)
    } catch (error) {
      throw new StorageError('malformed', `${spec.file}: ${(error as Error).message}`)
    }
    const document = new JsonDocument(path, spec, value)
    if (envelope.version !== spec.version) await document.write(value)
    return document
  }

  get value(): T {
    return this.current
  }

  /** Apply `change` to the current value and persist it. Resolves after the write is durable. */
  update(change: (current: T) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const next = change(this.current)
      await this.write(next)
      this.current = next
      return next
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Remove the file and return to the initial value. */
  reset(): Promise<void> {
    const run = this.queue.then(async () => {
      await rm(this.path, { force: true })
      this.current = this.spec.initial()
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private write(value: T): Promise<void> {
    return writeAtomic(this.path, `${JSON.stringify({ version: this.spec.version, data: value }, null, 2)}\n`)
  }
}

// Small validation helpers shared by the document specs. -------------------

export function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${what} must be an object`)
  return value as Record<string, unknown>
}

export function stringArray(value: unknown, what: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error(`${what} must be a string array`)
  return [...new Set(value as string[])]
}

export function optionalString(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${what} must be a string`)
  return value
}

export function optionalNumber(value: unknown, what: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what} must be a number`)
  return value
}
