// A tiny step runner. Each step passes, fails, or is skipped:
//   - throw new Skip('why') when a feature is not there yet (a 501, a missing
//     button); the harness reports it and moves on.
//   - any other error fails the step.
// A step whose prerequisite did not pass is skipped with that reason, so the
// same scenario turns into a full E2E as soon as the features land.
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class Skip extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'Skip'
  }
}

export function skip(reason) { throw new Skip(reason) }

export class Runner {
  constructor({ artifacts, strict = false }) {
    this.artifacts = artifacts
    this.strict = strict
    this.results = new Map()
    this.order = []
    this.logFile = join(artifacts, 'run.log')
  }

  log(message) {
    const line = `[${new Date().toISOString().slice(11, 23)}] ${message}`
    console.log(line)
    appendFileSync(this.logFile, `${line}\n`)
  }

  status(id) { return this.results.get(id)?.status }

  /**
   * Run one step.
   * @param {string} id
   * @param {string} title
   * @param {{ needs?: string[], timeoutMs?: number, onFailure?: (error: Error) => Promise<void> }} options
   * @param {() => Promise<string | void>} body - resolves with an optional detail line
   */
  async step(id, title, { needs = [], timeoutMs = 120_000, onFailure } = {}, body) {
    this.order.push(id)
    const started = Date.now()
    const blocked = needs.find(need => this.status(need) !== 'pass')
    if (blocked) {
      const why = this.status(blocked) ?? 'not run'
      return this.record(id, title, 'skip', `needs ${blocked} (${why})`, started)
    }
    this.log(`▶ ${id}: ${title}`)
    let timer
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`step timed out after ${timeoutMs} ms`)), timeoutMs) })
      const detail = await Promise.race([body(), timeout])
      return this.record(id, title, 'pass', detail ?? '', started)
    } catch (error) {
      if (error instanceof Skip) return this.record(id, title, 'skip', error.message, started)
      try { await onFailure?.(error) } catch (hookError) { this.log(`  (failure hook failed: ${hookError.message})`) }
      return this.record(id, title, 'fail', error?.stack ?? String(error), started)
    } finally { clearTimeout(timer) }
  }

  record(id, title, status, detail, started) {
    const ms = Date.now() - started
    this.results.set(id, { id, title, status, detail, ms })
    const mark = { pass: '✔', fail: '✘', skip: '–' }[status]
    const first = String(detail).split('\n')[0]
    this.log(`${mark} ${id} [${status}] ${first}${ms > 0 ? ` (${(ms / 1000).toFixed(1)} s)` : ''}`)
    if (status === 'fail') for (const line of String(detail).split('\n').slice(1, 40)) this.log(`    ${line}`)
    return status
  }

  /** Write summary.json / summary.md and return the process exit code. */
  finish(extra = {}) {
    const results = this.order.map(id => this.results.get(id)).filter(Boolean)
    const count = status => results.filter(result => result.status === status).length
    const summary = { passed: count('pass'), failed: count('fail'), skipped: count('skip'), strict: this.strict, ...extra, results }
    writeFileSync(join(this.artifacts, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    const rows = results.map(result => `| ${result.status === 'pass' ? 'pass' : result.status === 'fail' ? '**FAIL**' : 'skip'} | \`${result.id}\` | ${result.title} | ${String(result.detail).split('\n')[0].replaceAll('|', '\\|').slice(0, 300)} |`)
    writeFileSync(join(this.artifacts, 'summary.md'), [
      `# Remora E2E — ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`,
      '',
      ...Object.entries(extra).map(([key, value]) => `- ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`),
      '',
      '| Result | Step | What it proves | Detail |',
      '| --- | --- | --- | --- |',
      ...rows,
      '',
    ].join('\n'))
    this.log(`summary: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped → ${join(this.artifacts, 'summary.md')}`)
    if (summary.failed > 0) return 1
    if (this.strict && summary.skipped > 0) return 2
    return 0
  }
}
