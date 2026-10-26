/**
 * Review Run assembly: one home for "turn a repository and a policy into
 * review material". Doors: {@link planDiffSpec} builds the selection preview,
 * {@link assembleDiffRun} the review run, {@link assembleScanRun} the
 * whole-file audit run, {@link assembleRules} the rule-only run. A
 * {@link ReviewRun} is a {@link ReviewSpec} plus the diff of every target —
 * complete material, no further repository reads.
 *
 * Exclusion precedence is owned here: the project rule file's `exclude` wins
 * outright; a match on the configured exclusion list drops the file unless an
 * `include` glob bypasses it — a bypass is not a whitelist.
 * @module @dsh-external/dsh-open-code-review/spec
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExcludedFile, ReviewMode, ReviewRefs, ReviewSpec, ReviewTarget, RuleGroup } from './types.ts'
import { commitBase, extractDiff, listTracked, mergeBase, resolveRepoRoot, selectTargets, splitContentLines } from './git.ts'
import type { ExclusionPredicate } from './git.ts'
import { groupRules, loadRuleConfig } from './rules.ts'
import type { RuleConfig } from './rules.ts'
import { bundleTargets } from './bundle.ts'
import { globMatch } from './glob.ts'

/** Safety invariant: a scan run lists at most this many tracked files. */
const MAX_SCAN_FILES = 200

/** Safety invariant: a scan run reads at most this many bytes per file. */
const MAX_SCAN_BYTES = 2 * 1024 * 1024

/** Binary file extensions the scan never reads as text. */
const BINARY_EXTENSIONS = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|jar|class|woff2?|ttf|otf|eot|mp[34]|webm|wasm|node|so|dylib|dll|exe|bin|snap|o|a|lib|pyc)$/i

/**
 * The material for one review run: a review spec plus the diff of every
 * target.
 */
export interface ReviewRun {
  spec: ReviewSpec
  /** Repository-relative paths of every spec target → its diff. */
  diffs: Map<string, string>
}

/** Repository, exclusion list, and rule-file policy shared by every door. */
export interface AssemblyInput {
  repo: string
  /** Exclusion globs; the rule file's include/exclude layers compose with it. */
  exclude: string[]
  ruleFile: string
  systemRules: boolean
  signal?: AbortSignal
}

/** Input for {@link planDiffSpec} and {@link assembleDiffRun}. */
export interface DiffRunInput extends AssemblyInput {
  mode: ReviewMode
  refs: ReviewRefs
}

/** Input for {@link assembleScanRun}. */
export interface ScanRunInput extends AssemblyInput {
  /** Files or directories to scan; empty lists the whole repository. */
  paths: string[]
}

/** Report returned by {@link assembleRules}. */
export interface RulesReport {
  repo: string
  ruleGroups: RuleGroup[]
}

/** Exclusion layers in the precedence order owned by this module. */
export interface ExclusionPolicy {
  /** Configured exclusion globs; bypassable by `include`. */
  exclude: string[]
  /** Globs that bypass `exclude` (a bypass, not a whitelist). */
  include?: string[]
  /** Rule-file `exclude` globs: highest precedence, never bypassed. */
  projectExclude?: string[]
}

/**
 * Resolve one path's exclusion disposition under the precedence contract
 * (module doc).
 * @param path - Repository-relative file path.
 * @param policy - The exclusion layers.
 * @returns The exclusion reason, or undefined when the file is reviewable.
 */
export function exclusionReasonFor(path: string, policy: ExclusionPolicy): string | undefined {
  for (const pattern of policy.projectExclude ?? []) {
    if (globMatch(pattern, path)) return 'excluded by project rule file'
  }
  for (const pattern of policy.exclude) {
    if (globMatch(pattern, path) && !(policy.include ?? []).some(candidate => globMatch(candidate, path))) {
      return `excluded by pattern ${pattern}`
    }
  }
  return undefined
}

