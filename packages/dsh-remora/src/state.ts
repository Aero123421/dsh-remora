/**
 * The plugin's own state, shown on the DSH settings tab.
 *
 * P0 scaffold: kept in memory. Persisting it (with a schema version, since
 * DSH storage has no migrations) and the host key in `ctx.credentials` come
 * with the pairing work.
 */
import { PROTOCOL_VERSION, type PermissionLevel } from '@dsh-remora/protocol'
import { PLUGIN_VERSION } from './dsh.ts'
import { detectFeatures, type FeatureReport } from './features.ts'

export interface RemoraSnapshot {
  version: string
  protocol: number
  hub: { url: string | null; paired: boolean; connected: boolean }
  permission: { level: PermissionLevel; fullAccessExpiresAt: number | null }
  /** When on, every request from outside is refused and the hub connection is dropped. */
  killSwitch: boolean
  features: FeatureReport
}

export class RemoraState {
  private hubUrl: string | null = null
  private level: PermissionLevel = 'view'
  private fullAccessExpiresAt: number | null = null
  private killSwitch = false
  private readonly has: (service: string) => boolean

  constructor(has: (service: string) => boolean) {
    this.has = has
  }

  snapshot(): RemoraSnapshot {
    return {
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      hub: { url: this.hubUrl, paired: false, connected: false },
      permission: { level: this.level, fullAccessExpiresAt: this.fullAccessExpiresAt },
      killSwitch: this.killSwitch,
      features: detectFeatures(this.has),
    }
  }

  /** Turning the kill switch on only ever lowers what outsiders can do, so it needs no extra confirmation. */
  setKillSwitch(on: boolean): RemoraSnapshot {
    this.killSwitch = on
    return this.snapshot()
  }
}
