/**
 * A small in-memory DSH host shaped like the real services the adapter uses
 * (sessionController, workspaceRegistry, agents, userQuestions, goals,
 * commands, workspaceChanges), plus a recording ScopePolicy and TaskStore.
 */
import { spawn as spawnChild } from 'node:child_process'
import type { HostEvent, PlacementInfo } from '@dsh-remora/protocol'
import type { AdapterDeps, OperationContext, ScopePolicy, SessionScopeInput, TaskRecord, TaskStore } from '../src/ops/types.ts'
import type {
  DshAgent, DshProjectionValues, DshSessionEvent, DshSessionHeader, DshWorkspace,
} from '../src/adapter/dsh-types.ts'

export interface FakeSession {
  header: DshSessionHeader
  events: DshSessionEvent[]
  values: DshProjectionValues
  agent?: DshAgent
  inbox: { id: string; content: { type: 'text'; text: string }[]; source: { kind: 'user'; rpcId: string } }[]
}

export class RemoteError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export class FakeDsh {
  sessions = new Map<string, FakeSession>()
  workspaces: DshWorkspace[] = []
  archived: string[] = []
  pinned: string[] = []
  calls: { method: string; args: unknown }[] = []
  listeners = new Map<string, ((...args: any[]) => any)[]>()
  /** Present when a test simulates DSH Web's gateway: whether a DSH Web tab is connected. */
  webConnected: boolean | undefined = undefined
  answers: { callId: string; answer: unknown }[] = []
  activity: string[] = []
  log: string[] = []
  private nextSeq = new Map<string, number>()

  addWorkspace(id: string, path: string, title = id): DshWorkspace {
    const workspace: DshWorkspace = { id, path, title, createdAt: '', updatedAt: '', sessionIds: [] }
    this.workspaces.push(workspace)
    return workspace
  }

