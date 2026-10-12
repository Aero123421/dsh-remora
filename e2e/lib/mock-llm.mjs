// A scripted model server for the E2E harness. It speaks the two wire
// protocols DSH can be pointed at without touching its catalogs:
//
//   - Anthropic Messages (POST /v1/messages, SSE). DSH's native DeepSeek
//     adapter uses this protocol, and `DEEPSEEK_BASE_URL` redirects it here,
//     so a fresh DSH_HOME works with nothing but two environment variables.
//   - OpenAI Chat Completions (POST /v1/chat/completions, SSE), for a custom
//     `llm-pi-ai` provider (`api: openai-completions`).
//
// Replies are canned and deterministic, driven by markers in the newest user
// message so tests can tell this server's output from anything else:
//
//   default                      -> "REMORA-MOCK-REPLY <nonce>"   (nonce from `nonce=<id>`, else "none")
//   contains "remora-e2e:ask"    -> an `ask_user_question` tool call (only when the request offers that tool)
//   contains "remora-e2e:ask-blocking"
//                                -> the same with `timeout: -1`: a blocking ask that waits for an
//                                   answer like the default legacy tool, even in timed mode
//   contains "remora-e2e:approve"
//                                -> a `write` call asking for a sandbox escalation, which DSH puts
//                                   to the user as an approval
//   newest message is the answer -> "REMORA-MOCK-ANSWERED <nonce> <answer json>"
//   timed question still pending -> "REMORA-MOCK-WAITING <nonce>", then the
//   answer_to_pending_question user message -> "REMORA-MOCK-ANSWERED <nonce> <label>"
//   newest message is a `write` result -> "REMORA-MOCK-WRITE <nonce> done|refused"
//
// Run standalone: node e2e/lib/mock-llm.mjs --port 4200
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const REPLY_PREFIX = 'REMORA-MOCK-REPLY'
export const ANSWERED_PREFIX = 'REMORA-MOCK-ANSWERED'
export const WAITING_PREFIX = 'REMORA-MOCK-WAITING'
export const ASK_MARKER = 'remora-e2e:ask'
export const ASK_BLOCKING_MARKER = 'remora-e2e:ask-blocking'
export const APPROVE_MARKER = 'remora-e2e:approve'
export const WRITE_PREFIX = 'REMORA-MOCK-WRITE'
export const JOB_MARKER = 'remora-e2e:job'
export const JOB_PREFIX = 'REMORA-MOCK-JOB'
export const ASK_TOOL = 'ask_user_question'
export const BASH_TOOL = 'bash'
export const WRITE_TOOL = 'write'
export const MOCK_MODEL = 'remora-mock'

const NONCE = /nonce=([A-Za-z0-9_-]{1,64})/

/** Text of every text block in a message, whatever the protocol. */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (typeof block?.text === 'string' ? block.text : typeof block?.content === 'string' ? block.content : '')).join('\n')
}

function nonceIn(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const match = NONCE.exec(textOf(messages[index]?.content))
    if (match) return match[1]
  }
  return 'none'
}

/** Name of the tool whose call the newest message answers (the previous assistant turn's call). */
function answeredTool(messages, protocol) {
  const last = messages.at(-1)
  for (let index = messages.length - 2; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    if (protocol === 'openai') {
      const call = (message.tool_calls ?? []).find(item => item?.id === last?.tool_call_id) ?? message.tool_calls?.[0]
      return call?.function?.name
    }
    const id = Array.isArray(last?.content) ? last.content.find(block => block?.type === 'tool_result')?.tool_use_id : undefined
    const blocks = Array.isArray(message.content) ? message.content.filter(block => block?.type === 'tool_use') : []
    return (blocks.find(block => block.id === id) ?? blocks[0])?.name
  }
  return undefined
}

/** The long-running command the job test starts in the background (prints a marker, then waits). */
export function jobCommand(nonce) {
  return `echo REMORA-JOB-${nonce}; sleep 600 # remora-e2e-job-${nonce}`
}

/** File the approval test writes, inside the session's working directory. */
export function approvalFile(nonce) {
  return `remora-e2e-${nonce}.txt`
}

/**
 * Decide the reply for a conversation in a protocol-neutral form.
 * @param {{ messages: any[], toolNames: string[], protocol: 'anthropic' | 'openai' }} request
 * @returns {{ kind: 'text', text: string } | { kind: 'tool', id: string, name: string, input: object }}
 */
