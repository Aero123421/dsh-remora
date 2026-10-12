/**
 * Read operations. None of these wakes a session: they use
 * `sessionController.list`, `inspect` and `projections`, the workspace
 * registry, and in-memory services (workspaceChanges, jobs).
 */
import { open, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve, sep } from 'node:path'
import type {
  AttentionItem, ChangedFile, ContextPressure, OperationParams, OperationResults, SkillInfo, TurnPreview, WorkspaceSummary,
} from '@dsh-remora/protocol'
import type { OperationContext } from '../ops/types.ts'
import { OperationError } from '../ops/types.ts'
import { redact, redactLine, redactTruncate } from '../redact.ts'
import type {
  DshFileDiff, DshProjectionValues, DshSessionEvent, DshSessionSkillCatalog, DshSkills, DshWorkspaceChanges,
} from './dsh-types.ts'
import { SERVICES } from './dsh-types.ts'
import { denied, fromDsh, invalid, notFound, unavailable } from './errors.ts'
import {
  changesEvents, countTurns, findTaskTurn, lastReply, presentedFiles, transcriptItems, turnPreviews,
} from './events.ts'
import { hasContent, type Runtime, type SessionRow } from './runtime.ts'
import { jobsOf } from './jobs.ts'
import { failedClones } from './workspace-create.ts'

type Params<Op extends keyof OperationParams> = OperationParams[Op]
type Result<Op extends keyof OperationResults> = OperationResults[Op]

const DEFAULT_LIMIT = 50

function encodeCursor(value: number): string {
  return Buffer.from(JSON.stringify({ o: value })).toString('base64url')
}

function decodeCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined
  try {
    const value = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown }).o
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  } catch {
    // fall through
  }
  throw invalid('cursor is not valid')
}

export function contextPressure(values: DshProjectionValues | null): ContextPressure | null {
  const pressure = values?.contextPressure
  if (!pressure) return null
  const used = pressure.projectedTokens ?? pressure.pressureTokens ?? null
  const max = pressure.contextWindow ?? null
  return { usedTokens: used, maxTokens: max, ratio: used !== null && max ? Math.min(1, used / max) : null }
}

export function queueLength(values: DshProjectionValues | null): number {
  const inbox = values?.inbox
  return inbox ? (inbox['next-turn']?.length ?? 0) + (inbox['next-step']?.length ?? 0) : 0
}

/** Strip `detail` (always, for events; or without dsh.content). */
export function withoutDetail(item: AttentionItem): Omit<AttentionItem, 'detail'> {
  const { detail: _detail, ...rest } = item
  return rest
}

export function forCaller(items: AttentionItem[], context: Pick<OperationContext, 'scopes'>): AttentionItem[] {
  return hasContent(context) ? items : items.map(withoutDetail)
}

/** Full attention of one session. Live sessions read the log; cold ones only projections (approvals and tool calls cannot be pending there). */
export async function sessionAttention(rt: Runtime, sessionId: string, signal: AbortSignal, cold?: DshProjectionValues): Promise<AttentionItem[]> {
  const live = rt.liveAgent(sessionId) !== undefined
  if (!live && cold) return rt.attention(sessionId, null, cold)
  const [events, values] = await Promise.all([rt.events(sessionId, signal), rt.projections(sessionId, signal)])
  return rt.attention(sessionId, events, values)
}

