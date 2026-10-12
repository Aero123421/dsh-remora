import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where the CLI keeps its settings (hub URL). Tokens go to the OS keychain, falling back to a 0600 file here. */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  if (env.REMORA_CONFIG_DIR) return env.REMORA_CONFIG_DIR
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'remora')
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'remora')
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'remora')
}
