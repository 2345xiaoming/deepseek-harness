/**
 * Glob matcher tests: the ported rule map's matching semantics —
 * case-insensitive matching and the documented pattern vocabulary.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { globMatch, globToRegExp } from '../lib/glob.js'

test('rule-map pattern matches conventional names case-insensitively', () => {
  // Upstream lowercases both sides before matching (system_rules.go).
  assert.equal(globMatch('**/*{mapper,dao}*.xml', 'src/main/FooMapper.xml'), true)
  assert.equal(globMatch('**/*{mapper,dao}*.xml', 'src/main/FooDAO.xml'), true)
  assert.equal(globMatch('**/*{mapper,dao}*.xml', 'src/main/foomapper.xml'), true)
  assert.equal(globMatch('**/*{mapper,dao}*.xml', 'src/main/Foo.xml'), false)
})

test('doublestar spans zero or more directory segments', () => {
  assert.equal(globMatch('.github/workflows/**/*.{yaml,yml}', '.github/workflows/release.yml'), true)
  assert.equal(globMatch('.github/workflows/**/*.{yaml,yml}', '.github/workflows/ci/deep/release.yaml'), true)
  assert.equal(globMatch('**/*.go', 'go.mod'), false)
  assert.equal(globMatch('**/*.go', 'internal/x/y.go'), true)
  assert.equal(globMatch('**/*.go', 'internal/x/y.golden'), false)
})

test('brace expansion and question mark', () => {
  assert.equal(globMatch('**/*.{ts,tsx,js}', 'a/b/c.tsx'), true)
  assert.equal(globMatch('**/*.{ts,tsx,js}', 'a/b/c.css'), false)
  assert.equal(globMatch('file?.ts', 'file1.ts'), true)
  assert.equal(globMatch('file?.ts', 'file10.ts'), false)
})

test('character classes match and negate', () => {
  assert.equal(globMatch('file.[ch]', 'file.c'), true)
  assert.equal(globMatch('file.[ch]', 'file.h'), true)
  assert.equal(globMatch('file.[ch]', 'file.o'), false)
  assert.equal(globMatch('file.[!ch]', 'file.o'), true)
  assert.equal(globMatch('file.[!ch]', 'file.c'), false)
  assert.equal(globMatch('file.[a-c]x', 'file.bx'), true)
})

test('patterns are anchored to the whole path', () => {
  assert.equal(globMatch('README.md', 'docs/README.md'), false)
  assert.equal(globMatch('**/README.md', 'docs/README.md'), true)
  assert.equal(globMatch('**/*.properties', 'msg_zh_CN.properties'), true)
})

test('compiled regex is case-insensitive and anchored', () => {
  const re = globToRegExp('**/*.PROPERTIES')
  assert.equal(re.flags.includes('i'), true)
  assert.equal(re.test('a/B/msg.PROPERTIES'), true)
})
