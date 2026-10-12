/**
 * The single hub-wide Durable Object: owner, passkeys, paired hosts, OAuth
 * clients and their grants. Conversation content is never stored here.
 */
import { DurableObject } from 'cloudflare:workers'

export interface HubStatus {
  setupComplete: boolean
  hosts: number
}

export class HubDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS passkeys (
          credential_id TEXT PRIMARY KEY,
          public_key BLOB NOT NULL,
          sign_count INTEGER NOT NULL DEFAULT 0,
          label TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hosts (
          host_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          public_key BLOB NOT NULL,
          paired_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS clients (
          client_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS grants (
          client_id TEXT NOT NULL,
          host_id TEXT NOT NULL,
          level TEXT NOT NULL,
          overrides TEXT NOT NULL DEFAULT '{}',
          full_access_expires_at INTEGER,
          PRIMARY KEY (client_id, host_id)
        );
      `)
    })
  }

  async status(): Promise<HubStatus> {
    const sql = this.ctx.storage.sql
    const passkeys = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM passkeys').one().n
    const hosts = sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM hosts WHERE revoked_at IS NULL').one().n
    return { setupComplete: passkeys > 0, hosts }
  }
}
