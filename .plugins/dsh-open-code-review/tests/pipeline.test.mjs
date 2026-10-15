/**
 * Orchestration tests through the review worker seam: a fake worker replaces
 * the live model, so run choreography, index-based filter identity, fail-open
 * filtering, coverage accounting, and cancellation are all testable through
 * the interface callers use.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { runReview } from '../lib/pipeline.js'

/** Build a one-bundle spec over the given files with synthetic diffs. */
function specFor(files, bundles) {
  return {
    repo: '/repo',
    mode: 'workspace',
    refs: {},
    targets: files.map(path => ({ path, status: 'modified', insertions: 1, deletions: 0 })),
    excluded: [],
    ruleGroups: [{ id: 1, source: 'system', pattern: '**/*.ts', text: 'RULE', files: [...files] }],
    bundles,
  }
}

/** A fake review worker: scripted per call, records the tasks it saw. */
function fakeWorker(kind, script) {
  const calls = []
  return {
    kind,
    calls,
    async run(task) {
      calls.push(task)
      const isFilter = task.label.startsWith('ocr review filter')
      const queue = isFilter ? script.filter : script.review
      const next = Array.isArray(queue) ? queue.shift() : queue
      if (next instanceof Error) throw next
      return next
    },
  }
}

const run = (spec, worker, extra = {}) => runReview({
  spec,
  worker,
  concurrency: 2,
  now: '2026-01-01T00:00:00Z',
  diffs: new Map(spec.targets.map(t => [t.path, `--- a/${t.path}\n+++ b/${t.path}\n@@ -1,1 +1,1 @@\n+x\n`])),
  signal: new AbortController().signal,
  ...extra,
})

test('a completed bundle reviews its files and reports findings', async () => {
  const spec = specFor(['a.ts'], [{ id: 1, label: 'one', files: ['a.ts'] }])
  const worker = fakeWorker('llm', {
    review: { comments: [{ path: 'a.ts', content: 'issue', severity: 'high', category: 'bug' }] },
    filter: { approve_all: true },
  })
  const result = await run(spec, worker)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].severity, 'high')
  assert.deepEqual(result.coverage, {
    total: 1,
    reviewed: 1,
    skipped: [],
    rate: 1,
  })
  assert.equal(result.stats.worker, 'llm')
  assert.equal(result.stats.filterRuns, 1)
})

test('filter identity is the batch index: identical comments do not share fate', async () => {
  const spec = specFor(['a.ts'], [{ id: 1, label: 'one', files: ['a.ts'] }])
  const worker = fakeWorker('llm', {
    // Two identical comments: the old path+content identity killed both.
    review: {
      comments: [
        { path: 'a.ts', content: 'dup' },
        { path: 'a.ts', content: 'dup' },
      ],
    },
    filter: { approve_all: false, remove: [{ index: 1, reason: 'Ground B' }] },
  })
  const result = await run(spec, worker)
  assert.equal(result.findings.length, 1)
  assert.equal(result.filteredCount, 1)
})

test('a failed filter fails open and never destroys findings', async () => {
  const spec = specFor(['a.ts'], [{ id: 1, label: 'one', files: ['a.ts'] }])
  const worker = fakeWorker('llm', {
    review: { comments: [{ path: 'a.ts', content: 'keep me' }] },
    filter: new Error('filter exploded'),
  })
  const result = await run(spec, worker)
  assert.equal(result.findings.length, 1)
  assert.equal(result.filteredCount, 0)
})

test('a failed bundle skips its files with a reason; others stay reviewed', async () => {
  const spec = specFor(
    ['a.ts', 'b.ts'],
    [{ id: 1, label: 'one', files: ['a.ts'] }, { id: 2, label: 'two', files: ['b.ts'] }],
  )
  const worker = fakeWorker('llm', {
    review: [{ comments: [] }, new Error('worker died')],
    filter: { approve_all: true },
  })
  const result = await run(spec, worker)
  assert.deepEqual(result.coverage, {
    total: 2,
    reviewed: 1,
    skipped: [{ path: 'b.ts', reason: 'worker failed: Error: worker died' }],
    rate: 0.5,
  })
  assert.equal(result.bundles.find(b => b.id === 2).status, 'skipped')
})

test('cancellation rejects instead of returning an empty success', async () => {
  const spec = specFor(['a.ts'], [{ id: 1, label: 'one', files: ['a.ts'] }])
  const worker = fakeWorker('llm', { review: { comments: [] }, filter: { approve_all: true } })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(run(spec, worker, { signal: controller.signal }), /cancelled/)
})

test('filter runs only when comments exist', async () => {
  const spec = specFor(['a.ts'], [{ id: 1, label: 'one', files: ['a.ts'] }])
  const worker = fakeWorker('subagent', { review: { comments: [] }, filter: new Error('must not run') })
  const result = await run(spec, worker)
  assert.equal(result.stats.filterRuns, 0)
  assert.equal(result.stats.worker, 'subagent')
})
