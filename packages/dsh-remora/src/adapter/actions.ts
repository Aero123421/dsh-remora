/**
 * Session-acting operations other than tasks: answering attention, goals,
 * model selection and slash commands. These resolve (and may wake) the
 * session's Agent, after the scope check.
 */
import type { ModelChoice, OperationParams, OperationResults } from '@dsh-remora/protocol'
import type { OperationContext } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redactTruncate } from '../redact.ts'
import type { DshCommands, DshGoals, DshModelCatalog, DshUserQuestions } from './dsh-types.ts'
import { SERVICES } from './dsh-types.ts'
import { denied, fromDsh, invalid, unavailable } from './errors.ts'
import { computeAttention } from './events.ts'
import { hasContent, modelOf, type Runtime, type SessionRow } from './runtime.ts'

type Params<Op extends keyof OperationParams> = OperationParams[Op]
type Result<Op extends keyof OperationResults> = OperationResults[Op]

function promptable(row: SessionRow): void {
  if (row.subagent) throw invalid(`session ${row.sessionId} is a subagent session`)
  if (row.archived) throw new OperationError('conflict', `session ${row.sessionId} is archived`)
}

/** Match a requested model against the DSH catalog (exact id first, then case-insensitive id or name). */
export function matchModel(catalog: DshModelCatalog, request: { provider?: string; model: string; effort?: string }): { provider: string; model: string; effort?: string } | null {
  const want = request.model.trim().toLowerCase()
  const groups = catalog.groups.filter(group => request.provider === undefined
    || group.id === request.provider || group.name.toLowerCase() === request.provider.toLowerCase())
  const candidates = groups.flatMap(group => group.models.map(model => ({ group, model })))
  const found = candidates.find(c => c.model.id === request.model)
    ?? candidates.find(c => c.model.id.toLowerCase() === want)
    ?? candidates.find(c => c.model.name.toLowerCase() === want)
  if (!found) return null
  const efforts = found.model.reasoning?.efforts ?? []
  if (request.effort === undefined) return { provider: found.group.id, model: found.model.id }
  const effort = efforts.find(e => e.id === request.effort || e.id.toLowerCase() === request.effort!.toLowerCase() || e.name.toLowerCase() === request.effort!.toLowerCase())
  if (!effort) return null
  return { provider: found.group.id, model: found.model.id, effort: effort.id }
}

export function catalogChoices(catalog: DshModelCatalog, provider?: string): ModelChoice[] {
  return catalog.groups
    .filter(group => provider === undefined || group.id === provider || group.name.toLowerCase() === provider.toLowerCase())
    .flatMap(group => group.models.flatMap((model): ModelChoice[] => {
      const efforts = model.reasoning?.efforts ?? []
      if (efforts.length === 0) return [{ provider: group.id, model: model.id, effort: null }]
      return efforts.map(effort => ({ provider: group.id, model: model.id, effort: effort.id }))
    }))
    .slice(0, 100)
}

