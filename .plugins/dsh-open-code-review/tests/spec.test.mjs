/**
 * Spec assembly tests through the doors: exclusion precedence (one home in
 * spec.ts), diff fabrication for untracked targets, scan bounds failing loud,
 * and the regression that rule groups never name files a run excluded.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exclusionReasonFor, planDiffSpec, assembleDiffRun, assembleScanRun, assembleRules, syntheticDiff } from '../lib/spec.js'

const run = promisify(execFile)

async function scratch() {
  const repo = await mkdtemp(join(tmpdir(), 'ocr-spec-'))
  const git = async (...args) => (await run('git', args, { cwd: repo })).stdout
  await git('init', '-q', '-b', 'main', '.')
  await git('config', 'user.email', 'p@x')
  await git('config', 'user.name', 'p')
  return { repo, git }
}

const noExclude = []
const defaultPolicy = { exclude: noExclude, ruleFile: '.opencodereview/rule.json', systemRules: true }

test('exclusionReasonFor: project exclude wins outright, include bypasses configured exclude', () => {
  const policy = { exclude: ['vendor/*'], include: ['vendor/keep-me.ts'], projectExclude: ['vendor/never.*'] }
  assert.equal(exclusionReasonFor('vendor/never.ts', policy), 'excluded by project rule file')
  assert.equal(exclusionReasonFor('vendor/keep-me.ts', policy), undefined)
  assert.equal(exclusionReasonFor('vendor/drop.ts', policy), 'excluded by pattern vendor/*')
  assert.equal(exclusionReasonFor('src/app.ts', policy), undefined)
})

test('syntheticDiff counts lines and builds an all-added diff', () => {
  const built = syntheticDiff('x.ts', 'a\nb\n')
  assert.equal(built.insertions, 2)
  assert.ok(built.diff.startsWith('--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n'))
  assert.equal(syntheticDiff('e.ts', '').insertions, 0)
})

test('planDiffSpec selects raw paths with honest untracked counts', async () => {
  const { repo, git } = await scratch()
  try {
    await writeFile(join(repo, 'keep.ts'), 'x\n')
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    await writeFile(join(repo, '日本.go'), 'package main\n')
    const spec = await planDiffSpec({ repo, mode: 'workspace', refs: {}, ...defaultPolicy })
    assert.deepEqual(spec.targets.map(t => t.path), ['日本.go'])
    assert.equal(spec.targets[0]?.insertions, 1)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('assembleDiffRun fabricates diffs for untracked targets', async () => {
  const { repo, git } = await scratch()
  try {
    await git('commit', '-qm', 'base', '--allow-empty')
    await writeFile(join(repo, 'fresh.txt'), 'one\ntwo\n')
    const run1 = await assembleDiffRun({ repo, mode: 'workspace', refs: {}, ...defaultPolicy })
    assert.equal(run1.diffs.get('fresh.txt')?.includes('+one'), true)
    assert.equal(run1.spec.targets[0]?.insertions, 2)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('assembleScanRun excludes binaries but keeps rule groups aligned with targets', async () => {
  const { repo, git } = await scratch()
  try {
    await writeFile(join(repo, 'a.ts'), 'code\n')
    await writeFile(join(repo, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    const scan = await assembleScanRun({ repo, paths: ['a.ts', 'pic.png'], ...defaultPolicy })
    assert.deepEqual(scan.spec.targets.map(t => t.path), ['a.ts'])
    assert.ok(scan.spec.excluded.some(e => e.path === 'pic.png' && e.reason === 'binary file'))
    // Regression: rule groups resolve only over kept targets.
    for (const group of scan.spec.ruleGroups) {
      for (const file of group.files) assert.ok(scan.spec.targets.some(t => t.path === file))
    }
    assert.equal(scan.diffs.get('a.ts')?.includes('+code'), true)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('assembleScanRun fails loud on empty matches and honors the scan cap', async () => {
  const { repo, git } = await scratch()
  try {
    await writeFile(join(repo, 'seed.txt'), 's\n')
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    await assert.rejects(assembleScanRun({ repo, paths: ['nope/*.ts'], ...defaultPolicy }), /matched no tracked file/)
    for (let i = 0; i < 201; i += 1) {
      await writeFile(join(repo, `f${i}.txt`), 'x\n')
    }
    await git('add', '-A')
    await assert.rejects(assembleScanRun({ repo, paths: [], ...defaultPolicy }), /exceed the scan cap/)
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('assembleScanRun honors the rule file include/exclude layers', async () => {
  const { repo, git } = await scratch()
  try {
    await mkdir(join(repo, '.opencodereview'))
    await writeFile(join(repo, '.opencodereview/rule.json'), JSON.stringify({
      rules: [],
      exclude: ['vendor/never.*'],
      include: ['vendor/keep-me.ts'],
    }))
    await mkdir(join(repo, 'vendor'))
    await writeFile(join(repo, 'vendor/keep-me.ts'), 'k\n')
    await writeFile(join(repo, 'vendor/drop.ts'), 'd\n')
    await writeFile(join(repo, 'vendor/never.ts'), 'n\n')
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    const scan = await assembleScanRun({
      repo,
      paths: ['vendor'],
      exclude: ['vendor/*'],
      ruleFile: '.opencodereview/rule.json',
      systemRules: true,
    })
    assert.deepEqual(scan.spec.targets.map(t => t.path).sort(), ['vendor/keep-me.ts'])
    const reasons = new Map(scan.spec.excluded.map(e => [e.path, e.reason]))
    assert.equal(reasons.get('vendor/never.ts'), 'excluded by project rule file')
    assert.equal(reasons.get('vendor/drop.ts'), 'excluded by pattern vendor/*')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('assembleRules resolves groups for unmodified paths', async () => {
  const { repo, git } = await scratch()
  try {
    await writeFile(join(repo, 'mod.ts'), 'x\n')
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    const report = await assembleRules({
      repo,
      paths: ['unchanged/a.ts', 'notes/plan.java'],
      ruleFile: '.opencodereview/rule.json',
      systemRules: true,
    })
    assert.ok(report.repo.length > 0)
    const langs = report.ruleGroups.map(g => g.pattern).sort()
    assert.deepEqual(langs, ['**/*.java', '**/*.{ts,js,tsx,jsx,mjs,cjs}'])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})
