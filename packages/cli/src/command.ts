import type { Ctx } from './ctx.ts'
import { bool, str, type FlagSpec, type Parsed } from './args.ts'
import { openHub, type Hub } from './hub.ts'

export interface Cmd {
  ctx: Ctx
  args: Parsed
  json: boolean
}

export interface CommandDef {
  name: string
  summary: string
  usage: readonly string[]
  flags: FlagSpec
  run(cmd: Cmd): Promise<number>
}

export function makeCmd(ctx: Ctx, args: Parsed): Cmd {
  return { ctx, args, json: bool(args, 'json') }
}

export function hubOf(cmd: Cmd): Promise<Hub> {
  return openHub(cmd.ctx, str(cmd.args, 'hub'))
}

export function printJson(ctx: Ctx, value: unknown): void {
  ctx.out(JSON.stringify(value, null, 2))
}

/** `--host` as a params fragment. */
export function hostParam(cmd: Cmd): { hostId?: string } {
  const hostId = str(cmd.args, 'host')
  return hostId ? { hostId } : {}
}
