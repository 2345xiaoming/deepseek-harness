/**
 * Git plumbing tests against real scratch repositories: raw paths under
 * `-z`, rename counts, binary renames, typechange rows, unmerged rows, merge
 * and root commits, and honest untracked line counts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectTargets, commitBase, parseNameStatusZ, parseNumstatZ } from '../lib/git.js'

const run = promisify(execFile)

/** Create a scratch repository with one base commit. */
async function scratch() {
  const repo = await mkdtemp(join(tmpdir(), 'ocr-git-'))
  const git = async (...args) => (await run('git', args, { cwd: repo })).stdout
  await git('init', '-q', '-b', 'main', '.')
  await git('config', 'user.email', 'p@x')
  await git('config', 'user.name', 'p')
  return { repo, git }
}

test('non-ASCII and tab paths stay raw and match exclusion globs', async () => {
  const { repo, git } = await scratch()
  try {
    await writeFile(join(repo, 'ita.txt'), 'x\n')
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    await writeFile(join(repo, '日本.go'), 'package main\n')
    await writeFile(join(repo, 'tab\tname.txt'), 'x\n')

    // ita.txt is committed and unchanged: workspace mode selects only changes.
    const all = await selectTargets({ repo, mode: 'workspace', refs: {}, isExcluded: () => undefined })
    const paths = all.targets.map(t => t.path).sort()
    assert.deepEqual(paths, ['日本.go', 'tab\tname.txt'].sort())

    const filtered = await selectTargets({ repo, mode: 'workspace', refs: {}, isExcluded: path => path.endsWith('.go') ? 'go files' : undefined })
    assert.ok(filtered.targets.every(t => !t.path.endsWith('.go')))
    assert.deepEqual(filtered.excluded.map(e => e.path), ['日本.go'])

  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('untracked files carry honest insertion counts', async () => {
  const { repo, git } = await scratch()
  try {
    await git('commit', '-qm', 'base', '--allow-empty')
    await writeFile(join(repo, 'fresh.txt'), 'a\nb\nc\n')
    const sel = await selectTargets({ repo, mode: 'workspace', refs: {}, isExcluded: () => undefined })
    assert.equal(sel.targets[0]?.insertions, 3)
    assert.equal(sel.targets[0]?.status, 'added')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('rename with a small edit keeps counts and oldPath', async () => {
  const { repo, git } = await scratch()
  try {
    await mkdir(join(repo, 'patches'))
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n'
    await writeFile(join(repo, 'patches/a@1.0.2.patch'), lines)
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    await git('mv', 'patches/a@1.0.2.patch', 'patches/a@1.2.0.patch')
    await writeFile(join(repo, 'patches/a@1.2.0.patch'), lines + 'extra-line\n')

    const sel = await selectTargets({ repo, mode: 'workspace', refs: {}, isExcluded: () => undefined })
    const renamed = sel.targets.find(t => t.status === 'renamed')
    assert.ok(renamed, 'rename row must survive')
    assert.equal(renamed.path, 'patches/a@1.2.0.patch')
    assert.equal(renamed.oldPath, 'patches/a@1.0.2.patch')
    assert.deepEqual([renamed.insertions, renamed.deletions], [1, 0])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('renamed binary files are excluded as binary', async () => {
  const { repo, git } = await scratch()
  try {
    await writeFile(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    await git('mv', 'blob.bin', 'blob2.bin')

    const sel = await selectTargets({ repo, mode: 'workspace', refs: {}, isExcluded: () => undefined })
    assert.ok(sel.targets.every(t => t.path !== 'blob2.bin'))
    assert.ok(sel.excluded.some(e => e.path === 'blob2.bin' && e.reason === 'binary diff'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('typechange rows become reviewable targets, unmerged rows are excluded', async () => {
  const { repo, git } = await scratch()
  try {
    await writeFile(join(repo, 'target.txt'), 't\n')
    await writeFile(join(repo, 'becomes-link'), 'reg\n')
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    await rm(join(repo, 'becomes-link'))
    await symlink('target.txt', join(repo, 'becomes-link'))
    await git('add', '-A')

    const sel = await selectTargets({ repo, mode: 'workspace', refs: {}, isExcluded: () => undefined })
    const t = sel.targets.find(target => target.path === 'becomes-link')
    assert.ok(t, 'typechange must not disappear from selection')
    assert.equal(t.status, 'modified')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('merge commits resolve their first parent and select real targets', async () => {
  const { repo, git } = await scratch()
  try {
    await writeFile(join(repo, 'a.txt'), 'a\n')
    await git('add', '-A')
    await git('commit', '-qm', 'init')
    await git('checkout', '-qb', 'feat')
    await writeFile(join(repo, 'b.txt'), 'b\n')
    await git('add', '-A')
    await git('commit', '-qm', 'feat')
    await git('checkout', '-q', 'main', '-b', 'work')
    await writeFile(join(repo, 'c.txt'), 'c\n')
    await git('add', '-A')
    await git('commit', '-qm', 'work')
    await git('merge', '-q', '--no-ff', 'feat', '-m', 'merge feat')
    const merge = (await git('rev-parse', 'HEAD')).trim()
    const parent = (await git('rev-parse', 'HEAD^1')).trim()

    assert.equal(await commitBase(repo, merge), parent)
    const base = await commitBase(repo, merge)
    const sel = await selectTargets({ repo, mode: 'commit', refs: { commit: merge, mergeBase: base }, isExcluded: () => undefined })
    assert.ok(sel.targets.length > 0, 'first-parent diff must select targets')
    assert.ok(sel.targets.some(t => t.path === 'b.txt'))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('root commits select their whole tree via the show path', async () => {
  const { repo, git } = await scratch()
  try {
    await writeFile(join(repo, 'r.txt'), 'r\n')
    await git('add', '-A')
    await git('commit', '-qm', 'root')
    const root = (await git('rev-parse', 'HEAD')).trim()
    assert.equal(await commitBase(repo, root), undefined)
    const sel = await selectTargets({ repo, mode: 'commit', refs: { commit: root }, isExcluded: () => undefined })
    assert.deepEqual(sel.targets.map(t => t.path), ['r.txt'])
    assert.equal(sel.targets[0]?.status, 'added')
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('-z parsers handle rename records and plain rows', () => {
  assert.deepEqual(parseNameStatusZ('R092\u0000old\u0000new\u0000M\u0000path\u0000'), [
    { code: 'R092', path: 'new', oldPath: 'old' },
    { code: 'M', path: 'path' },
  ])
  const counts = parseNumstatZ('1\t0\t\u0000old\u0000new\u00002\t1\tpath\u0000')
  assert.deepEqual([...counts.keys()].sort(), ['new', 'path'])
  assert.deepEqual([counts.get('new')?.insertions, counts.get('new')?.deletions], [1, 0])
  assert.equal(parseNumstatZ('-\t-\tbin\u0000').get('bin')?.binary, true)
})
