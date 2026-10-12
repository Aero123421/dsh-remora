/**
 * Adapter entry point: operations implemented on top of DSH APIs.
 * Owned by the adapter work stream; the core only calls `createAdapter`.
 *
 * Reads never wake a session (list / inspect / projections). Only operations
 * that act on a session resolve its Agent (session.prompt, selectModel,
 * commands, goals, user-question answers, queue edits).
 *
 * The answerer (answerer.ts) joins DSH's question and approval chains so
 * that held requests can be answered with attention.respond / approval.respond.
 */
import type { HostContext } from '../dsh.ts'
import type { AdapterDeps, CreateAdapter, OperationContext, OperationHandlers } from '../ops/types.ts'
import { createActions } from './actions.ts'
import { Answerer } from './answerer.ts'
import { createJobs } from './jobs.ts'
import { createSchedules } from './schedules.ts'
import { createSearch } from './search.ts'
import { createTerminal } from './terminal.ts'
import { createReads } from './reads.ts'
import { Runtime } from './runtime.ts'
import { Tasks } from './tasks.ts'
import { Watcher } from './watcher.ts'
import { createWorkspaceCreate, DEFAULT_CLONE_LIMITS, type CloneLimits } from './workspace-create.ts'

export interface AdapterOptions {
  clone?: Partial<CloneLimits>
}

export function buildAdapter(ctx: HostContext, deps: AdapterDeps, options: AdapterOptions = {}) {
  const rt = new Runtime(ctx, deps)
  const tasks = new Tasks(rt)
  const watcher = new Watcher(rt, tasks)
  const answerer = new Answerer(rt)
  answerer.onChange = sessionId => watcher.schedule(sessionId)
  const reads = createReads(rt)
  const actions = createActions(rt, answerer)
  const workspaces = createWorkspaceCreate(rt, { ...DEFAULT_CLONE_LIMITS, ...options.clone })
  // The core builds the adapter while it initialises, before (and whether or not)
  // the hub link comes up: clones interrupted by a crash or restart are cleaned up
  // here, so their folders do not linger and their records do not stay `cloning`.
  const recovered = workspaces.recover().catch((error: unknown) => deps.logger.warn('Remora: clone recovery failed', error))

  const handlers: OperationHandlers = {
    ...reads,
    ...actions,
    ...createJobs(rt),
    ...createSchedules(rt),
    ...createSearch(rt),
    ...createTerminal(rt),
    ...workspaces.handlers,
    'task.start': (params, context: OperationContext) => tasks.start(params, context),
    'task.get': (params, context) => tasks.get(params, context),
    'task.wait': (params, context) => tasks.wait(params, context),
    'task.steer': (params, context) => tasks.steer(params, context),
    'task.cancel': (params, context) => tasks.cancel(params, context),
    'task.resubmit': (params, context) => tasks.resubmit(params, context),
  }

  return {
    handlers,
    has: (service: string) => ctx.get(service) !== undefined,
    start: () => {
      watcher.start()
      answerer.start()
    },
    settingsChanged: () => answerer.settingsChanged(),
    dispose: () => {
      answerer.dispose()
      watcher.dispose()
      workspaces.dispose()
    },
    /** Internals for tests. */
    recovered,
    runtime: rt,
    tasks,
    watcher,
    answerer,
  }
}

export const createAdapter: CreateAdapter = (ctx, deps) => {
  const { handlers, has, start, settingsChanged, dispose } = buildAdapter(ctx, deps)
  return { handlers, has, start, settingsChanged, dispose }
}