export function createActions(rt: Runtime) {
  async function sessionFor(sessionId: string, context: OperationContext): Promise<SessionRow> {
    const row = await rt.row(sessionId, context.signal)
    promptable(row)
    return row
  }

  async function goalState(sessionId: string, context: OperationContext): Promise<Result<'goal.manage'>> {
    const values = await rt.projections(sessionId, context.signal)
    const goal = values?.goal
    return { goal: goal ? { text: hasContent(context) ? redactTruncate(goal.goal.objective, 4000).text : '', state: goal.goal.phase } : null }
  }

  async function manageGoal(params: Params<'goal.manage'>, context: OperationContext): Promise<Result<'goal.manage'>> {
    const row = params.action === 'get' ? await rt.row(params.sessionId, context.signal) : await sessionFor(params.sessionId, context)
    if (params.action === 'get') return goalState(row.sessionId, context)
    const goals = rt.get<DshGoals>(SERVICES.goals)
    if (!goals) throw unavailable('DSH goals are not available')
    const agent = await rt.agent(row.sessionId)
    try {
      const current = goals.get(agent)
      const ref = current ? { id: current.id, revision: current.revision } : null
      switch (params.action) {
        case 'set': {
          const objective = params.goal?.trim()
          if (!objective) throw invalid('goal text is required for action=set')
          if (current && current.phase !== 'complete') goals.edit(agent, ref!, { objective })
          else goals.create(agent, { objective })
          break
        }
        case 'pause':
          if (!ref) throw new OperationError('conflict', 'the session has no goal')
          goals.pause(agent, ref)
          break
        case 'resume':
          if (!ref) throw new OperationError('conflict', 'the session has no goal')
          goals.resume(agent, ref)
          break
        case 'clear':
          if (!ref) return { goal: null }
          goals.clear(agent, ref)
          break
      }
    } catch (error) {
      throw fromDsh(error, 'the goal could not be changed')
    }
    return goalState(row.sessionId, context)
  }

  return {
    'goal.manage': manageGoal,

    async 'attention.respond'(params: Params<'attention.respond'>, context: OperationContext): Promise<Result<'attention.respond'>> {
      const row = await rt.row(params.sessionId, context.signal)
      const [events, values] = await Promise.all([rt.events(row.sessionId, context.signal), rt.projections(row.sessionId, context.signal)])
      const item = computeAttention(row.sessionId, { events, values, loginError: rt.loginErrors.get(row.sessionId) ?? null })
        .find(candidate => candidate.attentionId === params.attentionId)
      // Answered on DSH Web first (or never existed): refuse instead of answering twice.
      if (!item) throw new OperationError('conflict', 'this item was already answered or is no longer waiting')
      const answer = params.answer
      switch (item.kind) {
        case 'approval':
          throw invalid('approvals are answered with approval.respond (P2), not attention.respond')
        case 'login-expired':
          throw unavailable('sign in to the provider again on DSH; this cannot be done remotely')
        case 'plan-review':
          // DSH 0.2.1 asks plan reviews through the blocking `user-questions/request`
          // waterfall only; there is no API to answer one from the host side.
          throw unavailable('plan reviews cannot be answered remotely on this DSH version; answer it in DSH Web')
        case 'goal-stopped': {
          const action = answer.optionId === 'clear' || answer.approve === false ? 'clear' : 'resume'
          await manageGoal({ sessionId: row.sessionId, action }, context)
          return { accepted: true }
        }
        case 'question': {
          // Legacy mode (tool-ask-user's default): `userQuestions.ask` dispatches the
          // `user-questions/request` waterfall and blocks until a listener answers.
          // DSH Web's client listener holds the question; with no client attached,
          // the waterfall falls through to NO_PROVIDER and the tool call fails at
          // once. A host-side listener could race `next()`, but it cannot withdraw
          // the Web card (`next()` takes no signal) and would turn "no UI → fail
          // fast" into "wait forever", so Remora does not answer legacy questions.
          // Timed mode records `continued` questions in the `userQuestions`
          // projection, and `userQuestions.answer` is the supported way to answer.
          if (!item.answerable) {
            throw unavailable('this question is held by DSH Web (legacy ask_user_question mode); answer it there, or switch tool-ask-user to timed mode to answer remotely')
          }
          const pending = values?.userQuestions?.active.find(question => question.callId === params.attentionId)
          if (!pending || pending.state !== 'continued') throw new OperationError('conflict', 'this question is no longer waiting')
          if (pending.questions.length !== 1) throw invalid('this question has several parts; answer it in DSH Web')
          const question = pending.questions[0]!
          const selected: string[] = []
          if (answer.optionId !== undefined) {
            const option = question.options?.[Number(answer.optionId)]
            if (!option || !/^\d+$/.test(answer.optionId)) throw invalid(`option ${answer.optionId} does not exist`)
            selected.push(option.label)
          }
          if (selected.length === 0 && (answer.text === undefined || answer.text.trim() === '')) throw invalid('give optionId or text')
          const service = rt.get<DshUserQuestions>(SERVICES.userQuestions)
          if (!service) throw unavailable('DSH user questions are not available')
          const agent = await rt.agent(row.sessionId)
          let accepted: boolean
          try {
            accepted = service.answer(agent, params.attentionId, {
              answers: [{ id: question.id, selected, ...(answer.text !== undefined && answer.text.trim() !== '' ? { custom: answer.text } : {}) }],
            })
          } catch (error) {
            throw fromDsh(error, 'the answer was not accepted')
          }
          if (!accepted) throw new OperationError('conflict', 'this question was already answered')
          return { accepted: true }
        }
      }
    },

    async 'model.select'(params: Params<'model.select'>, context: OperationContext): Promise<Result<'model.select'>> {
      const row = await sessionFor(params.sessionId, context)
      let catalog: DshModelCatalog
      try {
        catalog = await rt.sessions.modelCatalog()
      } catch (error) {
        throw fromDsh(error, 'reading the model catalog failed')
      }
      const match = matchModel(catalog, params)
      if (!match) {
        // No match: report the choices DSH offers instead of failing.
        return { model: modelOf(row.values) ?? { provider: null, model: null, effort: null }, savedAsDefault: false, candidates: catalogChoices(catalog, params.provider) }
      }
      const wasLive = rt.liveAgent(row.sessionId) !== undefined
      try {
        const { selected } = await rt.sessions.selectModel({ sessionId: row.sessionId, provider: match.provider, model: match.model, ...(match.effort !== undefined ? { reasoningEffort: match.effort } : {}) })
        rt.noteWake(row.sessionId, wasLive)
        // DSH saves a successful selection as the default for new sessions (in the background).
        return { model: { provider: selected.provider, model: selected.model, effort: selected.reasoningEffort ?? null }, savedAsDefault: true }
      } catch (error) {
        rt.noteWake(row.sessionId, wasLive)
        throw fromDsh(error, 'selecting the model failed')
      }
    },

    async 'command.run'(params: Params<'command.run'>, context: OperationContext): Promise<Result<'command.run'>> {
      const command = params.command.trim()
      if (!/^\/[a-z0-9][a-z0-9-]*$/.test(command)) throw invalid('command must look like /name')
      if (!rt.deps.scope.isAllowedCommand(command)) throw denied(`${command} is not allowed for remote use`)
      const row = await sessionFor(params.sessionId, context)
      const commands = rt.get<DshCommands>(SERVICES.commands)
      if (!commands) throw unavailable('DSH commands are not available')
      const agent = await rt.agent(row.sessionId)
      const line = params.args !== undefined && params.args.trim() !== '' ? `${command} ${params.args}` : command
      let execution: Awaited<ReturnType<DshCommands['execute']>>
      try {
        execution = await commands.execute(agent, line, [], context.signal)
      } catch (error) {
        throw fromDsh(error, `${command} failed`)
      }
      if (execution === undefined) throw new OperationError('not_found', `${command} is not a command in this session`)
      const text = execution.result.text ?? null
      return {
        accepted: execution.result.kind === 'success',
        output: text !== null && hasContent(context) ? redactTruncate(text, 20_000).text : null,
        untrusted: true,
      }
    },
  }
}
