/**
 * Model-facing tools: `ocr_preview`, `ocr_rules`, `ocr_review`, `ocr_scan` —
 * the delegate CLI surface as first-party tools. Selection, rules, and
 * bundling run deterministically; review and scan run the hybrid pipeline with
 * isolated per-bundle workers, verified positions, and the reflection filter.
 * @module @dsh-external/dsh-open-code-review/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ReviewResult, ReviewSpec, ReviewMode, ReviewRefs } from './types.ts'
import { runReview } from './pipeline.ts'
import { createWorker } from './worker.ts'
import type { LlmRoute, ReviewWorker, WorkerKind } from './worker.ts'
import { assembleDiffRun, assembleRules, assembleScanRun, planDiffSpec } from './spec.ts'
import type { RulesReport } from './spec.ts'
import { SEVERITIES, CATEGORIES } from './vocabulary.ts'
import { findingLine } from './findings.ts'

/** Deployment policy the tools read at execution time. */
export interface ToolHostConfig {
  /** Worker channel selection; `auto` prefers subagents when available. */
  worker: 'auto' | 'subagent' | 'llm'
  /** Registered subagent provider for isolated bundle workers. */
  subagentProvider: string
  /** Configured LLM route override for `llm` workers. */
  llmRoute?: LlmRoute
  /** Token ceiling for one worker call. */
  maxTokens: number
  /** Cooperative timeout budget for one tool call, in milliseconds. */
  toolTimeoutMs: number
  /** Worker concurrency across bundles. */
  concurrency: number
  /** Exclusion globs applied at selection. */
  exclude: string[]
  /** Repository-relative project rule file. */
  ruleFile: string
  /** Whether the ported system rule map participates in resolution. */
  systemRules: boolean
}

/** Live host state the tools read or update. */
export interface ToolHost {
  config: ToolHostConfig
  llm: LlmService
  /** The most recently observed model route (captured on `llm/stream`). */
  route(): LlmRoute | undefined
  /** The subagent runtime, when the host mounts one. */
  subagents(): SubagentRuntime | undefined
  /** Resolve the default repository root for an agent execution. */
  defaultRepo(agent: Agent | undefined, signal?: AbortSignal): Promise<string>
  /** Record the latest review/scan run for the UI panel and API route. */
  recordRun(kind: 'review' | 'scan', payload: ReviewResult): void
}


/** Shared parameter block for selection-based tools. */
const SELECTION_PARAMS = {
  repo: { type: 'string', description: 'Repository path; defaults to the session working directory.' },
  from: { type: 'string', description: 'Range mode: source ref (the branch-point side).' },
  to: { type: 'string', description: 'Range mode: target ref under review.' },
  commit: { type: 'string', description: 'Commit mode: the commit to review.' },
  exclude: { type: 'array', items: { type: 'string' }, description: 'Extra exclusion globs merged over the configured list.' },
} as const

/** Resolve mode + refs from optional tool arguments, rejecting ambiguity. */
function selectionFromArgs(args: { from?: string; to?: string; commit?: string }): { mode: ReviewMode; refs: ReviewRefs } {
  const from = args.from !== undefined && args.from !== '' ? args.from : undefined
  const to = args.to !== undefined && args.to !== '' ? args.to : undefined
  const commit = args.commit !== undefined && args.commit !== '' ? args.commit : undefined
  if (commit !== undefined && (from !== undefined || to !== undefined)) {
    throw new Error('ocr: pass either commit or from/to, not both')
  }
  if ((from === undefined) !== (to === undefined)) {
    throw new Error('ocr: from and to must be provided together')
  }
  if (commit !== undefined) return { mode: 'commit', refs: { commit } }
  if (from !== undefined && to !== undefined) return { mode: 'range', refs: { from, to } }
  return { mode: 'workspace', refs: {} }
}