export function sortSidebar(rows: SessionRow[], pinnedOrder: readonly string[], workspaceOrder: readonly { sessionIds: readonly string[] }[]): SessionRow[] {
  const top = rows.filter(row => !row.subagent)
  const children = new Map<string, SessionRow[]>()
  const orphans: SessionRow[] = []
  const ids = new Set(top.map(row => row.sessionId))
  for (const row of rows) {
    if (!row.subagent) continue
    if (row.parentSessionId && (ids.has(row.parentSessionId) || rows.some(r => r.sessionId === row.parentSessionId))) {
      const list = children.get(row.parentSessionId) ?? []
      list.push(row)
      children.set(row.parentSessionId, list)
    } else orphans.push(row)
  }
  const byUpdated = (a: SessionRow, b: SessionRow): number => (b.summary.updatedAt ?? 0) - (a.summary.updatedAt ?? 0)
  const position = new Map<string, number>()
  pinnedOrder.forEach((id, index) => position.set(id, index))
  let next = pinnedOrder.length
  for (const workspace of workspaceOrder) for (const id of workspace.sessionIds) if (!position.has(id)) position.set(id, next++)
  const ordered = [...top].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const pa = position.get(a.sessionId)
    const pb = position.get(b.sessionId)
    if (pa !== undefined && pb !== undefined) return pa - pb
    if (pa !== undefined) return -1
    if (pb !== undefined) return 1
    return byUpdated(a, b)
  })
  const out: SessionRow[] = []
  const placed = new Set<string>()
  const place = (row: SessionRow, depth: number): void => {
    if (placed.has(row.sessionId)) return
    placed.add(row.sessionId)
    out.push(row)
    if (depth > 16) return
    for (const child of (children.get(row.sessionId) ?? []).sort(byUpdated)) place(child, depth + 1)
  }
  for (const row of ordered) place(row, 0)
  for (const row of orphans.sort(byUpdated)) place(row, 0)
  for (const row of rows) place(row, 0)
  return out
}