  addSession(id: string, options: { workspace?: string; title?: string; updatedAt?: number; origin?: 'subagent'; parent?: string; live?: boolean; values?: DshProjectionValues; cwd?: string } = {}): FakeSession {
    const workspace = this.workspaces.find(w => w.id === options.workspace)
    const header: DshSessionHeader = {
      id,
      createdAt: options.updatedAt ?? 1,
      cwd: options.cwd ?? workspace?.path ?? '/tmp',
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.parent ? { parentSession: options.parent } : {}),
    }
    const session: FakeSession = {
      header,
      events: [],
      values: { title: options.title ?? null, ...options.values },
      inbox: [],
      ...(options.live ? { agent: { id, status: 'idle', session: { id } } } : {}),
    }
    this.sessions.set(id, session)
    if (workspace) (workspace.sessionIds as string[]).push(id)
    return session
  }

  append(sessionId: string, type: string, data: unknown): DshSessionEvent {
    const session = this.sessions.get(sessionId)!
    const seq = this.nextSeq.get(sessionId) ?? 0
    this.nextSeq.set(sessionId, seq + 1)
    const event = { type, seq, time: 1000 + seq, data: data as any }
    session.events.push(event)
    this.fire('session/event', { id: sessionId }, event)
    return event
  }

  fire(name: string, ...args: unknown[]): void {
    for (const listener of [...this.listeners.get(name) ?? []]) listener(...args)
  }

  /** Simulate the agent loop taking the next queued prompt through one turn. */
  runTurn(sessionId: string, options: { reply?: string; end?: unknown; leaveOpen?: boolean; beforeEnd?: (turn: number) => void } = {}): number {
    const session = this.sessions.get(sessionId)!
    const message = session.inbox.shift()
    this.syncInbox(session)
    const turn = session.events.filter(e => e.type === 'turn/start').length + 1
    if (session.agent) session.agent.status = 'running'
    this.fire('api-session/status', sessionId, true)
    this.append(sessionId, 'turn/start', { turn })
    if (message) this.append(sessionId, 'user/message', { id: message.id, content: message.content, source: message.source })
    this.append(sessionId, 'assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: options.reply ?? 'done' }] } })
    options.beforeEnd?.(turn)
    if (options.leaveOpen) return turn
    this.endTurn(sessionId, turn, options.end)
    return turn
  }

  endTurn(sessionId: string, turn: number, reason: unknown = { kind: 'completed' }): void {
    const session = this.sessions.get(sessionId)!
    this.append(sessionId, 'turn/end', { turn, reason })
    if (session.agent) session.agent.status = 'idle'
    this.fire('api-session/status', sessionId, false)
  }

  syncInbox(session: FakeSession): void {
    session.values = { ...session.values, inbox: { 'next-turn': session.inbox as any, 'next-step': [] } }
  }

  private session(id: string): FakeSession {
    const session = this.sessions.get(id)
    if (!session) throw new RemoteError('session/not-found', `session "${id}" not found`)
    return session
  }

  private wake(id: string): DshAgent {
    const session = this.session(id)
    if (session.header.origin === 'subagent') throw new RemoteError('session/agent-busy', 'subagent')
    if (!session.agent) {
      this.calls.push({ method: 'wake', args: id })
      session.agent = { id, status: 'idle', session: { id } }
    }
    return session.agent
  }

  readonly sessionController = {
    list: async () => ({
      items: [...this.sessions.values()].map(s => ({
        sessionId: s.header.id,
        agentAvailable: s.agent !== undefined,
        updatedAt: s.header.createdAt,
        running: s.agent?.status === 'running',
        blank: s.events.length === 0,
        ...(s.header.parentSession ? { parentSessionId: s.header.parentSession } : {}),
        ...(s.header.origin ? { origin: s.header.origin } : {}),
        ...(s.header.cwd ? { cwd: s.header.cwd } : {}),
        projections: { kind: 'cached' as const, asOfSeq: 0, values: s.values },
      })),
    }),
    inspect: async (id: string) => {
      this.calls.push({ method: 'inspect', args: id })
      const s = this.sessions.get(id)
      if (!s) throw new Error(`session "${id}" not found`)
      return { meta: s.header, inheritedEventCount: 0, events: [...s.events] }
    },
    projections: async ({ sessionId }: { sessionId: string }) => {
      const s = this.sessions.get(sessionId)
      return s ? { kind: 'sequenced' as const, asOfSeq: s.events.length - 1, values: s.values } : null
    },
    create: async (request: { workspaceId?: string; sessionId?: string; agentPreset?: string }) => {
      this.calls.push({ method: 'create', args: request })
      const id = request.sessionId ?? `session-${this.sessions.size + 1}`
      if (!this.sessions.has(id)) this.addSession(id, { ...(request.workspaceId ? { workspace: request.workspaceId } : {}), live: true, values: { agentPreset: request.agentPreset ?? 'standard' } })
      return { sessionId: id }
    },
    rename: async ({ sessionId, title }: { sessionId: string; title: string }) => {
      this.calls.push({ method: 'rename', args: { sessionId, title } })
      this.session(sessionId).values.title = title
      return { title, seq: 0 }
    },
    prompt: async (request: { requestId: string; sessionId: string; mode: string; content: { type: 'text'; text: string }[] }) => {
      this.log.push(`prompt:${request.requestId}`)
      this.calls.push({ method: 'prompt', args: request })
      const session = this.session(request.sessionId)
      this.wake(request.sessionId)
      const seen = session.inbox.some(m => m.source.rpcId === request.requestId)
        || session.events.some(e => e.type === 'user/message' && e.data?.source?.rpcId === request.requestId)
      if (!seen) {
        session.inbox.push({ id: `msg-${request.requestId}`, content: request.content, source: { kind: 'user', rpcId: request.requestId } })
        this.syncInbox(session)
      }
      return { accepted: true as const }
    },
    updateQueue: async (request: { sessionId: string; itemId: string; action: { kind: string } }) => {
      this.calls.push({ method: 'updateQueue', args: request })
      const session = this.session(request.sessionId)
      session.inbox = session.inbox.filter(m => m.id !== request.itemId)
      this.syncInbox(session)
      return { accepted: true as const }
    },
    cancel: (request: { sessionId: string }) => {
      this.calls.push({ method: 'cancel', args: request })
      return { accepted: true as const }
    },
    selectModel: async (request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }) => {
      this.calls.push({ method: 'selectModel', args: request })
      this.wake(request.sessionId)
      return { selected: { provider: request.provider, model: request.model, ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}) } }
    },
    modelCatalog: async () => ({
      default: { provider: 'deepseek', model: 'deepseek-chat' },
      routableProviders: ['deepseek'],
      groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
      ] }],
      failures: [],
    }),
    fork: async (request: { sessionId: string; atSeq?: number }) => {
      this.calls.push({ method: 'fork', args: request })
      const source = this.session(request.sessionId)
      const id = `${request.sessionId}-fork-${this.sessions.size}`
      const workspace = this.workspaces.find(w => w.sessionIds.includes(request.sessionId))
      const copy = this.addSession(id, { ...(workspace ? { workspace: workspace.id } : {}), live: true, title: `${source.values.title ?? ''} (fork)` })
      copy.events = source.events.filter(event => request.atSeq === undefined || event.seq <= request.atSeq).map(event => ({ ...event }))
      return { sessionId: id }
    },
    resolveAgent: async (id: string) => {
      this.calls.push({ method: 'resolveAgent', args: id })
      try {
        return { agent: this.wake(id) }
      } catch (error) {
        return { error: error as RemoteError }
      }
    },
  }

  readonly workspaceRegistry = ((self: FakeDsh) => ({
    list: () => self.workspaces,
    get: (id: string) => self.workspaces.find(w => w.id === id),
    create: async (path: string) => self.addWorkspace(`ws-${self.workspaces.length + 1}`, path),
    resolveByPath: async (path: string) => self.workspaces.find(w => w.path === path),
    delete: async (id: string) => { const before = self.workspaces.length; self.workspaces = self.workspaces.filter(w => w.id !== id); return self.workspaces.length < before },
    get archivedSessionIds() { return self.archived },
    get pinnedSessionIds() { return self.pinned },
  }))(this)

  readonly agents = { get: (id: string) => this.sessions.get(id)?.agent }

  readonly userQuestions = {
    answer: (_agent: DshAgent, callId: string, answer: unknown) => {
      this.answers.push({ callId, answer })
      return true
    },
  }

  /** Background jobs: id → view + output. */
  jobList: { id: string; kind: string; label: string; owner?: string; status: string; output: string }[] = []

  readonly jobs = ((self: FakeDsh) => ({
    visible(id: string, caller?: string) {
      const job = self.jobList.find(item => item.id === id)
      if (!job || (job.owner !== undefined && job.owner !== caller)) throw new Error(`job ${id} not found`)
      return job
    },
    view(job: { id: string; kind: string; label: string; owner?: string; status: string; output: string }) {
      return { id: job.id, kind: job.kind, label: job.label, ...(job.owner ? { owner: job.owner } : {}), status: job.status, output: { total: job.output.length, earliest: 0 } }
    },
    get(id: string, caller?: string) { return this.view(this.visible(id, caller)) },
    readAt(id: string, from: number, caller?: string) {
      const job = this.visible(id, caller)
      return { chunks: [{ at: from, text: job.output.slice(from) }], next: job.output.length, lossy: false }
    },
    list(caller?: string) { return self.jobList.filter(job => job.owner === undefined || job.owner === caller).map(job => this.view(job)) },
    kill(id: string, caller?: string, reason?: string) {
      const job = this.visible(id, caller)
      self.calls.push({ method: 'kill', args: { id, caller, reason } })
      if (job.status !== 'running') return 'already-finished' as const
      job.status = 'killed'
      return 'requested' as const
    },
  }))(this)

  /** Automation tasks. */
  scheduleRows: { id: string; sessionId: string; status: 'active' | 'inactive'; record: any }[] = []
  readonly schedule = ((self: FakeDsh) => ({
    async create(sessionId: string, request: any) {
      self.calls.push({ method: 'schedule.create', args: { sessionId, request } })
      if (request.title.trim() === '') throw Object.assign(new Error('A task name is required.'), { name: 'ScheduleInputError', code: 'invalid_prompt' })
      const id = `schedule-${self.scheduleRows.length + 1}`
      const base = { id, title: request.title, prompt: request.prompt, scheduledAt: '2026-10-13T00:00:00.000Z' }
      const record = request.daily ? { ...base, kind: 'daily', time: request.daily.time, timeZone: request.daily.time_zone }
        : request.cron ? { ...base, kind: 'cron', expression: request.cron.expression, timeZone: request.cron.time_zone }
          : request.every_seconds ? { ...base, kind: 'every', everySeconds: request.every_seconds }
            : request.weekly ? { ...base, kind: 'weekly', time: request.weekly.time, timeZone: request.weekly.time_zone, weekdays: request.weekly.weekdays }
              : request.at ? { ...base, kind: 'at' } : { ...base, kind: 'after', afterSeconds: request.after_seconds }
      self.scheduleRows.push({ id, sessionId, status: 'active', record })
      return record
    },
    async catalog() { return self.scheduleRows.map(row => ({ ...row.record, sessionId: row.sessionId, status: row.status })) },
    async delete(request: { sessionId: string; id: string }) {
      const before = self.scheduleRows.length
      self.scheduleRows = self.scheduleRows.filter(row => !(row.id === request.id && row.sessionId === request.sessionId))
      if (self.scheduleRows.length === before) return { id: request.id, deleted: false as const, code: 'schedule_not_found' }
      self.fire('domain/changed', { domain: 'schedule', table: 'tasks', operation: 'deleted', key: request.id })
      return { id: request.id, deleted: true as const }
    },
  }))(this)

  /** Runs real commands with /bin/sh, like DSH's local subprocess provider. */
  readonly subprocess = {
    terminalEnvironment: async () => ({ platform: 'posix' as const, defaultShell: '/bin/sh' }),
    resolveExecutable: async (command: string) => command,
    spawn: (spec: { argv: readonly string[]; cwd: string; signal?: AbortSignal; stdio: { stdout: { maxBytes: number }; stderr: { maxBytes: number } } }) => {
      this.calls.push({ method: 'spawn', args: { argv: spec.argv, cwd: spec.cwd } })
      let stdout = ''
      let stderr = ''
      // Its own process group, terminated as a whole like DSH's managed range.
      const child = spawnChild(spec.argv[0]!, spec.argv.slice(1), { cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      const killGroup = () => { try { process.kill(-child.pid!, 'SIGTERM') } catch { /* gone */ } }
      if (spec.signal?.aborted) killGroup()
      else spec.signal?.addEventListener('abort', killGroup, { once: true })
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      const done = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => {
        child.on('error', () => {})
        child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
      })
      const reader = (get: () => string, max: number) => ({ readFrom: (from: number) => ({ text: get().slice(-max).slice(from), nextOffset: get().length, lossy: get().length > max }) })
      return { collected: { stdout: reader(() => stdout, spec.stdio.stdout.maxBytes), stderr: reader(() => stderr, spec.stdio.stderr.maxBytes) }, done, terminate: killGroup }
    },
  }

  readonly commands = {
    execute: async (_agent: DshAgent, line: string) => {
      this.calls.push({ method: 'command', args: line })
      if (!line.startsWith('/compact')) return undefined
      return { commandId: 'c1', result: { kind: 'success' as const, text: 'compacted OPENAI_API_KEY=abcdefgh1234' } }
    },
  }

  readonly sessionSkillCatalog = {
    list: async () => ({ skills: [
      { name: 'review', description: 'Review code', path: '/home/u/.agents/skills/review/SKILL.md' },
      { name: 'deploy', description: 'Deploy', path: '/work/a/.dsh/skills/deploy/SKILL.md' },
    ] }),
  }

  ctx(): any {
    const self = this
    const services: Record<string, unknown> = {
      sessionController: this.sessionController,
      workspaceRegistry: this.workspaceRegistry,
      agents: this.agents,
      userQuestions: this.userQuestions,
      commands: this.commands,
      sessionSkillCatalog: this.sessionSkillCatalog,
      jobs: this.jobs,
      schedule: this.schedule,
      subprocess: this.subprocess,
    }
    return {
      connection: { fetch: { register: () => undefined } },
      get: (name: string) => name === 'typertGateway'
        ? (self.webConnected === undefined ? undefined : { hasLiveClient: () => self.webConnected })
        : services[name],
      effect: () => undefined,
      logger: { info: () => undefined, warn: () => undefined },
      on: (name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }) => {
        const list = this.listeners.get(name) ?? []
        if (options?.prepend) list.unshift(listener)
        else list.push(listener)
        this.listeners.set(name, list)
        return () => {
          const index = list.indexOf(listener)
          if (index >= 0) list.splice(index, 1)
        }
      },
      waterfall: async (name: string, request: { sessionId: string }) => {
        if (name !== 'workspace/session-activity') return []
        return this.activity.includes(request.sessionId) ? [{ kind: 'job', items: [{ id: 'job-1' }] }] : []
      },
    }
  }
}