/** A repository opened for assembly: root, rule configuration, and predicate. */
interface OpenedRepo {
  root: string
  ruleConfig: RuleConfig
  systemRules: boolean
  isExcluded: ExclusionPredicate
  signal?: AbortSignal
}

/** Resolve the root, load the rule configuration, and compose the predicate. */
async function openRepo(input: AssemblyInput): Promise<OpenedRepo> {
  const root = await resolveRepoRoot(input.repo, input.signal)
  const ruleConfig = await loadRuleConfig(root, input.ruleFile, input.signal)
  return {
    root,
    ruleConfig,
    systemRules: input.systemRules,
    isExcluded: path => exclusionReasonFor(path, {
      exclude: input.exclude,
      include: ruleConfig.include,
      projectExclude: ruleConfig.exclude,
    }),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  }
}

/** Build the finished spec over kept targets: rules and bundles after pruning. */
function composeSpec(opened: OpenedRepo, targets: ReviewTarget[], excluded: ExcludedFile[], mode: ReviewMode, refs: ReviewRefs): ReviewSpec {
  return {
    repo: opened.root,
    mode,
    refs,
    targets,
    excluded,
    ruleGroups: groupRules(opened.ruleConfig, targets.map(target => target.path), opened.systemRules),
    bundles: bundleTargets(targets),
  }
}

/**
 * Build an all-added synthetic diff from file content. This is the module's
 * fabrication half of "material for a run": untracked targets and scan
 * files have no git diff, so their review material is fabricated identically.
 * @param path - Repository-relative file path.
 * @param content - Full UTF-8 file content.
 * @returns The diff and its honest insertion count.
 */