export function decide({ messages, toolNames, protocol }) {
  const last = messages.at(-1)
  const nonce = nonceIn(messages)
  const answer = protocol === 'openai'
    ? (last?.role === 'tool' ? textOf(last.content) : undefined)
    : (Array.isArray(last?.content) ? last.content.find(block => block?.type === 'tool_result') : undefined)
  if (answer !== undefined) {
    const text = typeof answer === 'string' ? answer : textOf(answer.content)
    if (answeredTool(messages, protocol) === BASH_TOOL) {
      // A background bash call answers with the job id at once.
      return { kind: 'text', text: `${JOB_PREFIX} ${nonce} ${/job|bash-/i.test(text) ? 'started' : 'failed'}` }
    }
    if (answeredTool(messages, protocol) === WRITE_TOOL) {
      // DSH's write tool answers "Created file" / "Updated file"; anything else is a refusal or an error.
      const done = /\b(Created|Updated) file\b/.test(text)
      return { kind: 'text', text: `${WRITE_PREFIX} ${nonce} ${done ? 'done' : 'refused'}` }
    }
    // Legacy mode returns the answers; timed mode returns a "pending" notice
    // and the answer arrives later as a user message (answer_to_pending_question).
    if (!/"answers"/.test(text)) return { kind: 'text', text: `${WAITING_PREFIX} ${nonce}` }
    return { kind: 'text', text: `${ANSWERED_PREFIX} ${nonce} ${text.replace(/\s+/g, ' ').slice(0, 200)}` }
  }
  const lastText = textOf(last?.content)
  if (/answer_to_pending_question/.test(lastText)) {
    const picked = /Teal|Navy/.exec(lastText)?.[0] ?? 'other'
    return { kind: 'text', text: `${ANSWERED_PREFIX} ${nonce} ${picked}` }
  }
  if (lastText.includes(APPROVE_MARKER) && toolNames.includes(WRITE_TOOL)) {
    return {
      kind: 'tool',
      id: `toolu_remora_${nonce}_${Date.now().toString(36)}`,
      name: WRITE_TOOL,
      input: {
        file_path: approvalFile(nonce),
        content: `written after an approval from outside (${nonce})\n`,
        sandbox_permissions: 'danger-full-access',
        justification: `Remora E2E approval test (${nonce})`,
      },
    }
  }
  if (lastText.includes(JOB_MARKER) && toolNames.includes(BASH_TOOL)) {
    return {
      kind: 'tool',
      id: `toolu_remora_${nonce}_${Date.now().toString(36)}`,
      name: BASH_TOOL,
      input: { command: jobCommand(nonce), description: `Remora E2E background job (${nonce})`, run_in_background: true },
    }
  }
  if (lastText.includes(ASK_MARKER) && toolNames.includes(ASK_TOOL)) {
    return {
      kind: 'tool',
      id: `toolu_remora_${nonce}_${Date.now().toString(36)}`,
      name: ASK_TOOL,
      input: {
        questions: [{
          id: 'color',
          header: 'Remora E2E',
          question: `Which color should the E2E pick? (${nonce})`,
          options: [{ label: 'Teal', description: 'The Remora brand color.' }, { label: 'Navy', description: 'The hub background.' }],
        }],
        ...(lastText.includes(ASK_BLOCKING_MARKER) ? { timeout: -1 } : {}),
      },
    }
  }
  return { kind: 'text', text: `${REPLY_PREFIX} ${nonce}` }
}

/** Split text into a few chunks so clients see a real stream. */
function chunks(text) {
  const parts = text.match(/.{1,12}/gs) ?? ['']
  return parts
}

function sse(response) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  return {
    event(name, data) { response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`) },
    data(data) { response.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`) },
    end() { response.end() },
  }
}

