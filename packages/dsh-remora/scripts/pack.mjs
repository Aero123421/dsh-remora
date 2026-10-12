// Packs the plugin for GitHub Releases: artifacts/dsh-remora-<version>.tgz
// plus SHA256SUMS. The packed package.json is stripped of scripts and
// devDependencies, so installing it never runs code and never resolves a
// workspace-only package.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(root, '../../artifacts')
const stage = resolve(artifacts, 'stage')
const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

await rm(stage, { recursive: true, force: true })
await mkdir(stage, { recursive: true })
for (const entry of [...manifest.files, 'package.json']) await cp(resolve(root, entry), resolve(stage, entry), { recursive: true })

const { scripts, devDependencies, ...published } = manifest
if (published.dependencies && Object.keys(published.dependencies).length > 0) throw new Error('the plugin must not have runtime dependencies')
await writeFile(resolve(stage, 'package.json'), `${JSON.stringify(published, null, 2)}\n`)

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(npm, ['pack', '--pack-destination', artifacts], { cwd: stage, stdio: 'inherit', shell: process.platform === 'win32' })
if (result.status !== 0) process.exit(result.status ?? 1)
await rm(stage, { recursive: true, force: true })

const filename = `${manifest.name}-${manifest.version}.tgz`
const hash = createHash('sha256').update(await readFile(resolve(artifacts, filename))).digest('hex')
await writeFile(resolve(artifacts, 'SHA256SUMS'), `${hash}  ${filename}\n`)
console.log(`${filename}  sha256 ${hash}`)
