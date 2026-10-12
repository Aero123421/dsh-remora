/**
 * Adapter entry point: operations implemented on top of DSH APIs.
 * Owned by the adapter work stream; the core only calls `createAdapter`.
 *
 * Reads never wake a session (list / inspect / projections). Only operations
 * that act on a session resolve its Agent (session.prompt, selectModel,
 * commands, goals, user-question answers, queue edits).
 */
import type { HostContext } from '../dsh.ts'
import type { AdapterDeps, CreateAdapter, OperationContext, OperationHandlers } from '../ops/types.ts'
import { createActions } from './actions.ts'
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
  const reads = createReads(rt)
  const actions = createActions(rt)
  const workspaces = createWorkspaceCreate(rt, { ...DEFAULT_CLONE_LIMITS, ...options.clone })

  const handlers: OperationHandlers = {
    ...reads,
    ...actions,
    ...workspaces.handlers,
    'task.start': (params, context: OperationContext) => tasks.start(params, context),
    'task.get': (params, context) => tasks.get(params, context),
    'task.wait': (params, context) => tasks.wait(params, context),
    'task.steer': (params, context) => tasks.steer(params, context),
    'task.cancel': (params, context) => tasks.cancel(params, context),
    'task.resubmit': (params, context) => tasks.resubmit(params, context),
    // Not implemented (no clean DSH API at 0.2.1-alpha.2): approval.respond, terminal.run, job.stop, schedule.manage.
  }

  return {
    handlers,
    has: (service: string) => ctx.get(service) !== undefined,
    start: () => {
      watcher.start()
      void workspaces.recover()
    },
    dispose: () => {
      watcher.dispose()
      workspaces.dispose()
    },
    /** Internals for tests. */
    runtime: rt,
    tasks,
    watcher,
  }
}

export const createAdapter: CreateAdapter = (ctx, deps) => {
  const { handlers, has, start, dispose } = buildAdapter(ctx, deps)
  return { handlers, has, start, dispose }
}
