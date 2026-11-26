/**
 * Git and working-tree transport: running git with the delegate-mode plain
 * output contract, NUL-safe parsing of `-z` output (non-ASCII or whitespace
 * paths stay raw), and the two facts callers need — which files a change
 * touches with honest line counts, and one file's diff. Selection policy and
 * diff fabrication are owned by `spec.ts`.
 * @module @dsh-external/dsh-open-code-review/git
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExcludedFile, FileStatus, ReviewMode, ReviewRefs, ReviewTarget } from './types.ts'

const execFileAsync = promisify(execFile)

/** Safety invariant: one git command may not run longer than this. */
const GIT_TIMEOUT_MS = 15_000

/** Safety invariant: one transport command may not buffer more than this. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

/** Binary-diff marker in `--numstat` output. */
const BINARY_FIELD = '-'

/**
 * Run one git command in a repository and return trimmed stdout.
 * @param repo - Absolute repository (or subdirectory) path.
 * @param args - Git arguments; text flags must disable conversion and color.
 * @param signal - Caller cancellation; aborts the child process.
 * @returns Trimmed stdout.
 * @throws The git error, including stderr, when the command fails.
 */
async function git(repo: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('git', ['--no-pager', '-c', 'core.quotePath=false', ...args], {
    cwd: repo,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    signal,
  })
  return stdout.trim()
}

/** Plain-patch flags shared by every diff-producing command. */
const PLAIN_DIFF = ['--no-ext-diff', '--no-textconv', '--no-color']

/**
 * Resolve the repository root for a path.
 * @param repo - Directory inside the repository.
 * @param signal - Caller cancellation.
 * @returns The absolute repository root.
 */
export async function resolveRepoRoot(repo: string, signal?: AbortSignal): Promise<string> {
  return git(repo, ['rev-parse', '--show-toplevel'], signal)
}

/**
 * Resolve the diff base of one commit: its first parent, or undefined for a
 * root commit (whose changes are the whole tree). Merge commits diff against
 * their first parent, matching `git log --first-parent`.
 * @param repo - Repository path.
 * @param commit - Commit-ish to inspect.
 * @param signal - Caller cancellation.
 * @returns The first parent id, or undefined when the commit has no parent.
 */
export async function commitBase(repo: string, commit: string, signal?: AbortSignal): Promise<string | undefined> {
  const out = await git(repo, ['rev-list', '--parents', '-n', '1', commit], signal)
  const parts = out.split(/\s+/).filter(Boolean)
  return parts.length > 1 ? parts[1] : undefined
}

/**
 * Compute the merge base for range selection.
 * @param repo - Repository path.
 * @param from - Source ref (the branch point side).
 * @param to - Target ref being reviewed.
 * @param signal - Caller cancellation.
 * @returns The merge-base commit id.
 */
export async function mergeBase(repo: string, from: string, to: string, signal?: AbortSignal): Promise<string> {
  return git(repo, ['merge-base', from, to], signal)
}

/**
 * List tracked files under the repository (optionally narrowed by pathspecs).
 * @param repo - Repository path.
 * @param paths - Files or directories to resolve; empty lists the repository.
 * @param signal - Caller cancellation.
 * @returns Repository-relative paths of tracked files (unmatched paths yield none).
 */
export async function listTracked(repo: string, paths: string[], signal?: AbortSignal): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['--no-pager', 'ls-files', '-z', ...(paths.length > 0 ? ['--', ...paths] : [])],
    { cwd: repo, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, signal },
  )
  return stdout.split('\0').filter(Boolean)
}

/**
 * Split file content into lines: a trailing newline ends the last line rather
 * than starting an empty one. Shared by selection counting and fabrication.
 * @param content - Full UTF-8 file content.
 * @returns The content lines (empty array for empty content).
 */
export function splitContentLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length === 1 && lines[0] === '') return []
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** One raw `--name-status -z` row before status mapping. */
export interface NameStatusRow {
  code: string
  path: string
  oldPath?: string
}

/**
 * Parse `--name-status -z` output: NUL-separated `code\0path\0` records, with
 * rename/copy rows carrying `code\0old\0new\0`.
 * @param stdout - Raw command output.
 * @returns Raw rows in output order.
 */