/** Build the review worker seam from live host state (one construction per call). */
function buildWorker(host: ToolHost, override: string | undefined, parent: Agent | undefined): ReviewWorker {
  const route = host.route()
  const subagents = host.subagents()
  return createWorker({
    kind: workerKind(host, override, parent !== undefined),
    llm: host.llm,
    ...(route !== undefined ? { route } : {}),
    ...(subagents !== undefined ? { subagents } : {}),
    ...(parent !== undefined ? { parent } : {}),
    subagentProvider: host.config.subagentProvider,
    maxTokens: host.config.maxTokens,
  })
}

/** Resolve the run's worker concurrency: per-call override wins, bounded 1-8. */
function runConcurrency(host: ToolHost, override: number | undefined): number {
  if (override === undefined) return host.config.concurrency
  if (!Number.isInteger(override) || override < 1 || override > 8) {
    throw new Error('ocr: concurrency must be an integer between 1 and 8')
  }
  return override
}

/** Select the worker channel from policy and live capability. */
function workerKind(host: ToolHost, override?: string, parentAvailable = true): WorkerKind {
  if (override === 'subagent' || override === 'llm') return override
  if (host.config.worker === 'llm') return 'llm'
  if (host.config.worker === 'subagent') return 'subagent'
  return host.subagents() !== undefined && parentAvailable ? 'subagent' : 'llm'
}

const REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    commit: { type: 'string' },
    mergeBase: { type: 'string' },
  },
} satisfies ObjectValueSchemaSpec

const TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { required: true, type: 'string' },
    status: { required: true, type: 'string', enum: ['added', 'modified', 'deleted', 'renamed'] },
    insertions: { required: true, type: 'integer' },
    deletions: { required: true, type: 'integer' },
    oldPath: { type: 'string' },
  },
} satisfies ObjectValueSchemaSpec

const EXCLUDED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { path: { type: 'string' }, reason: { type: 'string' } },
} satisfies ObjectValueSchemaSpec

const RULE_GROUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { required: true, type: 'integer' },
    source: { required: true, type: 'string', enum: ['project', 'system', 'default'] },
    pattern: { required: true, type: 'string' },
    files: { required: true, type: 'array', items: { type: 'string' } },
    text: { type: 'string', description: 'Resolved review checklist (ocr_rules only).' },
  },
} satisfies ObjectValueSchemaSpec

const PREVIEW_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: { required: true, type: 'string' },
    mode: { required: true, type: 'string', enum: ['workspace', 'range', 'commit'] },
    refs: { ...REF_SCHEMA, required: true },
    targets: { required: true, type: 'array', items: TARGET_SCHEMA },
    excluded: { required: true, type: 'array', items: EXCLUDED_SCHEMA },
    ruleGroups: { required: true, type: 'array', items: RULE_GROUP_SCHEMA },
    bundles: { required: true,
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { required: true, type: 'integer' },
          label: { required: true, type: 'string' },
          files: { required: true, type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} satisfies ObjectValueSchemaSpec

const RULES_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: { required: true, type: 'string' },
    ruleGroups: { required: true, type: 'array', items: RULE_GROUP_SCHEMA },
  },
} satisfies ObjectValueSchemaSpec

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { required: true, type: 'string' },
    startLine: { type: 'integer' },
    endLine: { type: 'integer' },
    severity: { required: true, type: 'string', enum: SEVERITIES },
    category: { required: true, type: 'string', enum: CATEGORIES },
    content: { required: true, type: 'string' },
    suggestion: { type: 'string' },
    positionVerified: { required: true, type: 'boolean' },
  },
} satisfies ObjectValueSchemaSpec

const REVIEW_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: { required: true, type: 'string' },
    mode: { required: true, type: 'string', enum: ['workspace', 'range', 'commit'] },
    refs: { ...REF_SCHEMA, required: true },
    coverage: { required: true,
      type: 'object',
      additionalProperties: false,
      properties: {
        total: { required: true, type: 'integer' },
        reviewed: { required: true, type: 'integer' },
        skipped: { required: true, type: 'array', items: EXCLUDED_SCHEMA },
        rate: { required: true, type: 'number' },
      },
    },
    findings: { required: true, type: 'array', items: FINDING_SCHEMA },
    filteredCount: { required: true, type: 'integer' },
    bundles: { required: true,
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { required: true, type: 'integer' },
          label: { required: true, type: 'string' },
          files: { required: true, type: 'array', items: { type: 'string' } },
          status: { required: true, type: 'string', enum: ['reviewed', 'skipped'] },
          reason: { type: 'string' },
          findingCount: { required: true, type: 'integer' },
        },
      },
    },
    stats: { required: true,
      type: 'object',
      additionalProperties: false,
      properties: {
        worker: { required: true, type: 'string', enum: ['subagent', 'llm'] },
        bundles: { required: true, type: 'integer' },
        filterRuns: { required: true, type: 'integer' },
        durationMs: { required: true, type: 'integer' },
      },
    },
  },
} satisfies ObjectValueSchemaSpec