export function createReads(rt: Runtime) {
  async function sessionRowAndEvents(sessionId: string, signal: AbortSignal): Promise<{ row: SessionRow; events: readonly DshSessionEvent[] }> {
    const row = await rt.row(sessionId, signal)
    return { row, events: await rt.events(sessionId, signal) }
  }

  /** Session and turn targeted by changes/patch: a task's turn or the whole session. */
  async function changeTarget(params: { sessionId?: string; taskId?: string }, signal: AbortSignal): Promise<{ sessionId: string; events: readonly DshSessionEvent[]; turns?: number[] }> {
    if (params.taskId !== undefined) {
      const record = rt.deps.tasks.get(params.taskId)
      if (!record || !record.sessionId) throw notFound(`task ${params.taskId} not found on this host`)
      if (params.sessionId !== undefined && params.sessionId !== record.sessionId) throw invalid('taskId and sessionId do not match')
      const { events } = await sessionRowAndEvents(record.sessionId, signal)
      const turns = findTaskTurn(events, record.requestId)?.turns ?? []
      return { sessionId: record.sessionId, events: turns.length > 0 ? events : [], turns }
    }
    if (params.sessionId === undefined) throw invalid('give sessionId or taskId')
    const { events } = await sessionRowAndEvents(params.sessionId, signal)
    return { sessionId: params.sessionId, events }
  }

  async function changedFiles(sessionId: string, events: readonly DshSessionEvent[], turns: readonly number[] | undefined, signal: AbortSignal): Promise<{ file: ChangedFile; seq: number; index: number }[]> {
    const service = rt.get<DshWorkspaceChanges>(SERVICES.workspaceChanges)
    if (!service) throw unavailable('DSH workspace changes are not available')
    const byPath = new Map<string, { file: ChangedFile; seq: number; index: number }>()
    for (const { seq } of changesEvents(events, turns)) {
      const summary = service.summary(sessionId, seq)
      if (!summary) continue
      for (const [index, file] of summary.files.entries()) {
        let status: ChangedFile['status'] = 'modified'
        if (turns !== undefined && summary.files.length <= 50) {
          const diff = await service.diff(sessionId, seq, index, signal).catch(() => undefined)
          if (diff?.kind === 'text') status = diff.before && !diff.after ? 'deleted' : !diff.before && diff.after ? 'added' : 'modified'
        }
        const previous = byPath.get(file.path)
        if (previous) {
          previous.file.additions = (previous.file.additions ?? 0) + file.added
          previous.file.deletions = (previous.file.deletions ?? 0) + file.deleted
          previous.seq = seq
          previous.index = index
        } else {
          byPath.set(file.path, { file: { path: redactLine(file.display || file.path, 1000), status, additions: file.added, deletions: file.deleted }, seq, index })
        }
      }
    }
    return [...byPath.values()]
  }

  return {
    async 'workspaces.list'(params: Params<'workspaces.list'>): Promise<Result<'workspaces.list'>> {
      const registry = rt.workspaces
      if (!registry) throw unavailable('DSH workspace registry is not available')
      const workspaces: WorkspaceSummary[] = []
      for (const workspace of registry.list()) {
        if (!rt.deps.scope.canAccessWorkspace(workspace.id, workspace.path)) continue
        workspaces.push({
          workspaceId: workspace.id,
          name: redactLine(workspace.title, 200),
          path: workspace.path,
          // DSH 0.2.1 has no workspace pin or archive: those flags exist for sessions only.
          pinned: false,
          archived: false,
          untrusted: rt.deps.scope.isUntrustedWorkspace(workspace.id),
          state: rt.workspaceState(workspace.id) ?? 'ready',
        })
      }
      for (const failed of failedClones(rt.creations.list())) {
        if (rt.deps.scope.canAccessWorkspace(failed.workspaceId || null, failed.path)) workspaces.push(failed)
      }
      void params.includeArchived
      return { workspaces, placements: rt.deps.scope.placements() }
    },

    async 'sessions.list'(params: Params<'sessions.list'>, context: OperationContext): Promise<Result<'sessions.list'>> {
      const rows = (await rt.catalog(context.signal)).filter(row =>
        (params.includeArchived === true || !row.archived)
        && (params.workspaceId === undefined || row.workspace?.id === params.workspaceId)
        && rt.canAccess(row))
      const registry = rt.workspaces
      const ordered = sortSidebar(rows, registry?.pinnedSessionIds ?? [], registry?.list() ?? [])
      const offset = decodeCursor(params.cursor) ?? 0
      const limit = params.limit ?? DEFAULT_LIMIT
      const page = ordered.slice(offset, offset + limit)
      return {
        sessions: page.map(row => rt.summaryOf(row)),
        nextCursor: offset + limit < ordered.length ? encodeCursor(offset + limit) : null,
      }
    },

    async 'session.get'(params: Params<'session.get'>, context: OperationContext): Promise<Result<'session.get'>> {
      const row = await rt.row(params.sessionId, context.signal)
      const values = (await rt.projections(row.sessionId, context.signal)) ?? row.values
      // inspect() reads the log without waking the session.
      const events = await rt.events(row.sessionId, context.signal)
      const attention = rt.attention(row.sessionId, events, values)
      const content = hasContent(context)
      const recentTurns: TurnPreview[] = turnPreviews(events, values).slice(-5).map(turn => ({
        index: turn.index,
        request: content ? redactTruncate(turn.request, 500).text : '',
        reply: content ? redactTruncate(turn.reply, 1000).text : '',
        at: turn.at,
      }))
      return {
        session: rt.summaryOf({ ...row, values: { ...row.values, ...values } }),
        context: contextPressure(values),
        recentTurns,
        queueLength: queueLength(values),
        attention: forCaller(attention, context),
        // Command lines are session content: without dsh.content only ids and states.
        jobs: jobsOf(rt, row.sessionId).map(job => (content ? job : { ...job, label: '' })),
        hasLiveClient: rt.hasLiveClient(row.sessionId),
        untrusted: true,
      }
    },

    async 'session.read'(params: Params<'session.read'>, context: OperationContext): Promise<Result<'session.read'>> {
      if (!hasContent(context)) throw new OperationError('denied', 'reading a transcript needs the dsh.content scope', { denial: { layer: 'token', reason: 'missing-scope' } })
      const { row, events } = await sessionRowAndEvents(params.sessionId, context.signal)
      const limit = params.limit ?? DEFAULT_LIMIT
      if (params.depth === 'summary') {
        const reply = lastReply(events)
        return {
          depth: 'summary',
          summary: { title: redactLine(row.title || 'New session', 200), turnCount: countTurns(events), lastReply: reply === null ? null : redactTruncate(reply, 2000).text },
          nextCursor: null,
          untrusted: true,
        }
      }
      if (params.depth === 'turns') {
        const values = await rt.projections(row.sessionId, context.signal)
        const turns = turnPreviews(events, values)
        const end = decodeCursor(params.cursor) ?? turns.length
        const start = Math.max(0, end - limit)
        return {
          depth: 'turns',
          turns: turns.slice(start, end).map(turn => ({ ...turn, request: redactTruncate(turn.request, 2000).text, reply: redactTruncate(turn.reply, 4000).text })),
          nextCursor: start > 0 ? encodeCursor(start) : null,
          untrusted: true,
        }
      }
      const items = transcriptItems(events)
      const before = decodeCursor(params.cursor)
      const eligible = before === undefined ? items : items.filter(item => item.seq < before)
      const page = eligible.slice(Math.max(0, eligible.length - limit))
      const first = page[0]
      return {
        depth: 'page',
        items: page.map(({ seq: _seq, ...item }) => item),
        nextCursor: first && eligible.length > page.length ? encodeCursor(first.seq) : null,
        untrusted: true,
      }
    },

    async 'skills.list'(params: Params<'skills.list'>, context: OperationContext): Promise<Result<'skills.list'>> {
      let entries: readonly { name: string; description: string; path?: string }[]
      let workspaceId: string | null
      let cwd: string | null = null
      if (params.sessionId !== undefined) {
        const row = await rt.row(params.sessionId, context.signal)
        workspaceId = row.workspace?.id ?? null
        cwd = row.workspacePath
        const catalog = rt.get<DshSessionSkillCatalog>(SERVICES.sessionSkillCatalog)
        if (!catalog) throw unavailable('DSH skill catalog is not available')
        try {
          entries = (await catalog.list({ sessionId: row.sessionId }, context.signal)).skills
        } catch (error) {
          throw fromDsh(error, 'listing skills failed')
        }
      } else if (params.workspaceId !== undefined) {
        const workspace = rt.workspace(params.workspaceId)
        workspaceId = workspace.id
        cwd = workspace.path
        const skills = rt.get<DshSkills>(SERVICES.skills)
        if (!skills) throw unavailable('DSH skill registry is not available')
        try {
          entries = (await skills.list({ cwd: workspace.path })).filter(skill => skill.invocation?.userInvocable !== false)
        } catch (error) {
          throw fromDsh(error, 'listing skills failed')
        }
      } else {
        throw invalid('give sessionId or workspaceId')
      }
      if (workspaceId !== null && rt.deps.scope.isUntrustedWorkspace(workspaceId)) return { skills: [] }
      const skills: SkillInfo[] = entries
        .filter(entry => rt.deps.scope.isAllowedSkill(entry.name, workspaceId))
        .map(entry => ({ name: entry.name, description: redactLine(entry.description, 500), source: skillSource(entry.path, cwd) }))
      return { skills }
    },

    async 'attention.list'(params: Params<'attention.list'>, context: OperationContext): Promise<Result<'attention.list'>> {
      if (params.sessionId !== undefined) {
        const row = await rt.row(params.sessionId, context.signal)
        return { items: forCaller(await sessionAttention(rt, row.sessionId, context.signal), context) }
      }
      const rows = (await rt.catalog(context.signal)).filter(row => !row.archived && rt.canAccess(row))
      const items: AttentionItem[] = []
      for (const row of rows) {
        items.push(...await sessionAttention(rt, row.sessionId, context.signal, row.values).catch(() => []))
      }
      return { items: forCaller(items, context) }
    },

    async 'session.usage'(params: Params<'session.usage'>, context: OperationContext): Promise<Result<'session.usage'>> {
      const row = await rt.row(params.sessionId, context.signal)
      const values = (await rt.projections(row.sessionId, context.signal)) ?? row.values
      const usage = values.tokenUsage
      const input = usage ? usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : null
      const breakdown = values.contextBreakdown
      return {
        tokens: {
          input,
          output: usage?.outputTokens ?? null,
          cacheRead: usage?.cacheReadTokens ?? null,
          cacheWrite: usage?.cacheWriteTokens ?? null,
          total: usage && input !== null ? input + usage.outputTokens : null,
        },
        context: contextPressure(values),
        breakdown: breakdown
          ? [
              { label: 'system', tokens: breakdown.systemTokens },
              { label: 'tools', tokens: breakdown.toolsTokens },
              { label: 'messages', tokens: breakdown.messageTokens },
            ]
          : [],
      }
    },

    async 'changes.get'(params: Params<'changes.get'>, context: OperationContext): Promise<Result<'changes.get'>> {
      const target = await changeTarget(params, context.signal)
      const files = await changedFiles(target.sessionId, target.events, target.turns, context.signal)
      return { files: files.map(entry => entry.file) }
    },

    async 'patch.get'(params: Params<'patch.get'>, context: OperationContext): Promise<Result<'patch.get'>> {
      if (!hasContent(context)) throw new OperationError('denied', 'reading a patch needs the dsh.content scope', { denial: { layer: 'token', reason: 'missing-scope' } })
      const target = await changeTarget(params, context.signal)
      const service = rt.get<DshWorkspaceChanges>(SERVICES.workspaceChanges)!
      const files = await changedFiles(target.sessionId, target.events, target.turns, context.signal)
      const maxBytes = params.maxBytes ?? 200_000
      let patch = ''
      let truncated = false
      for (const { file, seq, index } of files) {
        if (params.path !== undefined && file.path !== params.path) continue
        const diff = await service.diff(target.sessionId, seq, index, context.signal).catch(() => undefined)
        if (!diff) continue
        patch += renderDiff(diff)
        if (Buffer.byteLength(patch) > maxBytes) {
          truncated = true
          break
        }
      }
      patch = redact(patch)
      if (Buffer.byteLength(patch) > maxBytes) {
        patch = Buffer.from(patch).subarray(0, maxBytes).toString('utf8').replace(/�$/, '')
        truncated = true
      }
      return { patch, truncated, untrusted: true }
    },

    async 'deliverable.read'(params: Params<'deliverable.read'>, context: OperationContext): Promise<Result<'deliverable.read'>> {
      if (!hasContent(context)) throw new OperationError('denied', 'reading a deliverable needs the dsh.content scope', { denial: { layer: 'token', reason: 'missing-scope' } })
      const { row, events } = await sessionRowAndEvents(params.sessionId, context.signal)
      const file = presentedFiles(events).find(item => item.deliverableId === params.deliverableId)
      if (!file) throw notFound(`deliverable ${params.deliverableId} not found in session ${params.sessionId}`)
      const base = row.workspacePath ?? row.summary.cwd
      if (!base) throw denied('the session has no working directory to read deliverables from')
      return readDeliverable(file.path, base, params.maxBytes ?? 256_000, file.description)
    },
  }
}

