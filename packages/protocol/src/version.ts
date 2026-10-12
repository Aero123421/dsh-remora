/**
 * Version of the hub <-> DSH plugin wire protocol. It is versioned separately
 * from DSH and from the Remora release number. The hub accepts the current
 * version and the one before it, so the hub and the plugin can be updated on
 * different days without breaking the connection.
 */
export const PROTOCOL_VERSION = 1

/** Protocol versions the hub accepts from a connecting plugin. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION]

export function isSupportedProtocol(version: unknown): version is number {
  return typeof version === 'number' && SUPPORTED_PROTOCOL_VERSIONS.includes(version)
}