/** Render one preview document for the model. */
function renderPreview(spec: ReviewSpec): string {
  const lines: string[] = []
  lines.push(`OpenCodeReview preview — mode=${spec.mode} repo=${spec.repo}`)
  const files = spec.targets.map(target => `${target.status.padEnd(9)} ${target.path} (+${target.insertions}/-${target.deletions})`)
  lines.push('', `Reviewable files (${spec.targets.length}):`, ...(files.length > 0 ? files : ['(none)']))
  if (spec.excluded.length > 0) {
    lines.push('', `Excluded (${spec.excluded.length}):`)
    for (const entry of spec.excluded) lines.push(`  ${entry.path} — ${entry.reason}`)
  }
  lines.push('', `Rule groups (${spec.ruleGroups.length}) — fetch checklists with ocr_rules:`)
  for (const group of spec.ruleGroups) lines.push(`  [${group.id}] ${group.source}:${group.pattern} → ${group.files.join(', ')}`)
  lines.push('', `Review bundles (${spec.bundles.length}):`)
  for (const bundle of spec.bundles) lines.push(`  [${bundle.id}] ${bundle.label} → ${bundle.files.join(', ')}`)
  return lines.join('\n')
}

/** Render the rule-group report for the model. */
function renderRules(report: RulesReport): string {
  const lines: string[] = [`OpenCodeReview rule groups (${report.ruleGroups.length}) for ${report.repo}`]
  for (const group of report.ruleGroups) {
    lines.push('', `## Rule group ${group.id} (${group.source} / ${group.pattern})`, `Files: ${group.files.join(', ')}`, '', group.text)
  }
  return lines.join('\n')
}

/** Render the review result for the model. */
function renderResult(result: ReviewResult): string {
  const lines: string[] = []
  lines.push(
    `OpenCodeReview ${result.mode} review — ${result.findings.length} finding(s), `
    + `coverage ${result.coverage.reviewed}/${result.coverage.total} (rate ${result.coverage.rate}), `
    + `${result.filteredCount} filtered`,
    `worker=${result.stats.worker} · bundles=${result.stats.bundles} · filterRuns=${result.stats.filterRuns} `
    + `· ${Math.round(result.stats.durationMs / 1000)}s`,
  )
  for (const severity of SEVERITIES) {
    const findings = result.findings.filter(finding => finding.severity === severity)
    if (findings.length === 0) continue
    lines.push('', `## ${severity} (${findings.length})`)
    for (const finding of findings) {
      lines.push(`- ${findingLine(finding, ' [position unverified]')}`)
      if (finding.suggestion !== undefined) lines.push(`  suggestion: ${finding.suggestion}`)
    }
  }
  if (result.findings.length === 0) lines.push('', 'No findings.')
  if (result.coverage.skipped.length > 0) {
    lines.push('', `Skipped (${result.coverage.skipped.length}):`)
    for (const entry of result.coverage.skipped) lines.push(`  ${entry.path} — ${entry.reason}`)
  }
  const failed = result.bundles.filter(bundle => bundle.status === 'skipped')
  if (failed.length > 0) {
    lines.push('', `Failed bundles (${failed.length}):`)
    for (const bundle of failed) lines.push(`  [${bundle.id}] ${bundle.label} — ${bundle.reason ?? 'unknown'}`)
  }
  return lines.join('\n')
}

