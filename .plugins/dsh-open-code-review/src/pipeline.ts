/**
 * Run orchestration over the review worker seam. A run turns a
 * {@link ReviewSpec} into findings: every bundle goes to one worker, comments
 * are relocated and verified against the diffs, and the reflection filter
 * decides which survive. Accounted semantics: a file is *reviewed* when the
 * worker covering its bundle completed, and *skipped* (with a reason)
 * otherwise; a failed filter fails open and never destroys findings.
 * @module @dsh-external/dsh-open-code-review/pipeline
 */

import type {
  BundleOutcome,
  Coverage,
  ExcludedFile,
  Finding,
  ReviewResult,
  ReviewSpec,
  RuleGroup,
} from './types.ts'
import type { RawComment, ReviewWorker } from './worker.ts'
import {
  FILTER_OUTPUT_SCHEMA,
  FILTER_SYSTEM_PROMPT,
  REVIEW_OUTPUT_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  filterUserPrompt,
  isCategory,
  isSeverity,
  normalizeComments,
  parseFilterVerdict,
  reviewUserPrompt,
} from './worker.ts'
import { positionComments } from './relocate.ts'
import type { PositionedComment } from './relocate.ts'

/** Options for {@link runReview}. */
export interface RunReviewInput {
  spec: ReviewSpec
  /** The review material: every spec target's diff (from the spec module). */
  diffs: Map<string, string>
  /** The review worker seam; a fake worker in tests. */
  worker: ReviewWorker
  /** Requirement background passed to workers. */
  background?: string
  /** Worker concurrency across bundles (default 2). */
  concurrency: number
  /** Current timestamp shown to workers. */
  now: string
  signal: AbortSignal
}

/** Mutable accumulator shared across bundle outcomes. */
interface RunState {
  findings: Finding[]
  skipped: ExcludedFile[]
  bundleOutcomes: BundleOutcome[]
  filteredCount: number
  filterRuns: number
  reviewedPaths: Set<string>
}

/**
 * Run the hybrid review over one specification: every bundle to the worker,
 * positions verified deterministically, comments passed through the
 * reflection filter, results aggregated with full coverage accounting.
 * @param input - Specification, worker, and run policy.
 * @returns The canonical review result.
 * @throws On cancellation between batches.
 */
export async function runReview(input: RunReviewInput): Promise<ReviewResult> {
  const started = Date.now()
  const { spec, worker, signal } = input
  const state: RunState = { findings: [], skipped: [], bundleOutcomes: [], filteredCount: 0, filterRuns: 0, reviewedPaths: new Set() }
  const ruleByFile = new Map<string, RuleGroup>()
  for (const group of spec.ruleGroups) for (const file of group.files) ruleByFile.set(file, group)

  // The diffs arrive as complete material from the spec module.
  const diffByPath = input.diffs

  const otherFiles = spec.targets.map(target => `${statusTag(target.status)} ${target.path}`)
  let cursor = 0
  const limit = Math.max(1, input.concurrency)

  const runBundle = async (bundle: ReviewSpec['bundles'][number]): Promise<void> => {
    const diffs = bundle.files
      .map(file => `<file path="${file}" status="${statusOf(spec, file)}">\n${diffByPath.get(file) ?? ''}\n</file>`)
      .join('\n')
    const ruleText = checklistFor(ruleByFile, bundle.files)
    try {
      const raw = await worker.run({
        label: `ocr review bundle ${bundle.id}`,
        system: REVIEW_SYSTEM_PROMPT,
        user: reviewUserPrompt({
          otherChangedFiles: otherFiles.filter(line => !bundle.files.some(file => line.endsWith(` ${file}`))),
          diffs,
          ruleText,
          ...(input.background !== undefined ? { background: input.background } : {}),
          now: input.now,
        }),
        schema: REVIEW_OUTPUT_SCHEMA,
      }, signal)
      const comments = normalizeComments(raw, bundle.files)
      const positioned = positionComments(comments, diffByPath)
      const removed = await filterBundle(worker, diffs, positioned.map(entry => entry.comment), input, state)
      let findingCount = 0
      positioned.forEach((entry, index) => {
        if (removed.has(index)) return
        state.findings.push(toFinding(entry))
        findingCount += 1
      })
      // Reviewed: the worker covering this file completed.
      for (const file of bundle.files) state.reviewedPaths.add(file)
      state.bundleOutcomes.push({ id: bundle.id, label: bundle.label, files: bundle.files, status: 'reviewed', findingCount })
    } catch (error) {
      if (signal.aborted) throw error
      const reason = `worker failed: ${String(error).slice(0, 300)}`
      for (const file of bundle.files) state.skipped.push({ path: file, reason })
      state.bundleOutcomes.push({ id: bundle.id, label: bundle.label, files: bundle.files, status: 'skipped', reason, findingCount: 0 })
    }
  }

  while (cursor < spec.bundles.length) {
    if (signal.aborted) throw new Error('ocr review cancelled')
    const batch = spec.bundles.slice(cursor, cursor + limit)
    cursor += limit
    await Promise.all(batch.map(bundle => runBundle(bundle)))
  }

  return {
    repo: spec.repo,
    mode: spec.mode,
    refs: spec.refs,
    coverage: coverageOf(spec, state),
    findings: state.findings,
    filteredCount: state.filteredCount,
    bundles: state.bundleOutcomes,
    stats: {
      worker: worker.kind,
      bundles: spec.bundles.length,
      filterRuns: state.filterRuns,
      durationMs: Date.now() - started,
    },
  }
}