export function parseNameStatusZ(stdout: string): NameStatusRow[] {
  const rows: NameStatusRow[] = []
  const tokens = stdout.split('\0')
  let i = 0
  while (i < tokens.length) {
    const code = tokens[i]!
    if (code === '') {
      i += 1
      continue
    }
    const kind = code[0]!
    if (kind === 'R' || kind === 'C') {
      const oldPath = tokens[i + 1]
      const path = tokens[i + 2]
      if (path === undefined || oldPath === undefined) break
      rows.push({ code, path, ...(kind === 'R' ? { oldPath } : {}) })
      i += 3
    } else {
      const path = tokens[i + 1]
      if (path === undefined) break
      rows.push({ code, path })
      i += 2
    }
  }
  return rows
}

/** Per-path line counts parsed from one numstat run. */
export interface NumstatEntry {
  insertions: number
  deletions: number
  binary: boolean
}

/**
 * Parse `--numstat -z` output: `added\tdeleted\tpath\0` records, with rename
 * and copy rows carrying an empty path field followed by `old\0new\0`.
 * @param stdout - Raw command output.
 * @returns Counts keyed by the NEW file path.
 */
export function parseNumstatZ(stdout: string): Map<string, NumstatEntry> {
  const counts = new Map<string, NumstatEntry>()
  const tokens = stdout.split('\0')
  let i = 0
  while (i < tokens.length) {
    const record = tokens[i]!
    if (record === '') {
      i += 1
      continue
    }
    const fields = record.split('\t')
    const add = fields[0] ?? BINARY_FIELD
    const del = fields[1] ?? BINARY_FIELD
    const path = fields.slice(2).join('\t')
    const binary = add === BINARY_FIELD || del === BINARY_FIELD
    const entry: NumstatEntry = {
      insertions: binary ? 0 : Number(add),
      deletions: binary ? 0 : Number(del),
      binary,
    }
    if (path === '') {
      // Rename/copy: the next two tokens are the old and new paths.
      const oldPath = tokens[i + 1]
      const newPath = tokens[i + 2]
      if (oldPath !== undefined && newPath !== undefined) {
        counts.set(newPath, entry)
        i += 3
        continue
      }
    } else {
      counts.set(path, entry)
    }
    i += 1
  }
  return counts
}

/** Map one `--name-status` code to a review status, or a disposition word. */
function statusCode(code: string): FileStatus | 'unmerged' | 'unsupported' {
  const kind = code[0]
  if (kind === 'A' || kind === 'C') return 'added'
  if (kind === 'M' || kind === 'T') return 'modified'
  if (kind === 'D') return 'deleted'
  if (kind === 'R') return 'renamed'
  if (kind === 'U') return 'unmerged'
  return 'unsupported'
}

/** Caller-supplied exclusion decision: a reason string drops the file. */
export type ExclusionPredicate = (path: string) => string | undefined

/** Selection input shared by every mode. */
export interface SelectionInput {
  repo: string
  mode: ReviewMode
  refs: ReviewRefs
  /** Exclusion decision owned by the caller (the spec module). */
  isExcluded: ExclusionPredicate
  signal?: AbortSignal
}

/** Selection result: reviewable targets plus excluded files with reasons. */
export interface Selection {
  targets: ReviewTarget[]
  excluded: ExcludedFile[]
}

/**
 * Select reviewable files for the requested mode: workspace covers staged +
 * unstaged tracked changes and untracked files (with honest line counts);
 * range diffs `mergeBase..to`; commit diffs `mergeBase..commit` (first
 * parent), or the whole tree for a root commit. Binary diffs and unmerged
 * paths are excluded with a reason, and unsupported change codes are never
 * dropped silently. The exclusion decision is the caller's predicate.
 * @param input - Repository, mode, refs, and exclusion predicate.
 * @returns Targets and excluded files with reasons.
 */
