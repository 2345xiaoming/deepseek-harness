/**
 * Rule resolution tests: the ported layering contract — project entries
 * replace the system rule by default, `merge_system_rule` keeps both under
 * the upstream template, and malformed entries fail loud.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveRule, groupRules, mergeWithSystemRule, loadRuleConfig } from '../lib/rules.js'
import { RULE_DOCS } from '../lib/assets/rule-docs.js'

const SYSTEM_TS = RULE_DOCS['ts_js_tsx_jsx']

test('project entry replaces the system rule by default', () => {
  const config = { projectRules: [{ path: '**/*.ts', rule: 'MY RULE' }], include: [], exclude: [] }
  const resolved = resolveRule(config, 'src/a.ts', true)
  assert.equal(resolved.text, 'MY RULE')
  assert.equal(resolved.source, 'project')
})

test('merge_system_rule combines system first, user second (upstream template)', () => {
  const config = { projectRules: [{ path: '**/*.ts', rule: 'MY RULE', merge_system_rule: true }], include: [], exclude: [] }
  const resolved = resolveRule(config, 'src/a.ts', true)
  assert.equal(resolved.text, mergeWithSystemRule(SYSTEM_TS, 'MY RULE'))
  assert.ok(resolved.text.startsWith('## System-Specific Rules (Mandatory)'))
  assert.ok(resolved.text.indexOf('MY RULE') > resolved.text.indexOf(SYSTEM_TS))
  assert.ok(resolved.text.includes('## User-Specific Rules (Mandatory)'))
})

test('without a project entry the system map governs, else the default doc', () => {
  const ts = resolveRule({ projectRules: [], include: [], exclude: [] }, 'src/a.ts', true)
  assert.equal(ts.source, 'system')
  assert.equal(ts.text, SYSTEM_TS)
  const unknown = resolveRule({ projectRules: [], include: [], exclude: [] }, 'weird.xyz', true)
  assert.equal(unknown.source, 'default')
})

test('first matching project entry wins in declaration order', () => {
  const config = {
    projectRules: [
      { path: '**/*.ts', rule: 'FIRST' },
      { path: 'src/**', rule: 'SECOND' },
    ],
    include: [],
    exclude: [],
  }
  assert.equal(resolveRule(config, 'src/a.ts', true).text, 'FIRST')
})

test('groupRules groups by source+pattern+text', () => {
  const groups = groupRules({ projectRules: [], include: [], exclude: [] }, ['a.ts', 'b.ts', 'c.java'], true)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0]?.files, ['a.ts', 'b.ts'])
  assert.deepEqual(groups[1]?.files, ['c.java'])
})

test('mergeWithSystemRule degrades to one side when the other is empty', () => {
  assert.equal(mergeWithSystemRule('', 'U'), 'U')
  assert.equal(mergeWithSystemRule('S', ''), 'S')
})

test('a missing rule file is the empty configuration', async () => {
  const config = await loadRuleConfig('/nonexistent-repo', '.opencodereview/rule.json')
  assert.deepEqual(config.projectRules, [])
})

test('validateRuleEntry rejects missing fields (via loadRuleConfig JSON)', async () => {
  const { writeFile, mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'ocr-rules-'))
  await writeFile(join(dir, 'rule.json'), JSON.stringify({ rules: [{ path: '**/*.ts' }] }))
  await assert.rejects(async () => {
    // Re-point the loader at our fixture through a tiny wrapper: the loader
    // reads <repo>/<ruleFile>; pass the fixture dir as repo.
    await loadRuleConfig(dir, 'rule.json')
  }, /rule entry #0: "rule" must be a non-empty string/)
})

test('top-level include/exclude validate as glob lists', async () => {
  const { writeFile, mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'ocr-filters-'))
  await writeFile(join(dir, 'rule.json'), JSON.stringify({
    rules: [],
    include: ['**/generated/**'],
    exclude: ['**/vendor/**'],
  }))
  const config = await loadRuleConfig(dir, 'rule.json')
  assert.deepEqual(config.include, ['**/generated/**'])
  assert.deepEqual(config.exclude, ['**/vendor/**'])

  await writeFile(join(dir, 'rule.json'), JSON.stringify({ rules: [], include: [''] }))
  await assert.rejects(async () => {
    await loadRuleConfig(dir, 'rule.json')
  }, /"include" must be an array of non-empty strings/)
})
