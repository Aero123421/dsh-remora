/**
 * JSON Schemas for operation inputs, used as MCP `inputSchema` and checked
 * by both the hub and the DSH plugin (defense in depth). Only the subset of
 * JSON Schema that `validate` understands is used here.
 */
import type { OperationId } from './operations.ts'

export type JsonSchema =
  | { type: 'string'; description?: string; minLength?: number; maxLength?: number; enum?: readonly string[]; pattern?: string }
  | { type: 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string; const?: boolean }
  | { type: 'array'; description?: string; items: JsonSchema; maxItems?: number }
  | ObjectSchema
  | { oneOf: readonly JsonSchema[]; description?: string }
  | { description?: string }

export interface ObjectSchema {
  type: 'object'
  description?: string
  properties: Readonly<Record<string, JsonSchema>>
  required?: readonly string[]
  additionalProperties?: boolean
}

const str = (description: string, maxLength = 200): JsonSchema => ({ type: 'string', description, minLength: 1, maxLength })
const int = (description: string, minimum: number, maximum: number): JsonSchema => ({ type: 'integer', description, minimum, maximum })
const bool = (description: string): JsonSchema => ({ type: 'boolean', description })
const obj = (properties: Record<string, JsonSchema>, required: string[] = [], description?: string): ObjectSchema =>
  ({ type: 'object', properties, required, additionalProperties: false, ...(description ? { description } : {}) })

const hostId = str('DSH host id from dsh_hosts_list. Optional when only one host is paired.', 64)
const sessionId = str('Session id from dsh_sessions_list.', 200)
const workspaceId = str('Workspace id from dsh_workspaces_list.', 200)
const taskId = str('Task id returned by dsh_task_start.', 64)
const idempotencyKey = str('Any unique string you choose (e.g. a UUID). Retrying with the same key never repeats the action.', 128)
const prompt = str('What the agent should do.', 100_000)

const target: JsonSchema = {
  description: 'Which session receives the prompt.',
  oneOf: [
    obj({ sessionId }, ['sessionId']),
    obj({ latest: { type: 'boolean', const: true }, workspaceId }, ['latest']),
    obj({ title: str('Exact session title.'), workspaceId }, ['title']),
    obj({ alias: str('Alias configured on the DSH settings tab.', 64) }, ['alias']),
    obj({ new: obj({ workspaceId, agentPreset: str('Agent preset name, e.g. standard or ptc. Locked after the first turn.', 64), title: str('Title for the new session.') }, ['workspaceId']) }, ['new']),
  ],
}

const answer = obj({
  optionId: str('Id of the chosen option.', 200),
  text: str('Free-text answer.', 20_000),
  approve: bool('Approve (true) or reject (false). Plan reviews only.'),
})

