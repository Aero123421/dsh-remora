/**
 * Background jobs (long-running commands the agent started): output, the
 * list on session.get, and stopping one. DSH fences jobs by their owning
 * session, so every call names the owner as `caller`.
 */
import type { JobInfo, OperationParams, OperationResults } from '@dsh-remora/protocol'
import type { OperationContext } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redactLine, redactTruncate } from '../redact.ts'
import type { DshJobs, DshJobView } from './dsh-types.ts'
import { SERVICES } from './dsh-types.ts'
import { denied, fromDsh, notFound, unavailable } from './errors.ts'
import { hasContent, type Runtime } from './runtime.ts'

type Params<Op extends keyof OperationParams> = OperationParams[Op]
type Result<Op extends keyof OperationResults> = OperationResults[Op]

/** Jobs a session owns, for session.get. Never throws (an absent service lists nothing). */
export function jobsOf(rt: Runtime, sessionId: string): JobInfo[] {
  const jobs = rt.get<DshJobs>(SERVICES.jobs)
  if (!jobs || typeof jobs.list !== 'function') return []
  try {
    return jobs.list(sessionId)
      .filter(view => view.owner === sessionId)
      .slice(-50)
      .map(view => ({ jobId: view.id, kind: view.kind, label: redactLine(view.label, 300), status: view.status }))
  } catch {
    return []
  }
}

export function createJobs(rt: Runtime) {
  function service(): DshJobs {
    const jobs = rt.get<DshJobs>(SERVICES.jobs)
    if (!jobs) throw unavailable('DSH background jobs are not available')
    return jobs
  }

  /** The job and the session that owns it, when the caller may reach that session. */
  async function locate(jobId: string, signal: AbortSignal): Promise<{ jobs: DshJobs; view: DshJobView; owner: string | undefined }> {
    const jobs = service()
    const rows = await rt.catalog(signal)
    let owner: string | undefined
    let view: DshJobView | undefined
    for (const candidate of [undefined, ...rows.filter(row => rt.liveAgent(row.sessionId) !== undefined || row.summary.agentAvailable).map(row => row.sessionId)]) {
      try {
        view = jobs.get(jobId, candidate)
        owner = candidate
        break
      } catch {
        // not visible to this caller
      }
    }
    if (!view) throw notFound(`job ${jobId} not found`)
    if (view.owner !== undefined) {
      const row = rows.find(item => item.sessionId === view!.owner)
      if (!row || !rt.canAccess(row)) throw denied(`job ${jobId} belongs to a session outside Remora's reach`)
    }
    return { jobs, view, owner }
  }

  return {
    async 'job.output'(params: Params<'job.output'>, context: OperationContext): Promise<Result<'job.output'>> {
      if (!hasContent(context)) throw new OperationError('denied', 'reading job output needs the dsh.content scope', { denial: { layer: 'token', reason: 'missing-scope' } })
      const { jobs, view, owner } = await locate(params.jobId, context.signal)
      const tail = params.tailBytes ?? 64_000
      const from = Math.max(view.output.earliest, view.output.total - tail)
      const read = jobs.readAt(params.jobId, from, owner)
      const output = read.chunks.map(chunk => chunk.text).join('')
      const bounded = redactTruncate(output, tail)
      return {
        output: bounded.text,
        truncated: read.lossy || from > 0 || bounded.truncated,
        running: view.status === 'running' || view.status === 'stopping',
        untrusted: true,
      }
    },

    async 'job.stop'(params: Params<'job.stop'>, context: OperationContext): Promise<Result<'job.stop'>> {
      const { jobs, owner } = await locate(params.jobId, context.signal)
      let outcome: 'requested' | 'already-finished'
      try {
        outcome = jobs.kill(params.jobId, owner, `stopped from outside through Remora by ${context.actor.clientName}`.slice(0, 200))
      } catch (error) {
        throw fromDsh(error, 'stopping the job failed')
      }
      let status = outcome === 'requested' ? 'stopping' : 'finished'
      try {
        status = jobs.get(params.jobId, owner).status
      } catch {
        // removed once settled
      }
      return { stopped: outcome === 'requested', status }
    },
  }
}
