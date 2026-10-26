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
  PLAN_OUTPUT_SCHEMA,
  PLAN_SYSTEM_PROMPT,
  RELOCATE_OUTPUT_SCHEMA,
  RELOCATE_SYSTEM_PROMPT,
  REVIEW_OUTPUT_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  filterUserPrompt,
  isCategory,
  isSeverity,
  normalizeComments,
  normalizePlan,
  parseFilterVerdict,
  parseRelocatedSnippets,
  planUserPrompt,
  relocateUserPrompt,
  renderPlanGuidance,
  reviewUserPrompt,
} from './worker.ts'
import { positionComment, positionComments } from './relocate.ts'
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
  /** Run a pre-review plan task per bundle and feed its guidance to the review worker. */
  plan: boolean
  /** Comment-positioning strategy: deterministic only, or with the LLM relocation fallback. */
  relocation: 'deterministic' | 'llm'
  signal: AbortSignal
}

/** Mutable accumulator shared across bundle outcomes. */
interface RunState {
  findings: Finding[]
  skipped: ExcludedFile[]
  bundleOutcomes: BundleOutcome[]
  filteredCount: number
  planRuns: number
  planFailures: number
  filterRuns: number
  relocated: number
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
  const state: RunState = { findings: [], skipped: [], bundleOutcomes: [], filteredCount: 0, planRuns: 0, planFailures: 0, filterRuns: 0, relocated: 0, reviewedPaths: new Set() }
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
    const otherChanged = otherFiles.filter(line => !bundle.files.some(file => line.endsWith(` ${file}`)))
    try {
      const plan = input.plan
        ? await planBundle(worker, otherChanged, diffs, ruleText, input, state, bundle.id, signal)
        : undefined
      const planGuidance = plan?.guidance
      const raw = await worker.run({
        label: `ocr review bundle ${bundle.id}`,
        system: REVIEW_SYSTEM_PROMPT,
        user: reviewUserPrompt({
          otherChangedFiles: otherChanged,
          diffs,
          ruleText,
          ...(planGuidance !== undefined ? { planGuidance } : {}),
          ...(input.background !== undefined ? { background: input.background } : {}),
          now: input.now,
        }),
        schema: REVIEW_OUTPUT_SCHEMA,
      }, signal)
      const comments = normalizeComments(raw, bundle.files)
      const positioned = input.relocation === 'llm'
        ? await relocateBundle(worker, diffs, positionComments(comments, diffByPath), state, bundle.id, signal)
        : positionComments(comments, diffByPath)
      const removed = await filterBundle(worker, diffs, positioned.map(entry => entry.comment), input, state)
      let findingCount = 0
      positioned.forEach((entry, index) => {
        if (removed.has(index)) return
        state.findings.push(toFinding(entry))
        findingCount += 1
      })
      // Reviewed: the worker covering this file completed.
      for (const file of bundle.files) state.reviewedPaths.add(file)
      state.bundleOutcomes.push({
        id: bundle.id,
        label: bundle.label,
        files: bundle.files,
        status: 'reviewed',
        ...(plan?.error !== undefined ? { planError: plan.error } : {}),
        findingCount,
      })
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
      planRuns: state.planRuns,
      planFailures: state.planFailures,
      filterRuns: state.filterRuns,
      relocated: state.relocated,
      durationMs: Date.now() - started,
    },
  }
}

/**
 * Run the pre-review planner for one bundle and render its guidance. Fail-open:
 * a failed plan leaves the review running without guidance.
 * @returns The guidance block, the failure reason, or neither when the plan was empty.
 */
async function planBundle(
  worker: ReviewWorker,
  otherChanged: string[],
  diffs: string,
  ruleText: string,
  input: RunReviewInput,
  state: RunState,
  bundleId: number,
  signal: AbortSignal,
): Promise<{ guidance?: string; error?: string }> {
  try {
    const raw = await worker.run({
      label: `ocr review plan ${bundleId}`,
      system: PLAN_SYSTEM_PROMPT,
      user: planUserPrompt({
        otherChangedFiles: otherChanged,
        diffs,
        ruleText,
        ...(input.background !== undefined ? { background: input.background } : {}),
        now: input.now,
      }),
      schema: PLAN_OUTPUT_SCHEMA,
    }, signal)
    state.planRuns += 1
    const guidance = renderPlanGuidance(normalizePlan(raw))
    return guidance === '' ? {} : { guidance }
  } catch (error) {
    if (signal.aborted) throw error
    // Fail-open, visible: the review runs without guidance and the reason is reported.
    state.planFailures += 1
    return { error: `plan failed: ${String(error).slice(0, 300)}` }
  }
}

/**
 * LLM relocation fallback: ask the worker for the added lines each unanchored
 * comment targets, then re-run the deterministic matcher on the returned
 * snippets. Fail-open: a failed relocation leaves positions as they were.
 * @returns Positioned comments with any successfully re-anchored entries replaced.
 */
async function relocateBundle(
  worker: ReviewWorker,
  diffs: string,
  positioned: PositionedComment[],
  state: RunState,
  bundleId: number,
  signal: AbortSignal,
): Promise<PositionedComment[]> {
  const failures = positioned
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !entry.positionVerified)
  if (failures.length === 0) return positioned
  try {
    const raw = await worker.run({
      label: `ocr review relocate ${bundleId}`,
      system: RELOCATE_SYSTEM_PROMPT,
      user: relocateUserPrompt({
        diffs,
        comments: failures.map(({ entry }, batchIndex) => ({
          index: batchIndex,
          content: entry.comment.content,
          ...(entry.comment.startLine !== undefined ? { startLine: entry.comment.startLine } : {}),
          ...(entry.comment.snippet !== undefined ? { snippet: entry.comment.snippet } : {}),
        })),
      }),
      schema: RELOCATE_OUTPUT_SCHEMA,
    }, signal)
    const snippets = parseRelocatedSnippets(raw, failures.length)
    if (snippets.size === 0) return positioned
    const next = [...positioned]
    for (const [batchIndex, snippet] of snippets) {
      const target = failures[batchIndex]
      if (target === undefined) continue
      const retry = positionComment({ ...target.entry.comment, snippet }, diffs)
      if (!retry.positionVerified) continue
      next[target.index] = retry
      state.relocated += 1
    }
    return next
  } catch (error) {
    if (signal.aborted) throw error
    return positioned
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
