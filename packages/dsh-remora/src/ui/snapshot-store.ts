/** One connection's settings state, shared by polling and all settings actions. */
export interface SnapshotView<S> {
  snapshot: S | undefined
  failed: boolean
  lastChecked: number | null
  busy: boolean
  actionError: unknown
}

type Request = (method: string, payload: unknown, signal: AbortSignal) => Promise<unknown>

export class SnapshotStore<S> {
  #request: Request
  #isSnapshot: (value: unknown) => value is S
  #view: SnapshotView<S> = { snapshot: undefined, failed: false, lastChecked: null, busy: false, actionError: null }
  #listeners = new Set<() => void>()
  #users = 0
  #generation = 0
  #action = 0
  #pending = 0
  #read: AbortController | undefined
  #writes = new Set<AbortController>()

  constructor(request: Request, isSnapshot: (value: unknown) => value is S) {
    this.#request = request
    this.#isSnapshot = isSnapshot
  }

  getSnapshot = (): SnapshotView<S> => this.#view

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #publish(patch: Partial<SnapshotView<S>>): void {
    this.#view = { ...this.#view, ...patch }
    for (const listener of this.#listeners) listener()
  }

  /** The last consumer invalidates even transports that ignore cancellation. */
  retain = (refresh = true): (() => void) => {
    ++this.#users
    if (refresh) void this.reload()
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.#users !== 0) return
      ++this.#generation
      this.#read?.abort()
      this.#read = undefined
      for (const write of this.#writes) write.abort()
      this.#writes.clear()
      this.#pending = 0
      this.#publish({ snapshot: undefined, failed: false, lastChecked: null, busy: false, actionError: null })
    }
  }

  reload = async (): Promise<void> => {
    // Keep one poll in flight; slow connections must not accumulate requests.
    if (this.#users === 0 || this.#pending > 0 || this.#read) return
    const read = new AbortController()
    this.#read = read
    const generation = this.#generation
    const current = () => this.#generation === generation && this.#read === read
    try {
      const value = await this.#request('state', {}, read.signal)
      if (current()) {
        if (!this.#isSnapshot(value)) throw new Error('invalid snapshot')
        this.#publish({ snapshot: value, failed: false, lastChecked: Date.now() })
      }
    } catch {
      if (current()) this.#publish({ failed: true })
    } finally {
      if (current()) this.#read = undefined
    }
  }

  run = async (method: string, payload: unknown = {}): Promise<boolean> => {
    if (this.#users === 0) return false
    const generation = this.#generation
    const action = ++this.#action
    const write = new AbortController()
    this.#writes.add(write)
    ++this.#pending
    // A poll started before this write can never replace its result or error.
    this.#read?.abort()
    this.#read = undefined
    this.#publish({ busy: true, actionError: null })
    const current = () => this.#generation === generation && this.#action === action
    try {
      const value = await this.#request(method, payload, write.signal)
      if (!current()) return false
      if (this.#isSnapshot(value)) this.#publish({ snapshot: value, failed: false, lastChecked: Date.now() })
      return true
    } catch (error) {
      if (current()) this.#publish({ actionError: error })
      return false
    } finally {
      this.#writes.delete(write)
      if (this.#generation === generation) {
        --this.#pending
        this.#publish({ busy: this.#pending > 0 })
        // Also reconcile overlapping writes and actions without a snapshot reply.
        if (this.#pending === 0) void this.reload()
      }
    }
  }
}
