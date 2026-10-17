import { compare, minVersion, satisfies, valid } from 'semver'

export function supportedVersions(versions, range) {
  return [...new Set(versions)].filter(version => valid(version) && satisfies(version, range, { includePrerelease: true })).sort(compare)
}

export function releaseMatrix(versions, range) {
  const supported = supportedVersions(versions, range)
  const minimum = minVersion(range)?.version
  if (!minimum || !supported.includes(minimum)) throw new Error(`Minimum supported DSH ${minimum} is not published`)
  return [...new Set([minimum, supported.at(-1)])]
}

/** Peel annotated tags; never select a future version outside the plugin peer. */
export function latestSupportedTag(listing, range) {
  const tags = new Map()
  for (const line of listing.split('\n')) {
    const [sha, ref] = line.split('\t')
    if (!/^[0-9a-f]{40}$/i.test(sha ?? '') || !ref?.startsWith('refs/tags/dsh-v')) continue
    const version = ref.slice('refs/tags/dsh-v'.length).replace(/\^\{\}$/, '')
    if (!tags.has(version) || ref.endsWith('^{}')) tags.set(version, sha)
  }
  const version = supportedVersions([...tags.keys()], range).at(-1)
  if (!version) throw new Error(`No public DSH tag satisfies ${range}`)
  return { version, commit: tags.get(version) }
}