function anthropicReply(body, response, reply) {
  const id = `msg_remora_${Date.now().toString(36)}`
  const usage = { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  if (body.stream === false) {
    const content = reply.kind === 'text' ? [{ type: 'text', text: reply.text }] : [{ type: 'tool_use', id: reply.id, name: reply.name, input: reply.input }]
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model ?? MOCK_MODEL, content, stop_reason: reply.kind === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { ...usage, output_tokens: 8 } }))
    return
  }
  const out = sse(response)
  out.event('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model ?? MOCK_MODEL, content: [], stop_reason: null, stop_sequence: null, usage } })
  if (reply.kind === 'text') {
    out.event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    for (const text of chunks(reply.text)) out.event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  } else {
    out.event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: reply.id, name: reply.name, input: {} } })
    for (const partial of chunks(JSON.stringify(reply.input))) out.event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partial } })
  }
  out.event('content_block_stop', { type: 'content_block_stop', index: 0 })
  out.event('message_delta', { type: 'message_delta', delta: { stop_reason: reply.kind === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } })
  out.event('message_stop', { type: 'message_stop' })
  out.end()
}

function openaiReply(body, response, reply) {
  const id = `chatcmpl-remora-${Date.now().toString(36)}`
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model ?? MOCK_MODEL }
  if (body.stream !== true) {
    const message = reply.kind === 'text'
      ? { role: 'assistant', content: reply.text }
      : { role: 'assistant', content: null, tool_calls: [{ id: reply.id, type: 'function', function: { name: reply.name, arguments: JSON.stringify(reply.input) } }] }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: reply.kind === 'text' ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }))
    return
  }
  const out = sse(response)
  out.data({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  if (reply.kind === 'text') {
    for (const text of chunks(reply.text)) out.data({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })
  } else {
    out.data({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: reply.id, type: 'function', function: { name: reply.name, arguments: '' } }] }, finish_reason: null }] })
    for (const partial of chunks(JSON.stringify(reply.input))) out.data({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: partial } }] }, finish_reason: null }] })
  }
  out.data({ ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.kind === 'text' ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })
  out.data('[DONE]')
  out.end()
}

/**
 * Start the mock on 127.0.0.1.
 * @param {{ port?: number, log?: (line: string) => void }} [options]
 */
export async function startMockLlm({ port = 0, log = () => {} } = {}) {
  /** Every model request, newest last: { at, protocol, path, model, lastUserText, reply }. */
  const requests = []
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.replace(/\/+$/, '')
      if (request.method === 'GET' && path === '/__mock/requests') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(requests))
        return
      }
      if (request.method === 'GET' && /(^|\/)models$/.test(path)) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: MOCK_MODEL, object: 'model', owned_by: 'remora-e2e' }] }))
        return
      }
      const raw = []
      for await (const chunk of request) raw.push(chunk)
      let body = {}
      try { body = raw.length ? JSON.parse(Buffer.concat(raw).toString('utf8')) : {} } catch { body = {} }
      const protocol = path.endsWith('/messages') ? 'anthropic' : path.endsWith('/chat/completions') ? 'openai' : undefined
      if (request.method !== 'POST' || protocol === undefined) {
        log(`unhandled ${request.method} ${url.pathname}`)
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `remora mock: no route for ${request.method} ${url.pathname}` } }))
        return
      }
      const messages = Array.isArray(body.messages) ? body.messages : []
      const toolNames = (Array.isArray(body.tools) ? body.tools : []).map(tool => tool?.name ?? tool?.function?.name).filter(Boolean)
      const reply = decide({ messages, toolNames, protocol })
      const lastUser = [...messages].reverse().find(message => message?.role === 'user')
      const entry = { at: Date.now(), protocol, path: url.pathname, model: body.model ?? null, tools: toolNames.length, lastUserText: textOf(lastUser?.content).slice(-400), reply: reply.kind === 'text' ? reply.text : `tool:${reply.name}` }
      requests.push(entry)
      log(`${protocol} ${url.pathname} model=${entry.model} tools=${entry.tools} -> ${entry.reply}`)
      if (protocol === 'anthropic') anthropicReply(body, response, reply)
      else openaiReply(body, response, reply)
    } catch (error) {
      log(`error ${error?.stack ?? error}`)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`
  return {
    url,
    port: address.port,
    requests,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const flag = process.argv.find(argument => argument.startsWith('--port='))
  const index = process.argv.indexOf('--port')
  const port = Number(flag ? flag.slice('--port='.length) : index > 0 ? process.argv[index + 1] : 4200)
  const mock = await startMockLlm({ port, log: line => console.log(`[mock-llm] ${line}`) })
  console.log(`[mock-llm] listening on ${mock.url} (Anthropic: ${mock.url}/v1/messages, OpenAI: ${mock.url}/v1/chat/completions)`)
  const stop = () => { void mock.close().then(() => process.exit(0)) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
