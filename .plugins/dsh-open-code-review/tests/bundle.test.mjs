/**
 * Bundling tests: locale-variant grouping (the `_zh_CN` regression), the
 * per-bundle cap, and conservation (every input in exactly one bundle).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleTargets } from '../lib/bundle.js'

const target = path => ({ path, status: 'modified', insertions: 1, deletions: 0 })

test('resource variants share one bundle, including _zh_CN region tags', () => {
  const bundles = bundleTargets([
    target('src/i18n/messages.properties'),
    target('src/i18n/messages_en.properties'),
    target('src/i18n/messages_zh_CN.properties'),
    target('src/i18n/messages_pt_BR.properties'),
  ])
  assert.equal(bundles.length, 1)
  assert.equal(bundles[0]?.files.length, 4)
})

test('README locale siblings pair', () => {
  const bundles = bundleTargets([target('pkg/README.md'), target('pkg/README.zh.md')])
  assert.equal(bundles.length, 1)
  assert.equal(bundles[0]?.files.length, 2)
})

test('unrelated locale-looking names do not merge across directories', () => {
  // Same-directory files cluster by design (pass 3); isolate the locale key.
  const bundles = bundleTargets([target('src/index.ts'), target('other/index_es_next.ts')])
  assert.equal(bundles.length, 2)
})

test('per-bundle cap is 10 and every file lands in exactly one bundle', () => {
  const files = Array.from({ length: 25 }, (_, i) => `src/dir/file${i}.txt`)
  const bundles = bundleTargets(files.map(target))
  const seen = new Map()
  for (const bundle of bundles) {
    assert.ok(bundle.files.length <= 10, `bundle ${bundle.id} has ${bundle.files.length}`)
    for (const file of bundle.files) {
      seen.set(file, (seen.get(file) ?? 0) + 1)
    }
  }
  assert.equal(seen.size, files.length)
  for (const count of seen.values()) assert.equal(count, 1)
})

test('companions travel with their subject', () => {
  const bundles = bundleTargets([
    target('src/foo.ts'),
    target('src/foo.test.ts'),
    target('src/bar.ts'),
  ])
  const pair = bundles.find(bundle => bundle.files.length === 2)
  assert.ok(pair)
  assert.deepEqual([...pair.files].sort(), ['src/foo.test.ts', 'src/foo.ts'])
})