export function syntheticDiff(path: string, content: string): { diff: string; insertions: number } {
  const lines = splitContentLines(content)
  const body = lines.map(line => `+${line}`).join('\n')
  return {
    diff: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}${lines.length > 0 ? '\n' : ''}`,
    insertions: lines.length,
  }
}

/**
 * Plan a review spec from git changes: targets, exclusions, rule groups, and
 * bundles — without materializing diffs. Selection inputs mirror
 * `ocr delegate preview`: workspace (default), `from`/`to` range, or one
 * commit (first-parent baseline).
 * @param input - Repository, mode, refs, and policy.
 * @returns The review specification.
 */
export async function planDiffSpec(input: DiffRunInput): Promise<ReviewSpec> {
  const opened = await openRepo(input)
  let refs = input.refs
  if (input.mode === 'range' && refs.mergeBase === undefined && refs.from !== undefined && refs.to !== undefined) {
    refs = { ...refs, mergeBase: await mergeBase(opened.root, refs.from, refs.to, opened.signal) }
  }
  if (input.mode === 'commit' && refs.mergeBase === undefined) {
    const base = await commitBase(opened.root, refs.commit ?? 'HEAD', opened.signal)
    if (base !== undefined) refs = { ...refs, mergeBase: base }
  }
  const selection = await selectTargets({
    repo: opened.root,
    mode: input.mode,
    refs,
    isExcluded: opened.isExcluded,
    ...(opened.signal !== undefined ? { signal: opened.signal } : {}),
  })
  return composeSpec(opened, selection.targets, selection.excluded, input.mode, refs)
}

/**
 * Assemble a review run from git changes: the planned spec plus every
 * target's diff (fabricated for files git shows no diff for).
 * @param input - Repository, mode, refs, and policy.
 * @returns The complete review material.
 */
export async function assembleDiffRun(input: DiffRunInput): Promise<ReviewRun> {
  const spec = await planDiffSpec(input)
  const diffs = new Map<string, string>()
  for (const target of spec.targets) {
    diffs.set(target.path, await diffFor(spec, target, input.signal))
  }
  return { spec, diffs }
}

/** One target's diff: the plain git diff, else an all-added fabricated diff. */
async function diffFor(spec: ReviewSpec, target: ReviewTarget, signal?: AbortSignal): Promise<string> {
  const gitDiff = await extractDiff({ repo: spec.repo, mode: spec.mode, refs: spec.refs }, target.path, signal).catch(() => '')
  if (gitDiff !== '') return gitDiff
  const content = await readFile(join(spec.repo, target.path), { encoding: 'utf8', ...(signal !== undefined ? { signal } : {}) }).catch(() => null)
  return content === null ? '' : syntheticDiff(target.path, content).diff
}

/**
 * Assemble a whole-file audit run from tracked files: requested paths resolve
 * against `git ls-files`, each kept file gets an all-added diff, and
 * binary/oversized files are excluded with reasons (nothing is dropped
 * silently). Safety bounds fail loud: more than {@link MAX_SCAN_FILES} listed
 * files or an empty result for non-empty `paths`.
 * @param input - Repository, path list, and policy.
 * @returns The complete review material (mode reported as `workspace`).
 * @throws When requested paths match no tracked file, or the file count
 * exceeds the scan cap.
 */
export async function assembleScanRun(input: ScanRunInput): Promise<ReviewRun> {
  const opened = await openRepo(input)
  const listed = await listTracked(opened.root, input.paths, opened.signal)
  if (input.paths.length > 0 && listed.length === 0) {
    throw new Error(`ocr_scan: paths matched no tracked file: ${input.paths.join(', ')}`)
  }
  if (listed.length > MAX_SCAN_FILES) {
    throw new Error(`ocr_scan: ${listed.length} tracked files exceed the scan cap of ${MAX_SCAN_FILES}; pass narrower paths`)
  }
  const targets: ReviewTarget[] = []
  const excluded: ExcludedFile[] = []
  const diffs = new Map<string, string>()
  for (const path of listed) {
    const reason = opened.isExcluded(path)
    if (reason !== undefined) {
      excluded.push({ path, reason })
      continue
    }
    if (BINARY_EXTENSIONS.test(path)) {
      excluded.push({ path, reason: 'binary file' })
      continue
    }
    let content: string
    try {
      const buffer = await readFile(join(opened.root, path), { ...(opened.signal !== undefined ? { signal: opened.signal } : {}) })
      if (buffer.byteLength > MAX_SCAN_BYTES) {
        excluded.push({ path, reason: `file larger than ${MAX_SCAN_BYTES} bytes` })
        continue
      }
      content = buffer.toString('utf8')
    } catch (error) {
      excluded.push({ path, reason: `unreadable: ${String(error).slice(0, 120)}` })
      continue
    }
    if (content.includes('\u0000')) {
      excluded.push({ path, reason: 'binary content' })
      continue
    }
    const built = syntheticDiff(path, content)
    targets.push({ path, status: 'added', insertions: built.insertions, deletions: 0 })
    diffs.set(path, built.diff)
  }
  // Rule groups resolve over kept targets only: a spec never names excluded files.
  return { spec: composeSpec(opened, targets, excluded, 'workspace', {}), diffs }
}

/** Input for {@link assembleRules}. */
export interface RulesInput {
  repo: string
  paths: string[]
  ruleFile: string
  systemRules: boolean
  signal?: AbortSignal
}

/**
 * Resolve rule groups for explicitly named paths without assembling a run —
 * the rule-only door behind `ocr_rules`. Paths need not be modified.
 * @param input - Repository, paths, and rule-file policy.
 * @returns The resolved groups in first-seen order.
 */
export async function assembleRules(input: RulesInput): Promise<RulesReport> {
  const root = await resolveRepoRoot(input.repo, input.signal)
  const ruleConfig = await loadRuleConfig(root, input.ruleFile, input.signal)
  const paths = input.paths.filter(path => path.trim() !== '')
  return { repo: root, ruleGroups: groupRules(ruleConfig, paths, input.systemRules) }
}
