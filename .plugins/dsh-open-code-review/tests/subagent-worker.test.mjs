/**
 * Subagent-channel worker tests: rc.2 scopes child tools through Agent Presets,
 * so the adapter selects the configured read-only preset and refuses to run
 * without one (ADR-0002: worker restrictions never degrade).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorker } from '../lib/worker.js'

const SIGNAL = new AbortController().signal
const TASK = { label: 'one', system: 'SYS', user: 'USER', schema: {} }

/** Parent stub: delegation depth 0, no runtime override. */
const PARENT = { options: {}, session: { header: { delegationDepth: 0 } } }

/** Subagent runtime stub recording each activation spec. */
function subagentStub(seen) {
  return {
    startActivation: async (spec) => {
      seen.push(spec)
      return { result: Promise.resolve({ structured: { ok: true }, stopReason: 'stop' }), dispose: async () => {} }
    },
  }
}

test('subagent workers refuse to run without a read-only preset', () => {
  assert.throws(
    () => createWorker({
      kind: 'subagent',
      llm: {},
      subagents: subagentStub([]),
      parent: PARENT,
      subagentProvider: 'spawn',
      maxTokens: 256,
    }),
    /read-only Agent Preset/,
  )
})

test('subagent workers select the configured preset instead of a tool filter', async () => {
  const seen = []
  const worker = createWorker({
    kind: 'subagent',
    llm: {},
    subagents: subagentStub(seen),
    parent: PARENT,
    subagentProvider: 'spawn',
    subagentPreset: 'opencode-review-readonly',
    maxTokens: 256,
  })
  const document = await worker.run(TASK, SIGNAL)
  assert.deepEqual(document, { ok: true })
  assert.equal(seen[0].request.agentPreset, 'opencode-review-readonly')
  assert.equal(seen[0].request.toolFilter, undefined)
})
