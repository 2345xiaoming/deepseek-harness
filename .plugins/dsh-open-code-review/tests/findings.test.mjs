/**
 * Findings wire contract tests: the shared endpoint path and the finding-line
 * format both faces render through.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FINDINGS_API_PREFIX, FINDINGS_LAST_RUN_PATH, findingLine } from '../lib/findings.js'

test('the last-run path is the registered prefix plus its endpoint', () => {
  assert.equal(FINDINGS_LAST_RUN_PATH, `${FINDINGS_API_PREFIX}/last-run`)
})

test('findingLine renders path, line range, category, and content', () => {
  assert.equal(
    findingLine({ path: 'a.ts', startLine: 12, endLine: 14, category: 'bug', content: 'oops', positionVerified: true }, ' [uv]'),
    'a.ts:12-14 [bug] oops',
  )
})

test('findingLine marks unverified positions and defaults the category', () => {
  assert.equal(
    findingLine({ path: 'b.ts', content: 'x', positionVerified: false }, ' [uv]'),
    'b.ts [other] [uv] x',
  )
  assert.equal(findingLine({ path: 'b.ts', startLine: 3, content: 'x' }, ' [uv]'), 'b.ts:3 [other] x')
})