/**
 * Run the reflection filter over one bundle's draft comments and return the
 * indices it proved wrong. Comment identity is the batch index. Fail-open: a
 * failed filter removes nothing, so filter infrastructure never destroys a
 * correct comment.
 * @param worker - The review worker seam.
 * @param diffs - Bundle diffs.
 * @param comments - Draft comments in report order.
 * @param input - Run policy (signal).
 * @param state - Run accumulator (records filter counts).
 * @returns Removed comment indices into `comments`.
 */
async function filterBundle(
  worker: ReviewWorker,
  diffs: string,
  comments: RawComment[],
  input: RunReviewInput,
  state: RunState,
): Promise<Set<number>> {
  if (comments.length === 0) return new Set()
  state.filterRuns += 1
  try {
    const raw = await worker.run({
      label: 'ocr review filter',
      system: FILTER_SYSTEM_PROMPT,
      user: filterUserPrompt({ diffs, comments }),
      schema: FILTER_OUTPUT_SCHEMA,
    }, input.signal)
    const verdict = parseFilterVerdict(raw, comments.length)
    state.filteredCount += verdict.removedIndices.size
    return verdict.removedIndices
  } catch {
    return new Set()
  }
}

/** Convert a positioned comment into the canonical finding. */
function toFinding(entry: PositionedComment): Finding {
  const comment = entry.comment
  return {
    path: comment.path,
    ...(entry.startLine !== undefined ? { startLine: entry.startLine } : {}),
    ...(entry.endLine !== undefined ? { endLine: entry.endLine } : {}),
    severity: isSeverity(comment.severity) ? comment.severity : 'medium',
    category: isCategory(comment.category) ? comment.category : 'other',
    content: comment.content,
    ...(comment.suggestion !== undefined ? { suggestion: comment.suggestion } : {}),
    positionVerified: entry.positionVerified,
  }
}

/** Coverage over every selected target: reviewed paths or explicit skips. */
function coverageOf(spec: ReviewSpec, state: RunState): Coverage {
  const skipped = [...state.skipped]
  for (const target of spec.targets) {
    if (state.reviewedPaths.has(target.path)) continue
    if (state.skipped.some(entry => entry.path === target.path)) continue
    skipped.push({ path: target.path, reason: 'not reviewed (no completed worker covered it)' })
  }
  const total = spec.targets.length
  const reviewed = total - skipped.length
  return {
    total,
    reviewed,
    skipped,
    rate: total === 0 ? 1 : Math.round((reviewed / total) * 100) / 100,
  }
}

/** Rule checklist for a bundle: each governing group stated once. */
function checklistFor(ruleByFile: Map<string, RuleGroup>, files: string[]): string {
  const groups = new Map<number, RuleGroup>()
  for (const file of files) {
    const group = ruleByFile.get(file)
    if (group !== undefined) groups.set(group.id, group)
  }
  if (groups.size === 0) return '(no checklist resolved)'
  return [...groups.values()]
    .map(group => `<rule_group id="${group.id}" source="${group.source}" pattern="${group.pattern}" files="${group.files.join(', ')}">\n${group.text}\n</rule_group>`)
    .join('\n\n')
}

/** Git-style status line for the "other changed files" listing. */
function statusTag(status: ReviewSpec['targets'][number]['status']): string {
  return { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' }[status]
}

/** Status tag of one file inside a specification. */
function statusOf(spec: ReviewSpec, path: string): string {
  const target = spec.targets.find(candidate => candidate.path === path)
  return target !== undefined ? statusTag(target.status) : '?'
}
