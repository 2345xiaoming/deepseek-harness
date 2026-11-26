/**
 * Relocation tests: snippet matching must be contiguous and prefer the
 * claimed line; line verification must accept changed-hunk context lines and
 * reject ranges that leave the hunk.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { positionComment, changedRanges, addedLines } from '../lib/relocate.js'

const DIFF = [
  '--- a/f.ts', '+++ b/f.ts', '@@ -10,4 +10,5 @@',
  ' const ctxA = 1',      // new line 10 (context)
  '+const added = 2',     // new line 11 (added)
  ' const ctxB = 3',      // new line 12 (context)
  '+const later = 4',     // new line 13 (added)
  ' const ctxC = 5',      // new line 14 (context)
].join('\n')

test('snippet on an added line verifies and reports the matched span', () => {
  const r = positionComment({ path: 'f.ts', content: 'x', snippet: 'const added = 2' }, DIFF)
  assert.equal(r.positionVerified, true)
  assert.equal(r.startLine, 11)
  assert.equal(r.endLine, 11)
})

test('non-contiguous snippet match is rejected (no claimed line to fall back on)', () => {
  // Lines 11 and 13 are both added but line 12 is context: the snippet is not
  // verbatim-contiguous in the file, so it must not be presented as verified.
  const r = positionComment({ path: 'f.ts', content: 'x', snippet: 'const added = 2\nconst later = 4' }, DIFF)
  assert.equal(r.positionVerified, false)
  assert.equal(r.startLine, undefined)
})

test('non-contiguous snippet with a claimed line falls back to line verification', () => {
  const r = positionComment({ path: 'f.ts', content: 'x', snippet: 'const added = 2\nconst later = 4', startLine: 13 }, DIFF)
  assert.equal(r.startLine, 13)
  assert.equal(r.positionVerified, true)
})

test('snippet occurrences pick the one nearest the claimed line', () => {
  const diff = [
    '--- a/f.ts', '+++ b/f.ts', '@@ -1,2 +1,3 @@',
    '+retries += 1',
    ' const a = 1',
    '@@ -40,2 +41,3 @@',
    '+retries += 1',
    ' const b = 2',
  ].join('\n')
  const r = positionComment({ path: 'f.ts', content: 'x', snippet: 'retries += 1', startLine: 41 }, diff)
  assert.equal(r.startLine, 41)
})

test('a context line inside a changed hunk verifies (the documented contract)', () => {
  const diff = [
    '--- a/f.ts', '+++ b/f.ts', '@@ -1,4 +1,4 @@',
    ' const ctxA = 1',   // new line 1 (context inside hunk)
    '-const old = 2',
    '+const new_ = 2',   // new line 2
    ' const ctxB = 3',
  ].join('\n')
  const r = positionComment({ path: 'f.ts', content: 'x', startLine: 1 }, diff)
  assert.equal(r.positionVerified, true)
})

test('a range that leaves the changed hunk is unverified', () => {
  const r = positionComment({ path: 'f.ts', content: 'x', startLine: 11, endLine: 99 }, DIFF)
  assert.equal(r.positionVerified, false)
  assert.equal(r.endLine, 99)
})

test('claimed line outside any changed hunk is unverified', () => {
  const r = positionComment({ path: 'f.ts', content: 'x', startLine: 100 }, DIFF)
  assert.equal(r.positionVerified, false)
})

test('no snippet and no line yields no position', () => {
  const r = positionComment({ path: 'f.ts', content: 'x' }, DIFF)
  assert.equal(r.positionVerified, false)
  assert.equal(r.startLine, undefined)
})

test('changedRanges and addedLines parse multi-hunk diffs', () => {
  assert.deepEqual(changedRanges(DIFF), [{ start: 10, end: 14 }])
  assert.deepEqual(addedLines(DIFF).map(entry => entry.line), [11, 13])
})
