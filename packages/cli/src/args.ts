import { usageError } from './errors.ts'

export type FlagKind = 'bool' | 'string' | 'list'
export type FlagSpec = Readonly<Record<string, FlagKind>>

export interface Parsed {
  positionals: string[]
  flags: Record<string, string | boolean | string[] | undefined>
}

/** Flags every command accepts. */
export const GLOBAL_FLAGS: FlagSpec = { json: 'bool', hub: 'string', help: 'bool' }

const SHORT: Readonly<Record<string, string>> = { h: 'help', y: 'yes', s: 'session' }

/**
 * Minimal, strict argument parser: `--name value`, `--name=value`, boolean
 * `--flag`, repeatable list flags, `--` ends options. Unknown flags are usage
 * errors so typos never silently change behavior.
 */
export function parseArgs(argv: readonly string[], spec: FlagSpec): Parsed {
  const all: FlagSpec = { ...GLOBAL_FLAGS, ...spec }
  const positionals: string[] = []
  const flags: Parsed['flags'] = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break }
    let name: string | undefined
    let inline: string | undefined
    if (arg.startsWith('--') && arg.length > 2) {
      const eq = arg.indexOf('=')
      name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      if (eq !== -1) inline = arg.slice(eq + 1)
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      name = SHORT[arg.slice(1)]
      if (!name || !all[name]) throw usageError(`不明なオプションです: ${arg}`)
    } else {
      positionals.push(arg)
      continue
    }
    const kind = all[name]
    if (!kind) throw usageError(`不明なオプションです: --${name}`)
    if (kind === 'bool') {
      if (inline !== undefined && inline !== 'true' && inline !== 'false') throw usageError(`--${name} は値を取りません`)
      flags[name] = inline !== 'false'
      continue
    }
    let value = inline
    if (value === undefined) {
      const next = argv[i + 1]
      if (next === undefined) throw usageError(`--${name} に値を指定してください`)
      value = next
      i++
    }
    if (kind === 'list') {
      const prev = flags[name]
      flags[name] = [...(Array.isArray(prev) ? prev : []), value]
    } else {
      flags[name] = value
    }
  }
  return { positionals, flags }
}

export function str(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags[name]
  return typeof value === 'string' ? value : undefined
}

export function bool(parsed: Parsed, name: string): boolean {
  return parsed.flags[name] === true
}

export function list(parsed: Parsed, name: string): string[] {
  const value = parsed.flags[name]
  return Array.isArray(value) ? value : []
}

export function int(parsed: Parsed, name: string, min: number, max: number): number | undefined {
  const raw = str(parsed, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw usageError(`--${name} は ${min}〜${max} の整数で指定してください`)
  return value
}