/**
 * Dispatch a Cordis waterfall through the listeners registered for `name`, in
 * order, ending in `fallback` (DSH's own `noAnswerer` / `'unavailable'`).
 */
export function waterfall<T>(dsh: FakeDsh, name: string, request: unknown, fallback: () => Promise<T>): Promise<T> {
  const chain = [...dsh.listeners.get(name) ?? []]
  const next = (): Promise<T> => {
    const listener = chain.shift()
    return listener ? Promise.resolve(listener(request, next)) : fallback()
  }
  return next()
}

export function createFake(): FakeDsh {
  return new FakeDsh()
}

export class MemoryTasks implements TaskStore {
  records = new Map<string, TaskRecord>()
  private readonly log: string[]
  constructor(log: string[]) {
    this.log = log
  }
  get(taskId: string) { return this.records.get(taskId) }
  list() { return [...this.records.values()] }
  async put(record: TaskRecord) {
    this.log.push(`put:${record.taskId}:${record.state}`)
    this.records.set(record.taskId, { ...record })
  }
}

export interface ScopeOptions {
  workspaces?: string[] | 'all'
  outside?: boolean
  skills?: string[]
  presets?: string[]
  commands?: string[]
  aliases?: Record<string, string>
  placements?: PlacementInfo[]
  gitHosts?: string[]
  untrusted?: string[]
}

