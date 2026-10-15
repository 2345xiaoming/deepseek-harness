/**
 * Shared vocabulary for the OpenCodeReview pipeline: review targets, rule
 * resolution, bundling, and the canonical finding shape returned by the
 * model-facing tools.
 * @module @dsh-external/dsh-open-code-review/types
 */

import type { FindingSeverity, FindingCategory } from './vocabulary.ts'

/** How review targets are selected. */
export type ReviewMode = 'workspace' | 'range' | 'commit'

/** Git change classification for one reviewable file. */
export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

/** One reviewable file selected by the deterministic pipeline. */
export interface ReviewTarget {
  /** Repository-relative path. */
  path: string
  status: FileStatus
  /** Added lines in the selected change. */
  insertions: number
  /** Deleted lines in the selected change. */
  deletions: number
  /** Rename source path when status is `renamed`. */
  oldPath?: string
}

/** One file dropped by exclusion policy, with its reason. */
export interface ExcludedFile {
  path: string
  reason: string
}

/** Ref metadata needed to build diff commands for the selected mode. */
export interface ReviewRefs {
  from?: string
  to?: string
  commit?: string
  mergeBase?: string
}

/** Source of the rule text that governs a file. */
export type RuleSource = 'project' | 'system' | 'default'

/** Files clustered by identical resolved rule text (the delegate `RuleGroup` port). */
export interface RuleGroup {
  id: number
  source: RuleSource
  /** Glob pattern that matched, or `default`. */
  pattern: string
  /** Resolved review checklist text. */
  text: string
  files: string[]
}

/** One review bundle: related files reviewed together by one isolated worker. */
export interface ReviewBundle {
  id: number
  /** Short theme description of why these files travel together. */
  label: string
  files: string[]
}

/** The deterministic review specification produced before any LLM runs. */
export interface ReviewSpec {
  repo: string
  mode: ReviewMode
  refs: ReviewRefs
  targets: ReviewTarget[]
  excluded: ExcludedFile[]
  ruleGroups: RuleGroup[]
  bundles: ReviewBundle[]
}

export type { FindingSeverity, FindingCategory } from './vocabulary.ts'

/** One structured review comment produced by a worker and verified by the pipeline. */
export interface Finding {
  /** Repository-relative path of the subject file. */
  path: string
  /** 1-based start line in the new file, when the worker located it. */
  startLine?: number
  /** 1-based end line in the new file. */
  endLine?: number
  severity: FindingSeverity
  category: FindingCategory
  /** Review comment body. */
  content: string
  /** Optional suggested replacement or fix. */
  suggestion?: string
  /**
   * Whether the claimed position was verified against the diff: true when a
   * snippet matched contiguous added lines, or when the claimed line range
   * falls inside a changed hunk of the new file.
   */
  positionVerified: boolean
}

/** Coverage accounting — every selected target ends reviewed or explicitly skipped. */
export interface Coverage {
  total: number
  reviewed: number
  skipped: ExcludedFile[]
  /** reviewed / total, rounded to two decimals. */
  rate: number
}

/** Per-bundle run record shown in results and the UI panel. */
export interface BundleOutcome {
  id: number
  label: string
  files: string[]
  status: 'reviewed' | 'skipped'
  reason?: string
  findingCount: number
}

/** The canonical value returned by `ocr_review` and `ocr_scan`. */
export interface ReviewResult {
  repo: string
  mode: ReviewMode
  refs: ReviewRefs
  coverage: Coverage
  findings: Finding[]
  /** Comments dropped by the reflection filter (proven factually wrong). */
  filteredCount: number
  bundles: BundleOutcome[]
  /** Execution facts for the caller (never rendered as UI-only formatting). */
  stats: {
    worker: 'subagent' | 'llm'
    bundles: number
    /** Bundles whose pre-review plan succeeded (fail-open plans are not counted). */
    planRuns: number
    filterRuns: number
    /** Comments the LLM relocation fallback re-anchored after the deterministic pass missed. */
    relocated: number
    durationMs: number
  }
}
