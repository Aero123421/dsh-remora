/**
 * What outside clients may reach: the `ScopePolicy` the adapter asks before
 * touching a workspace or session, plus validation of placements (parent
 * folders where new workspaces may be created).
 */
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { FORBIDDEN_COMMANDS, type PlacementInfo } from '@dsh-remora/protocol'
import type { ScopePolicy, SessionScopeInput } from '../ops/types.ts'
import type { Placement, RemoraSettings } from './settings.ts'

/** Whether `child` is `parent` or inside it (both absolute, already normalized). */
export function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

export class PlacementError extends Error {
  readonly code: 'not-absolute' | 'not-found' | 'not-directory' | 'forbidden'
  constructor(code: PlacementError['code'], message: string) {
    super(message)
    this.name = 'PlacementError'
    this.code = code
  }
}

async function realOrSelf(path: string): Promise<string> {
  try { return await realpath(path) } catch { return path }
}

export interface ForbiddenRoots {
  home: string
  dshHome: string
}

/**
 * Validate a candidate placement and return its realpath. Refused:
 * filesystem roots, the home directory itself, anything containing the
 * home directory, `$DSH_HOME` or `~/.ssh` (a workspace could be created on
 * top of them), and anything inside `$DSH_HOME` or `~/.ssh`.
 */
export async function validatePlacement(path: string, roots: ForbiddenRoots = { home: homedir(), dshHome: join(homedir(), '.dsh') }): Promise<string> {
  if (!isAbsolute(path)) throw new PlacementError('not-absolute', 'the folder must be an absolute path')
  let real: string
  try { real = await realpath(path) } catch { throw new PlacementError('not-found', 'the folder does not exist') }
  if (!(await stat(real)).isDirectory()) throw new PlacementError('not-directory', 'not a folder')
  const home = await realOrSelf(roots.home)
  const dshHome = await realOrSelf(roots.dshHome)
  const ssh = await realOrSelf(join(home, '.ssh'))
  if (parse(real).root === real) throw new PlacementError('forbidden', 'a filesystem root cannot be a placement')
  for (const protectedPath of [home, dshHome, ssh]) {
    if (isWithin(protectedPath, real)) throw new PlacementError('forbidden', 'this folder contains the home folder, $DSH_HOME or ~/.ssh')
  }
  for (const protectedPath of [dshHome, ssh]) {
    if (isWithin(real, protectedPath)) throw new PlacementError('forbidden', 'folders inside $DSH_HOME or ~/.ssh cannot be placements')
  }
  return real
}

export function newPlacement(real: string, now = Date.now()): Placement {
  return { placementId: randomUUID().slice(0, 8), path: real, addedAt: now }
}

export interface ScopeDeps {
  settings: () => RemoraSettings
  markUntrusted: (workspaceId: string) => Promise<void>
  now?: () => number
}

export class SettingsScopePolicy implements ScopePolicy {
  private readonly deps: ScopeDeps
  /** Placements whose stored realpath no longer resolves to itself are skipped. */
  private invalidPlacements = new Set<string>()
  private roots: ForbiddenRoots | undefined

  constructor(deps: ScopeDeps) {
    this.deps = deps
  }

  private get settings(): RemoraSettings { return this.deps.settings() }

  /** Re-check placements against the filesystem (symlinks may have moved). */
  async revalidatePlacements(roots?: ForbiddenRoots): Promise<void> {
    if (roots) this.roots = roots
    const invalid = new Set<string>()
    for (const placement of this.settings.scope.placements) {
      try {
        const real = await validatePlacement(placement.path, this.roots)
        if (real !== placement.path) invalid.add(placement.placementId)
      } catch {
        invalid.add(placement.placementId)
      }
    }
    this.invalidPlacements = invalid
  }

  async resolvePlacement(placementId: string): Promise<PlacementInfo> {
    const placement = this.settings.scope.placements.find(item => item.placementId === placementId)
    if (!placement) throw new PlacementError('not-found', 'the placement is no longer configured')
    try {
      const real = await validatePlacement(placement.path, this.roots)
      if (real !== placement.path) throw new PlacementError('forbidden', 'the placement folder now resolves to a different folder')
      // Settings can change while filesystem checks are running.
      if (!this.settings.scope.placements.some(item => item.placementId === placementId && item.path === real)) {
        throw new PlacementError('forbidden', 'the placement is no longer allowed')
      }
      this.invalidPlacements.delete(placementId)
      return { placementId, path: real }
    } catch (error) {
      this.invalidPlacements.add(placementId)
      throw error
    }
  }

  isPlacementValid(placementId: string): boolean {
    return !this.invalidPlacements.has(placementId)
  }

  canAccessWorkspace(workspaceId: string | null, path: string | null): boolean {
    if (workspaceId !== null && this.settings.scope.workspaces.includes(workspaceId)) return true
    if (path === null || !isAbsolute(path)) return false
    // A workspace created under a placement is reachable without editing the list.
    return this.placements().some(placement => isWithin(path, placement.path) && path !== placement.path)
  }

  canAccessSession(session: SessionScopeInput): boolean {
    const exception = this.settings.scope.exceptions.find(item => item.sessionId === session.sessionId)
    if (exception) return exception.allow
    if (session.workspaceId === null && session.workspacePath === null) return this.settings.scope.outsideWorkspace
    return this.canAccessWorkspace(session.workspaceId, session.workspacePath)
  }

  placements(): PlacementInfo[] {
    return this.settings.scope.placements
      .filter(placement => this.isPlacementValid(placement.placementId))
      .map(({ placementId, path }) => ({ placementId, path }))
  }

  // Skills, agent presets and slash commands always need an explicit allow on
  // the DSH tab. Full remote access never widens these lists: it is a
  // host-wide ceiling, not the caller's grant, and a blanket "everything" would
  // let any client run commands such as `/permission` (see FORBIDDEN_COMMANDS).

  isAllowedSkill(name: string, workspaceId: string | null): boolean {
    if (workspaceId !== null && this.isUntrustedWorkspace(workspaceId)) return false
    return this.settings.scope.skills.includes(name)
  }

  isAllowedAgentPreset(name: string): boolean {
    return this.settings.scope.agentPresets.includes(name)
  }

  isAllowedCommand(name: string): boolean {
    const command = (name.startsWith('/') ? name : `/${name}`).toLowerCase()
    if (FORBIDDEN_COMMANDS.has(command)) return false
    return this.settings.scope.commands.includes(command)
  }

  aliases(): Readonly<Record<string, string>> {
    return this.settings.scope.aliases
  }

  gitHosts(): readonly string[] {
    return this.settings.scope.gitHosts
  }

  isUntrustedWorkspace(workspaceId: string): boolean {
    return this.settings.scope.untrustedWorkspaces.includes(workspaceId)
  }

  markUntrustedWorkspace(workspaceId: string): Promise<void> {
    return this.deps.markUntrusted(workspaceId)
  }
}
