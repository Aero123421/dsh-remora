/**
 * Which OAuth clients may reach the consent page. Pure, so it is unit-tested
 * under Node.
 */
import { CLI_CLIENT_ID } from './vendor/protocol/endpoints.ts'

export type ClientKind = 'cimd' | 'dcr' | 'cli' | 'pat'

export interface KnownClient {
  name: string
  matches(clientId: string, redirectUri: string): boolean
}

const CLAUDE_HOSTED_CALLBACKS = new Set(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'])

/**
 * Clients allowed by default. Sources (checked 2026-10-12):
 * - ChatGPT: CIMD client id `https://chatgpt.com/oauth/client.json` (OpenAI Apps SDK auth docs).
 * - Claude Code: CIMD client id `https://claude.ai/oauth/claude-code-client-metadata`
 *   (claude.com/docs/connectors/building/authentication, "Callback URLs").
 * - Claude (web, Desktop, mobile, Cowork): Anthropic hosts a CIMD document on claude.ai but
 *   does not publish its exact URL; the callback is `https://claude.ai/api/mcp/auth_callback`.
 *   We accept any https client id on claude.ai whose redirect is that callback (or the
 *   claude.com variant). The redirect check is what matters: tokens can only go there.
 */
export const KNOWN_CLIENTS: readonly KnownClient[] = [
  { name: 'ChatGPT', matches: clientId => clientId === 'https://chatgpt.com/oauth/client.json' },
  { name: 'Claude Code', matches: clientId => clientId === 'https://claude.ai/oauth/claude-code-client-metadata' },
  {
    name: 'Claude',
    matches: (clientId, redirectUri) => {
      try {
        return new URL(clientId).hostname === 'claude.ai' && CLAUDE_HOSTED_CALLBACKS.has(redirectUri)
      } catch {
        return false
      }
    },
  },
]

/**
 * Any client id that parses as a URL is treated as a CIMD client id and so
 * goes through the allowlist. This is at least as broad as the library's own
 * test (https with a non-empty raw path, which includes `https://host/`), so
 * a URL client id can never be classified as a registered (DCR) client.
 */
export function isCimdClientId(clientId: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(clientId)) return false
  try {
    new URL(clientId)
    return true
  } catch {
    return false
  }
}

export function clientKind(clientId: string): ClientKind {
  if (clientId === CLI_CLIENT_ID) return 'cli'
  return isCimdClientId(clientId) ? 'cimd' : 'dcr'
}

export function knownClientName(clientId: string, redirectUri: string): string | null {
  return KNOWN_CLIENTS.find(client => client.matches(clientId, redirectUri))?.name ?? null
}

/** The hub's policy on who may even reach the consent page. */
export function clientPolicy(clientId: string, redirectUri: string, settings: { allowOtherClients: boolean; dcr: boolean }): { allowed: true } | { allowed: false; reason: 'not-allowlisted' | 'dcr-disabled' } {
  const kind = clientKind(clientId)
  if (kind === 'cli') return { allowed: true }
  if (kind === 'cimd') return knownClientName(clientId, redirectUri) !== null || (settings.allowOtherClients && clientId.startsWith('https://')) ? { allowed: true } : { allowed: false, reason: 'not-allowlisted' }
  return settings.dcr ? { allowed: true } : { allowed: false, reason: 'dcr-disabled' }
}

