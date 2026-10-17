// Runs in repositories created from hub/. No npm install or deployment required.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function parseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(tag)
  if (!match || match[0] !== tag) throw new Error(`Invalid release tag: ${tag}`)
  const pre = match[4]?.split('.') ?? []
  if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) throw new Error(`Invalid release tag: ${tag}`)
  return { core: match.slice(1, 4).map(BigInt), pre }
}

/** Full SemVer precedence without dependencies in a freshly copied hub. */
export function compareReleaseTags(left, right) {
  const a = parseTag(left), b = parseTag(right)
  const compare = (x, y) => x < y ? -1 : x > y ? 1 : 0
  for (let i = 0; i < 3; i++) {
    const order = compare(a.core[i], b.core[i])
    if (order) return order
  }
  if (!a.pre.length || !b.pre.length) return compare(Number(!a.pre.length), Number(!b.pre.length))
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1
    if (b.pre[i] === undefined) return 1
    const x = a.pre[i], y = b.pre[i]
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y)
    const order = xn && yn ? compare(BigInt(x), BigInt(y)) : xn !== yn ? (xn ? -1 : 1) : compare(x, y)
    if (order) return order
  }
  return 0
}

export function syncUpstream({ cwd = process.cwd(), upstream = process.env.UPSTREAM || 'Aero123421/dsh-remora', run = (cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8' }), log = console.log } = {}) {
  function command(cmd, args, allowed = []) {
    const result = run(cmd, args)
    if (result.status !== 0 && !allowed.includes(result.status)) throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr || result.error?.message || result.status}`)
    return result
  }
  const latest = command('gh', ['release', 'view', '--repo', upstream, '--json', 'tagName', '-q', '.tagName']).stdout.trim()
  const current = `v${JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version}`
  if (compareReleaseTags(latest, current) <= 0) {
    log(`Hub ${current} is at or ahead of latest release ${latest}`)
    return
  }
  const branch = `remora-sync/${latest}`
  const exists = command('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], [2]).status === 0
  let kept = false
  if (!exists) {
    const temp = mkdtempSync(join(tmpdir(), 'remora-sync-'))
    try {
      const fresh = join(temp, 'new'), old = join(temp, 'old')
      command('git', ['clone', '--quiet', '--depth', '1', '--branch', latest, `https://github.com/${upstream}`, fresh])
      const base = run('git', ['clone', '--quiet', '--depth', '1', '--branch', current, `https://github.com/${upstream}`, old])
      const localConfig = join(cwd, 'wrangler.jsonc'), oldConfig = join(old, 'hub/wrangler.jsonc')
      // Unknown base can be a main-branch snapshot or an unavailable release tag.
      // Preserve the deployment's configuration whenever comparison is impossible.
      kept = existsSync(localConfig) && (base.status !== 0 || !existsSync(oldConfig) || !readFileSync(localConfig).equals(readFileSync(oldConfig)))
      const savedConfig = join(temp, 'wrangler.local.jsonc')
      if (kept) copyFileSync(localConfig, savedConfig)
      command('rsync', ['-a', '--delete', '--exclude', '.git', `${fresh}/hub/`, `${cwd}/`])
      if (kept) copyFileSync(savedConfig, localConfig)
      command('git', ['config', 'user.name', 'github-actions[bot]'])
      command('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
      command('git', ['switch', '-c', branch])
      command('git', ['add', '-A'])
      if (command('git', ['diff', '--cached', '--quiet'], [1]).status === 0) {
        log('Nothing to update')
        return
      }
      command('git', ['commit', '-m', `Update Remora hub to ${latest}`])
      command('git', ['push', 'origin', branch])
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }
  // A pushed branch and an opened PR are separate operations. Retry PR creation
  // after a permission/API failure even if the previous push already succeeded.
  const prs = JSON.parse(command('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number']).stdout)
  if (prs.length) {
    log(`Pull request for ${branch} already exists`)
    return
  }
  const note = kept || exists ? '\n\nReview wrangler.jsonc before merging. Customized local configuration is preserved; it is also preserved when the old upstream tag is unavailable.' : ''
  command('gh', ['pr', 'create', '--head', branch, '--title', `Update Remora hub to ${latest}`, '--body', `Release notes: https://github.com/${upstream}/releases/tag/${latest}${note}`])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) syncUpstream()