/**
 * Register the four OpenCodeReview tools on the shared registry.
 * @param ctx - Plugin context carrying `ctx.tools`.
 * @param host - Live host state and policy.
 * @returns The registration disposer.
 */
export function registerOcrTools(ctx: Context, host: ToolHost): () => void {
  const disposers: (() => void)[] = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'ocr_preview',
    timeoutMs: host.config.toolTimeoutMs,
    description:
      'Deterministically select what to review in a git repository and plan the review: '
      + 'workspace/range/commit modes, exclusions, rule-group membership, and related-file bundles. '
      + 'Runs no model code. Use before ocr_review, or drive a manual review with ocr_rules.',
    parameters: SELECTION_PARAMS,
    output: {
      schema: PREVIEW_OUTPUT,
      render: (_args, value: ReviewSpec) => [{ type: 'text', text: renderPreview(value) }],
      presentationMeta: (_args, value: ReviewSpec) => ({ kind: 'preview', mode: value.mode, targets: value.targets.length }),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `OpenCodeReview preview${args.commit !== undefined ? ` · ${args.commit}` : ''}${args.from !== undefined ? ` · ${args.from}..${args.to ?? ''}` : ''}`,
      kind: 'search',
    }),
    presentResult: (_args, { meta }) => ({
      card: 'generic',
      title: `OpenCodeReview preview · ${(meta as { targets?: number } | undefined)?.targets ?? 0} file(s)`,
    }),
    async execute(args, exec) {
      const repo = args.repo !== undefined && args.repo !== ''
        ? args.repo
        : await host.defaultRepo(exec.agent, exec.signal)
      const { mode, refs } = selectionFromArgs(args)
      return await planDiffSpec({
        repo,
        mode,
        refs,
        exclude: [...host.config.exclude, ...(args.exclude ?? [])],
        ruleFile: host.config.ruleFile,
        systemRules: host.config.systemRules,
        signal: exec.signal,
      })
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ocr_rules',
    timeoutMs: host.config.toolTimeoutMs,
    description:
      'Resolve the review checklists (rules) for specific repository paths, grouped by shared rule text: '
      + 'project .opencodereview/rule.json entries merge over the built-in per-language ruleset. '
      + 'Purely deterministic. Feed the returned checklist into a manual review, or let ocr_review apply it automatically.',
    parameters: {
      repo: { type: 'string', description: 'Repository path; defaults to the session working directory.' },
      paths: { type: 'array', items: { type: 'string' }, required: true, description: 'Repository-relative paths to resolve rules for.' },
    },
    output: {
      schema: RULES_OUTPUT,
      render: (_args, value: RulesReport) => [{ type: 'text', text: renderRules(value) }],
    },
    async execute(args, exec) {
      const repo = args.repo !== undefined && args.repo !== ''
        ? args.repo
        : await host.defaultRepo(exec.agent, exec.signal)
      return await assembleRules({
        repo,
        paths: args.paths,
        ruleFile: host.config.ruleFile,
        systemRules: host.config.systemRules,
        signal: exec.signal,
      })
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ocr_review',
    timeoutMs: host.config.toolTimeoutMs,
    description:
      'Run the hybrid code review over a git change: deterministic file selection, rule matching, and related-file bundling, '
      + 'then one isolated review worker per bundle that may read the codebase for context, produces line-level findings, '
      + 'and passes every comment through a fact-checking filter. Reports severity (critical|high|medium|low), category, '
      + 'verified positions, and full file coverage. Use for review requests on the working copy, a commit, or a branch range. '
      + 'For large changesets call ocr_preview first and narrow with exclude: the run must finish within the tool timeout budget.',
    parameters: {
      ...SELECTION_PARAMS,
      background: { type: 'string', description: 'Requirement background or review focus for the workers.' },
      worker: { type: 'string', enum: ['auto', 'subagent', 'llm'], description: 'Execution channel override for this run.' },
      concurrency: { type: 'integer', description: 'Workers running at once for this call (1-8); defaults to the configured value. Raise it for large changesets to fit the call timeout.' },
    },
    output: {
      schema: REVIEW_OUTPUT,
      render: (_args, value: ReviewResult) => [{ type: 'text', text: renderResult(value) }],
      presentationMeta: (_args, value: ReviewResult) => ({
        kind: 'review',
        mode: value.mode,
        findingCount: value.findings.length,
        coverage: value.coverage.rate,
      }),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `OpenCodeReview review${args.commit !== undefined ? ` · ${args.commit}` : ''}${args.from !== undefined ? ` · ${args.from}..${args.to ?? ''}` : ''}`,
      kind: 'search',
    }),
    presentResult: (_args, { meta }) => {
      const facts = meta as { findingCount?: number; coverage?: number } | undefined
      return {
        card: 'generic',
        title: `OpenCodeReview review · ${facts?.findingCount ?? 0} finding(s) · coverage ${facts?.coverage ?? 0}`,
      }
    },
    async execute(args, exec) {
      const repo = args.repo !== undefined && args.repo !== ''
        ? args.repo
        : await host.defaultRepo(exec.agent, exec.signal)
      const { mode, refs } = selectionFromArgs(args)
      const run = await assembleDiffRun({
        repo,
        mode,
        refs,
        exclude: [...host.config.exclude, ...(args.exclude ?? [])],
        ruleFile: host.config.ruleFile,
        systemRules: host.config.systemRules,
        signal: exec.signal,
      })
      const worker = buildWorker(host, args.worker, exec.agent)
      const result = await runReview({
        spec: run.spec,
        diffs: run.diffs,
        worker,
        ...(args.background !== undefined ? { background: args.background } : {}),
        concurrency: runConcurrency(host, args.concurrency),
        now: new Date().toISOString(),
        signal: exec.signal,
      })
      host.recordRun('review', result)
      return result
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'ocr_scan',
    timeoutMs: host.config.toolTimeoutMs,
    description:
      'Audit whole files instead of a diff — for unfamiliar code or directories with no meaningful change. '
      + 'Same hybrid pipeline as ocr_review (bundled isolated workers, verified positions, fact-checking filter) '
      + 'over complete file contents. Paths default to all tracked files subject to a file-count cap; binary and oversized files are excluded with reasons.',
    parameters: {
      repo: { type: 'string', description: 'Repository path; defaults to the session working directory.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Files or directories to scan; default: all tracked files. Paths matching no tracked file fail loudly.' },
      background: { type: 'string', description: 'Audit focus for the workers.' },
      worker: { type: 'string', enum: ['auto', 'subagent', 'llm'], description: 'Execution channel override for this run.' },
      concurrency: { type: 'integer', description: 'Workers running at once for this call (1-8); defaults to the configured value.' },
    },
    output: {
      schema: REVIEW_OUTPUT,
      render: (_args, value: ReviewResult) => [{ type: 'text', text: renderResult(value) }],
      presentationMeta: (_args, value: ReviewResult) => ({
        kind: 'scan',
        mode: value.mode,
        findingCount: value.findings.length,
        coverage: value.coverage.rate,
      }),
    },
    presentCall: () => ({ card: 'generic', title: 'OpenCodeReview scan', kind: 'search' }),
    presentResult: (_args, { meta }) => {
      const facts = meta as { findingCount?: number } | undefined
      return { card: 'generic', title: `OpenCodeReview scan · ${facts?.findingCount ?? 0} finding(s)` }
    },
    async execute(args, exec) {
      const repo = args.repo !== undefined && args.repo !== ''
        ? args.repo
        : await host.defaultRepo(exec.agent, exec.signal)
      const run = await assembleScanRun({
        repo,
        paths: args.paths ?? [],
        exclude: host.config.exclude,
        ruleFile: host.config.ruleFile,
        systemRules: host.config.systemRules,
        signal: exec.signal,
      })
      const worker = buildWorker(host, args.worker, exec.agent)
      const result = await runReview({
        spec: run.spec,
        diffs: run.diffs,
        worker,
        ...(args.background !== undefined ? { background: args.background } : {}),
        concurrency: runConcurrency(host, args.concurrency),
        now: new Date().toISOString(),
        signal: exec.signal,
      })
      host.recordRun('scan', result)
      return result
    },
  })))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
