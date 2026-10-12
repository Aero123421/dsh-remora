/** Records exchanged between the Worker and the Durable Objects over RPC. */
import type { Grant, OwnerCredential, PermissionLevel } from './vendor/protocol/index.ts'

export interface PasskeyRecord {
  credentialId: string
  /** COSE_Key, base64url. */
  publicKey: string
  algorithm: number
  counter: number
  transports: string[]
  label: string
  createdAt: number
  lastUsedAt: number | null
}

export interface HostRecord {
  hostId: string
  name: string
  /** Raw Ed25519 public key, base64url. */
  publicKey: string
  pairedAt: number
  revokedAt: number | null
}

import type { ClientKind } from './client-policy.ts'
export type { ClientKind }

export interface ClientRecord {
  clientId: string
  name: string
  kind: ClientKind
  /** Verified domain of a CIMD client id, or null. */
  domain: string | null
  redirectHost: string | null
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

/** `none` blocks the client on that host; the others map onto a protocol Grant. */
export type GrantLevel = PermissionLevel | 'none'

export interface GrantSetting {
  clientId: string
  hostId: string
  level: GrantLevel
  overrides: Grant['overrides']
  fullAccessExpiresAt: number | null
}

export interface ClientWithGrants extends ClientRecord {
  grants: GrantSetting[]
}

export interface CallContext {
  ok: boolean
  error?: 'revoked' | 'rate_limited'
  hosts: { hostId: string; name: string }[]
  /** Grant per host; null when the owner blocked the client on that host. */
  grants: Record<string, Grant | null>
}

export interface PairingInfo {
  pairingId: string
  userCode: string
  name: string
  pluginVersion: string
  publicKeyFingerprint: string
  createdAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'denied'
}

export interface DeviceInfo {
  userCode: string
  clientId: string
  scope: string[]
  resource: string
  createdAt: number
  expiresAt: number
  status: 'pending' | 'approved' | 'denied'
}

export type DevicePoll =
  | { status: 'pending' | 'slow_down' | 'denied' | 'expired' | 'invalid' }
  | { status: 'approved'; authCode: string; codeVerifier: string; redirectUri: string; resource: string; clientId: string }

export interface PersonalTokenRecord {
  id: string
  name: string
  scopes: string[]
  createdAt: number
  expiresAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export interface MeterTotals {
  day: string
  workerRequests: number
  durableObjectRequests: number
  kvWrites: number
}

export interface HubState {
  setupComplete: boolean
  passkeys: number
  hosts: number
  allowOtherClients: boolean
  recoveryCodesLeft: number
  /** Devices that receive Web Push notifications. */
  pushDevices: number
}

/** Notification groups a device can switch on or off separately. */
export type PushType = 'attention' | 'tasks' | 'hosts'
export const PUSH_TYPES: readonly PushType[] = ['attention', 'tasks', 'hosts']

/** One thing worth a notification. No conversation content: kind, host name, a short redacted title, a hub path. */
export interface PushEvent {
  type: PushType | 'test'
  kind: 'question' | 'plan-review' | 'approval' | 'task-completed' | 'task-failed' | 'host-offline' | 'host-online' | 'test'
  hostId: string | null
  /** The host's approved display name. */
  host: string
  /** At most 80 characters, already passed through pushText(). */
  title: string
  /** A path on the hub, opened when the notification is tapped. */
  url: string
  expiresAt?: number | null
}

export interface PushDevice {
  id: string
  endpoint: string
  label: string
  types: PushType[]
  createdAt: number
  lastSentAt: number | null
  lastError: string | null
}

export interface PushOutcome {
  sent: number
  dropped: number
  removed: number
  failed: number
}

export type { OwnerCredential }
