import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latestSupportedTag, releaseMatrix } from './releases.mjs'

const range = '>=0.2.1-alpha.2 <0.2.2-0'
test('matrix gates minimum and latest supported RC, excluding future releases', () => {
  assert.deepEqual(releaseMatrix(['0.3.0', '0.2.1-rc.2', '0.2.1-alpha.2', '0.2.2-alpha.1', '0.2.1-alpha.10', 'garbage'], range), ['0.2.1-alpha.2', '0.2.1-rc.2'])
})
test('matrix deduplicates a sole version and refuses an unpublished minimum', () => {
  assert.deepEqual(releaseMatrix(['0.2.1-alpha.2'], range), ['0.2.1-alpha.2'])
  assert.throws(() => releaseMatrix(['0.2.1-rc.2'], range), /not published/)
})
test('public tags include RC and peel annotated tags regardless of listing order', () => {
  const tag = (char, version, peeled = '') => `${char.repeat(40)}\trefs/tags/dsh-v${version}${peeled}`
  const listing = [tag('a', '0.2.1-alpha.10'), tag('b', '0.2.1-rc.2', '^{}'), tag('c', '0.2.1-rc.2'), tag('d', '0.2.2-alpha.1')].join('\n')
  assert.deepEqual(latestSupportedTag(listing, range), { version: '0.2.1-rc.2', commit: 'b'.repeat(40) })
  assert.throws(() => latestSupportedTag(tag('d', '0.2.2-alpha.1'), range), /No public DSH tag/)
})