export function scopePolicy(options: ScopeOptions = {}): ScopePolicy & { marked: string[] } {
  const untrusted = new Set(options.untrusted ?? [])
  const marked: string[] = []
  const canWorkspace = (id: string | null) => id === null ? options.outside === true : options.workspaces === undefined || options.workspaces === 'all' || options.workspaces.includes(id)
  return {
    marked,
    canAccessWorkspace: id => canWorkspace(id),
    canAccessSession: (input: SessionScopeInput) => canWorkspace(input.workspaceId),
    placements: () => options.placements ?? [],
    isAllowedSkill: name => (options.skills ?? []).includes(name),
    isAllowedAgentPreset: name => (options.presets ?? ['standard']).includes(name),
    isAllowedCommand: name => (options.commands ?? ['/compact']).includes(name),
    aliases: () => options.aliases ?? {},
    gitHosts: () => options.gitHosts ?? ['github.com'],
    isUntrustedWorkspace: id => untrusted.has(id),
    markUntrustedWorkspace: async (id) => { untrusted.add(id); marked.push(id) },
  }
}

export function harness(fakeDsh: FakeDsh, scope: ScopeOptions = {}) {
  const events: HostEvent[] = []
  const tasks = new MemoryTasks(fakeDsh.log)
  const policy = scopePolicy(scope)
  const deps: AdapterDeps = {
    scope: policy,
    tasks,
    emit: event => { events.push(event) },
    logger: { info: () => undefined, warn: () => undefined },
  }
  return { deps, events, tasks, policy }
}

let requestCounter = 0
export function context(options: { taskId?: string; content?: boolean; clientId?: string; scopes?: string[]; fullAccess?: boolean } = {}): OperationContext {
  return {
    actor: { clientId: options.clientId ?? 'client-1', clientName: 'Test' },
    requestId: `req-${++requestCounter}`,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    scopes: options.scopes ?? (options.content === false ? ['dsh.read', 'dsh.tasks'] : ['dsh.read', 'dsh.content', 'dsh.tasks']),
    fullAccess: options.fullAccess ?? false,
    signal: new AbortController().signal,
  }
}