export const INPUT_SCHEMAS: Readonly<Record<OperationId, ObjectSchema>> = {
  'status': obj({}),
  'hosts.list': obj({}),
  'workspaces.list': obj({ hostId, includeArchived: bool('Include archived workspaces.') }),
  'sessions.list': obj({ hostId, workspaceId, includeArchived: bool('Include archived sessions.'), limit: int('Page size.', 1, 200), cursor: str('Cursor from the previous page.', 500) }),
  'session.get': obj({ hostId, sessionId }, ['sessionId']),
  'session.read': obj({ hostId, sessionId, depth: { type: 'string', enum: ['summary', 'turns', 'page'], description: 'summary: a few lines; turns: request/reply previews; page: full transcript items.' }, cursor: str('Cursor from the previous page.', 500), limit: int('Items per page.', 1, 200) }, ['sessionId', 'depth']),
  'skills.list': obj({ hostId, sessionId, workspaceId }),
  'task.start': obj({ hostId, target, prompt, skills: { type: 'array', items: str('Skill name, without the slash.', 64), maxItems: 16, description: 'Skills to load for this prompt.' }, idempotencyKey }, ['target', 'prompt', 'idempotencyKey']),
  'task.get': obj({ taskId }, ['taskId']),
  'task.wait': obj({ taskId, timeoutMs: int('How long to wait, at most 25000.', 0, 25_000) }, ['taskId']),
  'attention.list': obj({ hostId, sessionId }),
  'attention.respond': obj({ hostId, sessionId, attentionId: str('Id from dsh_attention_list.', 200), answer }, ['sessionId', 'attentionId', 'answer']),
  'changes.get': obj({ hostId, sessionId, taskId }),
  'patch.get': obj({ hostId, sessionId, taskId, path: str('Limit the diff to one file.', 1000), maxBytes: int('Truncate the diff after this many bytes.', 1, 1_000_000) }),
  'deliverable.read': obj({ hostId, sessionId, deliverableId: str('Deliverable id from the task result.', 200), maxBytes: int('Truncate after this many bytes.', 1, 1_000_000) }, ['sessionId', 'deliverableId']),
  'session.usage': obj({ hostId, sessionId }, ['sessionId']),
  'task.steer': obj({ hostId, taskId, sessionId, prompt, idempotencyKey }, ['prompt', 'idempotencyKey']),
  'task.cancel': obj({ hostId, taskId }, ['taskId']),
  'task.resubmit': obj({ taskId, idempotencyKey }, ['taskId', 'idempotencyKey']),
  'goal.manage': obj({ hostId, sessionId, action: { type: 'string', enum: ['get', 'set', 'pause', 'resume', 'clear'] }, goal: str('Goal text for action=set.', 4000) }, ['sessionId', 'action']),
  'job.output': obj({ hostId, jobId: str('Background job id.', 200), tailBytes: int('Return only the last bytes.', 1, 1_000_000) }, ['jobId']),
  'workspace.create': obj({ hostId, placementId: str('Allowed parent folder id from dsh_workspaces_list (placements).', 64), name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._-]+$', description: 'New folder name.' }, gitUrl: { type: 'string', maxLength: 2000, pattern: '^https://', description: 'https Git URL to clone.' }, idempotencyKey }, ['placementId', 'name', 'idempotencyKey']),
  'model.select': obj({ hostId, sessionId, provider: str('Provider name.', 100), model: str('Model name.', 200), effort: str('Effort level, e.g. low / medium / high.', 32) }, ['sessionId', 'model']),
  'command.run': obj({ hostId, sessionId, command: { type: 'string', minLength: 2, maxLength: 64, pattern: '^/[a-z0-9][a-z0-9-]*$', description: 'Slash command, e.g. /compact.' }, args: str('Arguments after the command.', 4000) }, ['sessionId', 'command']),
  'approval.respond': obj({ hostId, sessionId, attentionId: str('Approval id.', 200), answer }, ['sessionId', 'attentionId', 'answer']),
  'terminal.run': obj({ hostId, command: str('Shell command.', 8000), cwdWorkspaceId: workspaceId, timeoutMs: int('Timeout.', 1000, 600_000) }, ['command', 'cwdWorkspaceId']),
  'job.stop': obj({ hostId, jobId: str('Background job id.', 200) }, ['jobId']),
  'schedule.manage': obj({ hostId, action: { type: 'string', enum: ['list', 'create', 'delete'] }, scheduleId: str('Schedule id.', 200), spec: {} }, ['action']),
}

export interface ValidationIssue { path: string; message: string }

/** Validate a value against the subset of JSON Schema used above. Returns the issues; empty means valid. */
export function validate(schema: JsonSchema, value: unknown, path = '$'): ValidationIssue[] {
  if ('oneOf' in schema) {
    const matches = schema.oneOf.filter(option => validate(option, value, path).length === 0)
    return matches.length === 1 ? [] : [{ path, message: matches.length === 0 ? 'does not match any allowed shape' : 'matches more than one shape' }]
  }
  if (!('type' in schema)) return []
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return [{ path, message: 'must be a string' }]
      if (schema.minLength !== undefined && value.length < schema.minLength) return [{ path, message: `must have at least ${schema.minLength} characters` }]
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return [{ path, message: `must have at most ${schema.maxLength} characters` }]
      if (schema.enum && !schema.enum.includes(value)) return [{ path, message: `must be one of ${schema.enum.join(', ')}` }]
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return [{ path, message: `must match ${schema.pattern}` }]
      return []
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) return [{ path, message: 'must be an integer' }]
      if (schema.minimum !== undefined && value < schema.minimum) return [{ path, message: `must be ≥ ${schema.minimum}` }]
      if (schema.maximum !== undefined && value > schema.maximum) return [{ path, message: `must be ≤ ${schema.maximum}` }]
      return []
    }
    case 'boolean':
      if (typeof value !== 'boolean') return [{ path, message: 'must be a boolean' }]
      if (schema.const !== undefined && value !== schema.const) return [{ path, message: `must be ${schema.const}` }]
      return []
    case 'array': {
      if (!Array.isArray(value)) return [{ path, message: 'must be an array' }]
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return [{ path, message: `must have at most ${schema.maxItems} items` }]
      return value.flatMap((item, index) => validate(schema.items, item, `${path}[${index}]`))
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [{ path, message: 'must be an object' }]
      const record = value as Record<string, unknown>
      const issues: ValidationIssue[] = []
      for (const key of schema.required ?? []) if (record[key] === undefined) issues.push({ path: `${path}.${key}`, message: 'is required' })
      for (const [key, item] of Object.entries(record)) {
        const property = schema.properties[key]
        if (!property) {
          if (schema.additionalProperties === false) issues.push({ path: `${path}.${key}`, message: 'is not allowed' })
          continue
        }
        if (item !== undefined) issues.push(...validate(property, item, `${path}.${key}`))
      }
      return issues
    }
  }
}

export function validateParams(operation: OperationId, params: unknown): ValidationIssue[] {
  return validate(INPUT_SCHEMAS[operation], params ?? {})
}
