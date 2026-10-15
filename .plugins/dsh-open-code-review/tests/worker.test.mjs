/**
 * Worker contract tests: the parser admits structured documents at the
 * model-JSON boundary — snake_case mapping, bundle-file containment,
 * vocabulary normalization, and verdict index bounds — with no live model.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeComments, parseFilterVerdict, isSeverity, isCategory } from '../lib/worker.js'

test('normalizeComments maps the wire document to raw comments', () => {
  const raw = {
    comments: [
      {
        path: 'a.ts',
        content: 'broken',
        start_line: 12,
        end_line: 14,
        severity: 'high',
        category: 'bug',
        suggestion: 'fix',
        snippet: 'const x = 1',
      },
    ],
  }
  const out = normalizeComments(raw, ['a.ts'])
  assert.deepEqual(out, [
    {
      path: 'a.ts',
      content: 'broken',
      startLine: 12,
      endLine: 14,
      severity: 'high',
      category: 'bug',
      suggestion: 'fix',
      snippet: 'const x = 1',
    },
  ])
})

test('normalizeComments drops foreign files, malformed entries, and bad vocabularies', () => {
  const raw = {
    comments: [
      { path: 'outside.ts', content: 'not mine' },
      { path: 'a.ts' },
      { content: 'no path' },
      'not-an-object',
      { path: 'a.ts', content: 'ok', severity: 'catastrophic', category: 'vibes', start_line: -3 },
    ],
  }
  const out = normalizeComments(raw, ['a.ts'])
  assert.equal(out.length, 1)
  assert.equal(out[0]?.content, 'ok')
  assert.equal(out[0]?.severity, undefined)
  assert.equal(out[0]?.category, undefined)
  assert.equal(out[0]?.startLine, undefined)
})

test('normalizeComments treats missing or malformed documents as empty', () => {
  assert.deepEqual(normalizeComments(null, []), [])
  assert.deepEqual(normalizeComments({ comments: 'nope' }, []), [])
  assert.deepEqual(normalizeComments({}, []), [])
})

test('parseFilterVerdict keeps only in-bounds removal indices', () => {
  const verdict = parseFilterVerdict(
    { approve_all: false, remove: [{ index: 1 }, { index: 9 }, { index: -1 }, 'x', { index: 0 }] },
    3,
  )
  assert.deepEqual([...verdict.removedIndices].sort(), [0, 1])
})

test('parseFilterVerdict treats approve_all and failures as no removals', () => {
  assert.deepEqual([...parseFilterVerdict({ approve_all: true, remove: [{ index: 0 }] }, 2).removedIndices], [])
  assert.deepEqual([...parseFilterVerdict({ junk: true }, 2).removedIndices], [])
})

test('vocabulary guards accept only the shared lists', () => {
  assert.equal(isSeverity('critical'), true)
  assert.equal(isSeverity('meh'), false)
  assert.equal(isCategory('security'), true)
  assert.equal(isCategory('other'), true)
  assert.equal(isCategory(undefined), false)
})
