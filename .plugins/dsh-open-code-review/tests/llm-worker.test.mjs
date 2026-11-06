/**
 * LLM-channel worker tests: the adapter stamps the observed session id, appends
 * the no-tools channel note, leaves reasoning effort unset by default, and
 * surfaces stream failures instead of reporting unparseable empty output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorker } from '../lib/worker.js'

const SIGNAL = new AbortController().signal

/** Build one llm-channel worker over a scripted stream. */
function workerWith(stream, overrides = {}) {
  return createWorker({
    kind: 'llm',
    llm: { stream },
    route: { provider: 'test', model: 'm' },
    subagentProvider: 'spawn',
    maxTokens: 256,
    ...overrides,
  })
}

const TASK = { label: 'one', system: 'SYS', user: 'USER', schema: {} }

test('llm workers stamp the session id and forbid tool calls in the channel note', async () => {
  const seen = []
  const worker = workerWith(
    (options) => {
      seen.push(options)
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: '{"ok":true}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    { sessionId: 'session-1' },
  )
  const document = await worker.run(TASK, SIGNAL)
  assert.deepEqual(document, { ok: true })
  assert.equal(seen[0].sessionId, 'session-1')
  assert.ok(seen[0].system.includes('carries no tools'))
  assert.equal(seen[0].reasoningEffort, undefined)
})

test('llm workers surface a stream failure instead of unparseable empty output', async () => {
  const worker = workerWith(() => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'boom', status: 429 } } }
  })())
  await assert.rejects(
    worker.run(TASK, SIGNAL),
    /llm worker model call failed on test\/m \(TRANSPORT status=429\): boom/,
  )
})

test('llm workers report the finish reason when the model returns no JSON document', async () => {
  const worker = workerWith(() => (async function* () {
    yield { type: 'text-delta', index: 0, text: 'not json' }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  })())
  await assert.rejects(worker.run(TASK, SIGNAL), /no JSON document in model output \(finish=max-tokens\)/)
})

test('llm workers refuse to run without a captured route', async () => {
  const worker = workerWith(() => { throw new Error('unreachable') }, { route: undefined })
  await assert.rejects(worker.run(TASK, SIGNAL), /no LLM route captured yet/)
})
