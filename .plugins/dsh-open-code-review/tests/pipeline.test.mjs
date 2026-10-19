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

/** A fake review worker: scripted per task kind, records the tasks it saw. */
function fakeWorker(kind, script) {
  const calls = []
  return {
    kind,
    calls,
    async run(task) {
      calls.push(task)
      const key = task.label.includes('filter') ? 'filter'
        : task.label.includes('plan') ? 'plan'
          : task.label.includes('relocate') ? 'relocate'
            : 'review'
      const queue = script[key]
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

/* ───────────────────────── plan phase (ported plan task) ───────────────────────── */

test('plan guidance reaches the review worker prompt', async () => {
  const spec = specFor(['a.ts'], [{ id: 1, label: 'one', files: ['a.ts'] }])
  const worker = fakeWorker('llm', {
    plan: {
      summary: 'tightens the parser',
      issues: [{ severity: 'high', description: 'off-by-one in the loop', tool_plan: ['read a.ts — confirm the bound'] }],
    },
    review: { comments: [] },
    filter: { approve_all: true },
  })
  const result = await run(spec, worker, { plan: true })
  const reviewTask = worker.calls.find(call => call.label.startsWith('ocr review bundle'))
  assert.ok(reviewTask.user.includes('### Review Plan'))
  assert.ok(reviewTask.user.includes('Summary: tightens the parser'))
  assert.ok(reviewTask.user.includes('1. [high] off-by-one in the loop'))
  assert.ok(reviewTask.user.includes('→ read a.ts — confirm the bound'))
  assert.equal(result.stats.planRuns, 1)
})

test('a failed plan is fail-open: the review still runs without guidance', async () => {
  const spec = specFor(['a.ts'], [{ id: 1, label: 'one', files: ['a.ts'] }])
  const worker = fakeWorker('llm', {
    plan: new Error('planner exploded'),
    review: { comments: [{ path: 'a.ts', content: 'found it' }] },
    filter: { approve_all: true },
  })
  const result = await run(spec, worker, { plan: true })
  assert.equal(result.findings.length, 1)
  assert.equal(result.stats.planRuns, 0)
  assert.equal(result.stats.planFailures, 1)
  assert.ok(result.bundles[0].planError.includes('planner exploded'), 'the swallowed failure is reported')
})

test('planning stays off when disabled', async () => {
  const spec = specFor(['a.ts'], [{ id: 1, label: 'one', files: ['a.ts'] }])
  const worker = fakeWorker('llm', { review: { comments: [] }, filter: { approve_all: true } })
  await run(spec, worker, { plan: false })
  assert.equal(worker.calls.some(call => call.label.includes('plan')), false)
})

/* ────────────────────── LLM relocation fallback ────────────────────── */

const ANCHOR_DIFF = '--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,2 @@\n ctx\n+const added = 1\n'

test('relocation re-anchors a comment the deterministic pass could not place', async () => {
  const spec = specFor(['f.ts'], [{ id: 1, label: 'one', files: ['f.ts'] }])
  const worker = fakeWorker('llm', {
    review: { comments: [{ path: 'f.ts', content: 'this line is wrong' }] },
    relocate: { locations: [{ index: 0, snippet: 'const added = 1' }] },
    filter: { approve_all: true },
  })
  const result = await run(spec, worker, {
    relocation: 'llm',
    diffs: new Map([['f.ts', ANCHOR_DIFF]]),
  })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].positionVerified, true)
  assert.equal(result.findings[0].startLine, 2)
  assert.equal(result.stats.relocated, 1)
})

test('relocation failure leaves positions unchanged (fail-open)', async () => {
  const spec = specFor(['f.ts'], [{ id: 1, label: 'one', files: ['f.ts'] }])
  const worker = fakeWorker('llm', {
    review: { comments: [{ path: 'f.ts', content: 'unplaced' }] },
    relocate: new Error('locator exploded'),
    filter: { approve_all: true },
  })
  const result = await run(spec, worker, { relocation: 'llm', diffs: new Map([['f.ts', ANCHOR_DIFF]]) })
  assert.equal(result.findings[0].positionVerified, false)
  assert.equal(result.stats.relocated, 0)
})

test('a snippet that still does not match stays unverified', async () => {
  const spec = specFor(['f.ts'], [{ id: 1, label: 'one', files: ['f.ts'] }])
  const worker = fakeWorker('llm', {
    review: { comments: [{ path: 'f.ts', content: 'unplaced' }] },
    relocate: { locations: [{ index: 0, snippet: 'not in the diff at all' }] },
    filter: { approve_all: true },
  })
  const result = await run(spec, worker, { relocation: 'llm', diffs: new Map([['f.ts', ANCHOR_DIFF]]) })
  assert.equal(result.findings[0].positionVerified, false)
  assert.equal(result.stats.relocated, 0)
})

test('deterministic-only relocation never calls the locator', async () => {
  const spec = specFor(['f.ts'], [{ id: 1, label: 'one', files: ['f.ts'] }])
  const worker = fakeWorker('llm', {
    review: { comments: [{ path: 'f.ts', content: 'unplaced' }] },
    filter: { approve_all: true },
  })
  await run(spec, worker, { relocation: 'deterministic', diffs: new Map([['f.ts', ANCHOR_DIFF]]) })
  assert.equal(worker.calls.some(call => call.label.includes('relocate')), false)
})