export function skillSource(path: string | undefined, cwd: string | null): string {
  if (!path) return 'builtin'
  const normalized = path.split(sep).join('/')
  const home = (process.env.HOME ?? process.env.USERPROFILE ?? '').split(sep).join('/')
  for (const root of ['.dsh/skills', '.agents/skills']) {
    if (cwd && normalized.startsWith(`${cwd.split(sep).join('/')}/${root}/`)) return root
    if (home && normalized.startsWith(`${home}/${root}/`)) return `~/${root}`
  }
  if (normalized.includes('/.dsh/skills/')) return '.dsh/skills'
  if (normalized.includes('/.agents/skills/')) return '.agents/skills'
  return 'plugin'
}

export function renderDiff(diff: DshFileDiff): string {
  const path = diff.path.split(sep).join('/')
  if (diff.kind !== 'text') return `diff --remora a/${path} b/${path}\n${diff.kind === 'binary' ? 'Binary files differ' : 'File too large to compare'}\n`
  const lines = [
    `diff --remora a/${path} b/${path}`,
    diff.before ? `--- a/${path}` : '--- /dev/null',
    diff.after ? `+++ b/${path}` : '+++ /dev/null',
  ]
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    lines.push(...hunk.lines)
  }
  return `${lines.join('\n')}\n`
}

