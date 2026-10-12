/**
 * Reads DSH's own catalogs for the settings tab's allow-lists: workspaces,
 * agent presets, skills and slash commands. Each source is optional and read
 * defensively — a missing or changed service yields an empty list and a note,
 * never an error for the whole tab. Services (DSH 0.2.1-alpha.2):
 *   workspaceRegistry.list(), agentPresets.list(), skills.list(),
 *   commands.list(undefined) (the global layer).
 */

export interface CatalogItem { id: string; label: string; description?: string; path?: string }

export interface Catalog {
  workspaces: CatalogItem[]
  agentPresets: CatalogItem[]
  skills: CatalogItem[]
  /** With the leading slash. */
  commands: CatalogItem[]
  /** Sources that could not be read. */
  unavailable: string[]
}

type Get = (service: string) => unknown

function method(service: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  if (service === null || typeof service !== 'object') return undefined
  const fn = (service as Record<string, unknown>)[name]
  return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown).bind(service) : undefined
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

export async function readCatalog(get: Get): Promise<Catalog> {
  const catalog: Catalog = { workspaces: [], agentPresets: [], skills: [], commands: [], unavailable: [] }
  const attempt = async (name: string, read: () => Promise<CatalogItem[]> | CatalogItem[]): Promise<CatalogItem[]> => {
    try {
      return await read()
    } catch {
      catalog.unavailable.push(name)
      return []
    }
  }
  catalog.workspaces = await attempt('workspaces', () => {
    const list = method(get('workspaceRegistry'), 'list')
    if (!list) throw new Error('missing')
    return (list() as unknown[]).map(item => {
      const ws = item as Record<string, unknown>
      const entry: CatalogItem = { id: String(ws.id), label: text(ws.title) ?? String(ws.id) }
      const path = text(ws.path)
      if (path !== undefined) entry.path = path
      return entry
    })
  })
  catalog.agentPresets = await attempt('agentPresets', async () => {
    const list = method(get('agentPresets'), 'list')
    if (!list) throw new Error('missing')
    return ((await list()) as unknown[]).map(item => {
      const preset = item as Record<string, unknown>
      const entry: CatalogItem = { id: String(preset.id), label: text(preset.name) ?? String(preset.id) }
      const description = text(preset.description)
      if (description !== undefined) entry.description = description
      return entry
    })
  })
  catalog.skills = await attempt('skills', async () => {
    const list = method(get('skills'), 'list')
    if (!list) throw new Error('missing')
    return ((await list()) as unknown[]).map(item => {
      const skill = item as Record<string, unknown>
      const entry: CatalogItem = { id: String(skill.name), label: String(skill.name) }
      const description = text(skill.description)
      if (description !== undefined) entry.description = description.slice(0, 200)
      return entry
    })
  })
  catalog.commands = await attempt('commands', () => {
    const list = method(get('commands'), 'list')
    if (!list) throw new Error('missing')
    return (list(undefined) as unknown[]).map(item => {
      const command = item as Record<string, unknown>
      const entry: CatalogItem = { id: `/${String(command.name)}`, label: `/${String(command.name)}` }
      const description = text(command.description)
      if (description !== undefined) entry.description = description.slice(0, 200)
      return entry
    })
  })
  return catalog
}