export async function selectTargets(input: SelectionInput): Promise<Selection> {
  const { repo, mode, refs, isExcluded, signal } = input
  const rows: NameStatusRow[] = []
  const counts = new Map<string, NumstatEntry>()
  let untracked: string[] = []

  const collect = async (args: string[]): Promise<void> => {
    rows.push(...parseNameStatusZ(await git(repo, ['diff', '-M', '--name-status', '-z', ...PLAIN_DIFF, ...args], signal)))
    for (const [path, entry] of parseNumstatZ(await git(repo, ['diff', '-M', '--numstat', '-z', ...PLAIN_DIFF, ...args], signal))) {
      counts.set(path, entry)
    }
  }

  if (mode === 'commit') {
    const commit = refs.commit ?? 'HEAD'
    if (refs.mergeBase !== undefined) {
      await collect([`${refs.mergeBase}..${commit}`])
    } else {
      // Root commit: the tree against the empty tree is `git show`'s output.
      rows.push(...parseNameStatusZ(await git(repo, ['show', '--format=', '-M', '--name-status', '-z', ...PLAIN_DIFF, commit], signal)))
      for (const [path, entry] of parseNumstatZ(await git(repo, ['show', '--format=', '-M', '--numstat', '-z', ...PLAIN_DIFF, commit], signal))) {
        counts.set(path, entry)
      }
    }
  } else if (mode === 'range') {
    await collect([`${refs.mergeBase}..${refs.to}`])
  } else {
    await collect(['HEAD'])
    const raw = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'], signal)
    untracked = raw.split('\0').filter(Boolean)
  }

  const selection: Selection = { targets: [], excluded: [] }
  const push = (path: string, status: FileStatus, oldPath?: string, insertionsOverride?: number): void => {
    const reason = isExcluded(path)
    if (reason !== undefined) {
      selection.excluded.push({ path, reason })
      return
    }
    const entry = counts.get(path)
    if (entry?.binary) {
      selection.excluded.push({ path, reason: 'binary diff' })
      return
    }
    selection.targets.push({
      path,
      status,
      insertions: insertionsOverride ?? entry?.insertions ?? 0,
      deletions: entry?.deletions ?? 0,
      ...(oldPath !== undefined ? { oldPath } : {}),
    })
  }

  for (const row of rows) {
    const status = statusCode(row.code)
    if (status === 'unmerged') {
      selection.excluded.push({ path: row.path, reason: 'unmerged path (resolve conflicts first)' })
      continue
    }
    if (status === 'unsupported') {
      selection.excluded.push({ path: row.path, reason: `unsupported change code ${row.code}` })
      continue
    }
    push(row.path, status, row.oldPath)
  }
  for (const path of untracked) {
    // Untracked files have no numstat row: count their real lines so the
    // preview shows honest numbers.
    let insertions = 0
    try {
      const content = await readFile(join(repo, path), { encoding: 'utf8', signal })
      insertions = splitContentLines(content).length
    } catch {
      insertions = 0
    }
    push(path, 'added', undefined, insertions)
  }
  return selection
}

/**
 * Extract one file's plain unified diff for the selected change. Deleted
 * files yield their deletion diff; commit mode diffs `mergeBase..commit` when
 * a first parent is known, else the whole tree (root commit). A tracked file
 * with no diff — untracked or otherwise unchanged to git — returns the empty
 * string; fabricating its all-added diff is the caller's job.
 * @param input - Repository, mode, refs, and the target path.
 * @param path - Repository-relative file path.
 * @param signal - Caller cancellation.
 * @returns The unified diff text (empty string when git shows no diff).
 */
export async function extractDiff(
  input: { repo: string; mode: ReviewMode; refs: ReviewRefs },
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const { repo, mode, refs } = input
  if (mode === 'commit') {
    const commit = refs.commit ?? 'HEAD'
    if (refs.mergeBase !== undefined) {
      return git(repo, ['diff', ...PLAIN_DIFF, `${refs.mergeBase}..${commit}`, '--', path], signal)
    }
    return git(repo, ['show', '--format=', ...PLAIN_DIFF, commit, '--', path], signal)
  }
  if (mode === 'range') {
    return git(repo, ['diff', ...PLAIN_DIFF, `${refs.mergeBase}..${refs.to}`, '--', path], signal)
  }
  return git(repo, ['diff', ...PLAIN_DIFF, 'HEAD', '--', path], signal)
}