const MIME: Readonly<Record<string, string>> = {
  '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html',
  '.csv': 'text/csv', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.js': 'text/javascript', '.ts': 'text/x-typescript', '.py': 'text/x-python', '.css': 'text/css',
}

/** Read a presented file as text, only inside the session's folder, capped and redacted. */
export async function readDeliverable(path: string, base: string, maxBytes: number, description?: string): Promise<Result<'deliverable.read'>> {
  let root: string
  let target: string
  try {
    root = await realpath(base)
    target = await realpath(isAbsolute(path) ? path : resolve(base, path))
  } catch {
    throw notFound('the deliverable file no longer exists')
  }
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw denied('the deliverable is outside the session folder; open it in DSH Web')
  }
  const info = await stat(target)
  if (!info.isFile()) throw invalid('the deliverable is not a regular file')
  const handle = await open(target, 'r')
  try {
    const length = Math.min(info.size, maxBytes)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.includes(0)) throw invalid('the deliverable is a binary file; open it in DSH Web')
    const text = bytes.toString('utf8').replace(/�$/, '')
    const title = description ? redactLine(description, 200) : target.slice(root.length + 1) || target
    return { title, mimeType: MIME[extname(target).toLowerCase()] ?? 'text/plain', content: redact(text), truncated: info.size > maxBytes, untrusted: true }
  } finally {
    await handle.close()
  }
}
