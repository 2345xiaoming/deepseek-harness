/**
 * Tool-adapter tests: a fake ToolHost is the second adapter at the host seam,
 * so the model-facing tool definitions are exercised through the interfaces
 * the model and PTC callers use — argument validation, policy plumbing, and
 * failure containment included.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerOcrTools } from '../lib/tools.js'

const run = promisify(execFile)

async function scratch() {
  const repo = await mkdtemp(join(tmpdir(), 'ocr-tools-'))
  const git = async (...args) => (await run('git', args, { cwd: repo })).stdout
  await git('init', '-q', '-b', 'main', '.')
  await git('config', 'user.email', 'p@x')
  await git('config', 'user.name', 'p')
  await git('commit', '-qm', 'base', '--allow-empty')
  return { repo, git }
}

function fakeHost(configOver = {}) {
  const recorded = []
  return {
    recorded,
    config: {
      worker: 'llm',
      subagentProvider: 'spawn',
      maxTokens: 1000,
      toolTimeoutMs: 60_000,
      concurrency: 2,
      exclude: ['**/skip-me.ts'],
      ruleFile: '.opencodereview/rule.json',
      systemRules: true,
      ...configOver,
    },
    llm: { stream: () => { throw new Error('unreachable: no route in this adapter') } },
    route: () => undefined,
    subagents: () => undefined,
    defaultRepo: async () => '/ignored',
    recordRun: (kind, payload) => { recorded.push({ kind, payload }) },
  }
}

function registerTools(host) {
  const defs = []
  const ctx = { tools: { register: def => { defs.push(def); return () => {} } } }
  const dispose = registerOcrTools(ctx, host)
  const byName = Object.fromEntries(defs.map(def => [def.name, def]))
  return { defs, byName, dispose }
}

const exec = { agent: undefined, signal: new AbortController().signal }

test('four tools register with the cooperative timeout budget', () => {
  const { defs, dispose } = registerTools(fakeHost())
  assert.deepEqual(defs.map(def => def.name).sort(), ['ocr_preview', 'ocr_review', 'ocr_rules', 'ocr_scan'])
  for (const def of defs) assert.equal(def.timeoutMs, 60_000)
  dispose()
  assert.equal(defs.length, 4)
})

test('ocr_preview rejects ambiguous selection arguments', async () => {
  const { byName, dispose } = registerTools(fakeHost())
  await assert.rejects(byName.ocr_preview.execute({ commit: 'x', from: 'a', to: 'b' }, exec), /not both/)
  await assert.rejects(byName.ocr_preview.execute({ repo: '/x', from: 'a' }, exec), /must be provided together/)
  dispose()
})

test('ocr_preview plumbs config exclusions and renders the spec', async () => {
  const { repo, git } = await scratch()
  try {
    await writeFile(join(repo, 'a.ts'), 'x\n')
    await writeFile(join(repo, 'skip-me.ts'), 'y\n')
    const { byName, dispose } = registerTools(fakeHost())
    const value = await byName.ocr_preview.execute({ repo }, exec)
    assert.deepEqual(value.targets.map(t => t.path), ['a.ts'])
    assert.equal(value.excluded[0]?.reason, 'excluded by pattern **/skip-me.ts')
    const text = byName.ocr_preview.output.render({ repo }, value)[0].text
    assert.ok(text.includes('Reviewable files (1)'))
    dispose()
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('ocr_rules resolves checklists through the rules door', async () => {
  const { repo } = await scratch()
  try {
    const { byName, dispose } = registerTools(fakeHost())
    const value = await byName.ocr_rules.execute({ repo, paths: ['a.ts', 'b.ts'] }, exec)
    assert.equal(value.ruleGroups.length, 1)
    const text = byName.ocr_rules.output.render({ repo, paths: [] }, value)[0].text
    assert.ok(text.includes('## Rule group 1'))
    dispose()
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('ocr_review contains worker failures and records the run', async () => {
  const { repo } = await scratch()
  try {
    await writeFile(join(repo, 'changed.ts'), 'x\n')
    const host = fakeHost()
    const { byName, dispose } = registerTools(host)
    const value = await byName.ocr_review.execute({ repo }, exec)
    assert.equal(value.coverage.total, 1)
    assert.equal(value.coverage.reviewed, 0)
    assert.ok(value.coverage.skipped[0]?.reason.includes('no LLM route captured'))
    assert.equal(value.stats.worker, 'llm')
    assert.equal(value.findings.length, 0)
    const text = byName.ocr_review.output.render({ repo }, value)[0].text
    assert.ok(text.includes('worker=llm'), 'runtime stats are model-visible')
    assert.deepEqual(host.recorded.map(entry => entry.kind), ['review'])
    dispose()
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('an explicit subagent channel without a runtime fails loud', async () => {
  const { repo } = await scratch()
  try {
    await writeFile(join(repo, 'changed.ts'), 'x\n')
    const { byName, dispose } = registerTools(fakeHost({ worker: 'subagent' }))
    await assert.rejects(byName.ocr_review.execute({ repo }, exec), /subagent workers requested/)
    dispose()
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('per-call concurrency is validated and bounded', async () => {
  const { repo } = await scratch()
  try {
    await writeFile(join(repo, 'changed.ts'), 'x\n')
    const { byName, dispose } = registerTools(fakeHost())
    await assert.rejects(byName.ocr_review.execute({ repo, concurrency: 0 }, exec), /between 1 and 8/)
    await assert.rejects(byName.ocr_review.execute({ repo, concurrency: 9 }, exec), /between 1 and 8/)
    const value = await byName.ocr_review.execute({ repo, concurrency: 4 }, exec)
    assert.equal(value.coverage.total, 1)
    dispose()
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
