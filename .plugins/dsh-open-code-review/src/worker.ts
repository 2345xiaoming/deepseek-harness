/**
 * The review worker seam: one interface over two adapters. A {@link ReviewWorker}
 * takes a {@link WorkerTask} and returns one structured document — the same
 * contract whether it runs as an isolated subagent with read-only exploration
 * tools or as a single model call over packed context. This module is the one
 * home of the worker-output contract: the wire schemas, the prose that
 * instructs them, the parser that admits them, and the record types.
 *
 * Semantics owned here: a requested subagent channel without a runtime or
 * parent agent fails loud at construction; capability-limited providers fail
 * loud at start (a review never silently loses its read-only restrictions).
 * @module @dsh-external/dsh-open-code-review/worker
 */

import type LlmService from '@deepseek-ai/dsh-llm'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { SEVERITIES, CATEGORIES } from './vocabulary.ts'
import type { FindingSeverity, FindingCategory } from './vocabulary.ts'

/** Which execution channel a worker runs on. */
export type WorkerKind = 'subagent' | 'llm'

/** Model route used by the `llm` adapter. */
export interface LlmRoute {
  provider: string
  model: string
}

/** One assignment handed to a review worker. */
export interface WorkerTask {
  /** Short task label retained in run records. */
  label: string
  /** The worker's role and rules prose. */
  system: string
  /** The assignment body. */
  user: string
  /** The wire schema the structured document must satisfy. */
  schema: ObjectJsonSchema
}

/**
 * The review worker seam. Implementations return the raw structured document;
 * callers cross the contract with {@link normalizeComments} or
 * {@link parseFilterVerdict}.
 */
export interface ReviewWorker {
  /** The channel this worker runs on (run-record identity). */
  readonly kind: WorkerKind
  /**
   * Run one task and return its structured document.
   * @param task - The assignment.
   * @param signal - Caller cancellation; aborts the in-flight model work.
   * @returns The schema-shaped document.
   * @throws When the channel is unavailable, the run fails, or no structured document is produced.
   */
  run(task: WorkerTask, signal: AbortSignal): Promise<unknown>
}

/** Dependencies one worker is built from (accepted, never created). */
export interface WorkerDeps {
  /** Requested channel. */
  kind: WorkerKind
  /** Host LLM service for the `llm` channel. */
  llm: LlmService
  /** Model route for the `llm` channel; omitted means no route is available yet. */
  route?: LlmRoute
  /** Subagent runtime for the `subagent` channel. */
  subagents?: SubagentRuntime
  /** Spawning agent supplying child identity and the default model route. */
  parent?: Agent
  /** Registered subagent provider name. */
  subagentProvider: string
  /** Output-token ceiling for one worker call. */
  maxTokens: number
}

/** Read-only tools a review worker keeps: context gathering without mutation. */
const READONLY_TOOLS = ['read', 'read_image', 'grep', 'glob'] as const

/**
 * Build a review worker for one run.
 * @param deps - Channel, services, and policy (accepted, never created).
 * @returns The worker whose `kind` is the requested channel.
 * @throws When the subagent channel is requested without a runtime or parent agent.
 */
export function createWorker(deps: WorkerDeps): ReviewWorker {
  if (deps.kind === 'subagent') {
    const { subagents, parent } = deps
    if (subagents === undefined || parent === undefined) {
      throw new Error('subagent workers requested but no subagent runtime or parent agent is available')
    }
    return {
      kind: 'subagent',
      run: (task, signal) => runSubagentWorker(subagents, parent, deps, task, signal),
    }
  }
  return {
    kind: 'llm',
    run: (task, signal) => runLlmWorker(deps, task, signal),
  }
}

/**
 * The subagent adapter: one isolated child per task — read-only toolset
 * (`toolFilter`), no delegation of its own (the cap equals the child's own
 * depth), and the configured output-token ceiling. Start-time capability
 * rejection propagates: a review never silently loses its restrictions.
 * @param subagents - The subagent runtime.
 * @param parent - The spawning agent.
 * @param deps - Worker policy (provider name, token ceiling).
 * @param task - The assignment.
 * @param signal - Caller cancellation.
 * @returns The structured document (schema-shaped, unvalidated beyond parse).
 */
async function runSubagentWorker(
  subagents: SubagentRuntime,
  parent: Agent,
  deps: WorkerDeps,
  task: WorkerTask,
  signal: AbortSignal,
): Promise<unknown> {
  const activation = await subagents.startActivation({
    provider: deps.subagentProvider,
    label: task.label,
    request: {
      prompt: [{ type: 'text', text: `${task.system}\n\n${task.user}` }],
      parent,
      outputSchema: task.schema,
      agentOptions: { maxTokens: deps.maxTokens },
      maxDepth: delegationDepthOf(parent) + 1,
      toolFilter: { allow: [...READONLY_TOOLS] },
    },
    signal,
    delivery: 'caller',
  })
  // A published activation cancels only through dispose(): wire the caller's
  // abort to it, or a cancelled tool call would leave the worker burning.
  const onAbort = (): void => {
    void activation.dispose().catch(() => { /* dispose failure surfaces through the settled result */ })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const result = await activation.result
    if (result.structured !== undefined) return result.structured
    throw new Error(`subagent produced no structured result (${result.stopReason}${result.diagnostic ? `: ${result.diagnostic}` : ''})`)
  } finally {
    signal.removeEventListener('abort', onAbort)
    await activation.dispose().catch(() => { /* teardown failure retains the captured result */ })
  }
}

/**
 * The llm adapter: one model call over packed context, parsed as a structured
 * document. Honors the caller's cancellation on the stream.
 * @param deps - Worker policy (route, token ceiling).
 * @param task - The assignment.
 * @param signal - Caller cancellation.
 * @returns The parsed structured document.
 * @throws When no model route is available or the output carries no JSON document.
 */
async function runLlmWorker(deps: WorkerDeps, task: WorkerTask, signal: AbortSignal): Promise<unknown> {
  const route = deps.route
  if (route === undefined) throw new Error('no LLM route captured yet; run a model request first or configure llmProvider/llmModel')
  let text = ''
  const stream = deps.llm.stream({
    provider: route.provider,
    model: route.model,
    system: task.system,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: task.user }] })],
    reasoningEffort: ReasoningEffortId('off'),
    maxTokens: deps.maxTokens,
    signal,
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return parseJsonDocument(text)
}

/** Parse a JSON document out of model text: bare object first, then a fenced block, then the first balanced brace run. */
function parseJsonDocument(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch { /* try fenced extraction */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed)
  if (fenced !== null) {
    try {
      return JSON.parse(fenced[1]!.trim())
    } catch { /* try brace scan */ }
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1))
  }
  throw new Error(`no JSON document in model output: ${trimmed.slice(0, 200)}`)
}

/* ─────────────────────────── worker-output contract ─────────────────────────── */

/** Structured-output schema every review worker satisfies. */
export const REVIEW_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repository-relative subject file path' },
          content: { type: 'string', description: 'The review comment' },
          start_line: { type: 'integer', description: '1-based start line in the new file' },
          end_line: { type: 'integer', description: '1-based end line in the new file' },
          severity: { type: 'string', enum: [...SEVERITIES] },
          category: { type: 'string', enum: [...CATEGORIES] },
          suggestion: { type: 'string', description: 'Suggested fix' },
          snippet: { type: 'string', description: 'Verbatim code copied from the diff' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['comments'],
  additionalProperties: false,
}

/** Structured-output schema for the reflection filter verdict. */
export const FILTER_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    approve_all: { type: 'boolean' },
    remove: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          reason: { type: 'string', enum: ['Ground A', 'Ground B'] },
          disproof: { type: 'string' },
        },
        required: ['index', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['approve_all'],
  additionalProperties: false,
}

/** One structured review comment produced by a worker and verified by the pipeline. */
export interface RawComment {
  /** Repository-relative path of the subject file. */
  path: string
  /** Review comment body. */
  content: string
  /** 1-based start line in the new file, when the worker located it. */
  startLine?: number
  /** 1-based end line in the new file. */
  endLine?: number
  severity?: string
  category?: string
  /** Optional suggested replacement or fix. */
  suggestion?: string
  /** Verbatim snippet copied from the diff's added lines; used for deterministic relocation. */
  snippet?: string
}

/** The reflection filter's verdict over one batch of comments. */
export interface FilterVerdict {
  /** Indices (into the batch) the filter proved wrong and removed. */
  removedIndices: Set<number>
}

/** Narrow an untrusted worker value to a plain record (model-JSON boundary). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Type guard over the finding severity vocabulary. */
export function isSeverity(value: string | undefined): value is FindingSeverity {
  return value !== undefined && (SEVERITIES as readonly string[]).includes(value)
}

/** Type guard over the finding category vocabulary. */
export function isCategory(value: string | undefined): value is FindingCategory {
  return value !== undefined && (CATEGORIES as readonly string[]).includes(value)
}

/** Spread helper: a positive integer field or nothing. */
function optionalNumber(value: unknown, key: 'startLine' | 'endLine'): Partial<RawComment> {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? { [key]: value } : {}
}

/** Spread helper: a recognized severity/category or nothing. */
function optionalVocabulary(value: unknown, key: 'severity' | 'category'): Partial<RawComment> {
  if (typeof value !== 'string') return {}
  if (key === 'severity') return isSeverity(value) ? { severity: value } : {}
  return isCategory(value) ? { category: value } : {}
}

/** Spread helper: a string field or nothing. */
function optionalString(value: unknown, key: 'suggestion' | 'snippet'): Partial<RawComment> {
  return typeof value === 'string' && value !== '' ? { [key]: value } : {}
}

/**
 * Admit one review worker's structured document: entries outside the worker's
 * own file list and malformed entries are dropped at this boundary.
 * @param raw - The untrusted structured document.
 * @param allowedFiles - The files the worker was assigned.
 * @returns The admitted raw comments in report order.
 */
export function normalizeComments(raw: unknown, allowedFiles: string[]): RawComment[] {
  const comments: unknown = isRecord(raw) ? raw['comments'] : undefined
  if (!Array.isArray(comments)) return []
  const out: RawComment[] = []
  for (const entry of comments) {
    if (!isRecord(entry)) continue
    const path = typeof entry['path'] === 'string' ? entry['path'] : ''
    const content = typeof entry['content'] === 'string' ? entry['content'] : ''
    if (path === '' || content === '' || !allowedFiles.includes(path)) continue
    out.push({
      path,
      content,
      ...optionalNumber(entry['start_line'], 'startLine'),
      ...optionalNumber(entry['end_line'], 'endLine'),
      ...optionalVocabulary(entry['severity'], 'severity'),
      ...optionalVocabulary(entry['category'], 'category'),
      ...optionalString(entry['suggestion'], 'suggestion'),
      ...optionalString(entry['snippet'], 'snippet'),
    })
  }
  return out
}

/**
 * Admit one reflection filter's structured verdict: indices are positions in
 * the comment batch the filter was shown. Fail-open policy lives with the
 * caller — a parse failure here is indistinguishable from "no removals".
 * @param raw - The untrusted structured document.
 * @param batchSize - The number of comments the filter was shown.
 * @returns The verdict with its removed indices.
 */
export function parseFilterVerdict(raw: unknown, batchSize: number): FilterVerdict {
  const removedIndices = new Set<number>()
  if (!isRecord(raw) || raw['approve_all'] === true) return { removedIndices }
  const removals = raw['remove']
  if (Array.isArray(removals)) {
    for (const entry of removals) {
      if (!isRecord(entry)) continue
      const index = entry['index']
      if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < batchSize) {
        removedIndices.add(index)
      }
    }
  }
  return { removedIndices }
}

/* ────────────────────────────── worker prose ────────────────────────────── */

/** System prompt for one bundle review worker. */
export const REVIEW_SYSTEM_PROMPT = `## Role
You are a code review assistant. You are responsible for producing professional review feedback on pull requests before they are merged. The diffs show what changed; use your tools to read or search related code when needed.
Please keep your responses concise and objective.

## Capabilities
- Think step by step progressively.
- First understand the code changes to be reviewed. Code changes are provided in Unified Diff format, where lines starting with \`-\` indicate deleted code, lines starting with \`+\` indicate added code, consecutive \`-\` and \`+\` lines represent modified code, and other lines represent unchanged code.
- Be objective and neutral, make judgments based on facts and logic, avoid subjective assumptions. When the context is unclear, use tools to obtain contextual information rather than judging based on assumptions.
- For the current code changes, provide feedback opinions, pointing out areas for improvement or potential issues. Focus on issues in newly added code.
- Avoid commenting on correct code or unchanged code.
- Avoid commenting on deleted code; deleted code serves only as reference context.
- Focus on clarity, practicality, and comprehensiveness.
- Focus primarily on the actual code logic and functionality. Avoid commenting on non-functional elements such as code comments, tool-generated indicators, or other metadata, unless explicitly requested.

## Strict Focus Rules
- Review every file listed in <review_files> individually.
- Cross-file observations within <review_files> are encouraged — look for inconsistencies, missing updates, and broken contracts across related files.
- Context exploration is for gathering background information only. Your comments must address code within <review_files> — never produce comments targeting files outside it.

## Output
Return your final result as one structured document: a "comments" array where every entry carries the subject "path", the issue "content", optional "start_line"/"end_line" (1-based, in the new file), a "severity" (critical|high|medium|low), a "category" (bug|security|performance|maintainability|test|style|documentation|other), an optional "suggestion", and an optional verbatim "snippet" copied from the diff's added lines that the comment targets.
Before finishing, confirm you have given every <file> in <review_files> its own pass. A file being the smaller or secondary member of the group is not a reason to skip it. If no issues are found, return an empty "comments" array — do not invent findings.`

/**
 * Build the review worker's user message.
 * @param params - Bundle diffs, sibling changes, rule checklist, and context.
 * @returns The composed user prompt.
 */
export function reviewUserPrompt(params: {
  otherChangedFiles: string[]
  diffs: string
  ruleText: string
  background?: string
  now: string
  /** Pre-review plan guidance (see {@link renderPlanGuidance}). */
  planGuidance?: string
}): string {
  const others = params.otherChangedFiles.length > 0 ? params.otherChangedFiles.join('\n') : '(none)'
  const background = params.background?.trim() ? params.background.trim() : '(not provided)'
  return `Other files changed in this update (not in this review group):
<other_changed_files>
${others}
</other_changed_files>

<review_files>
${params.diffs}
</review_files>

Current time in the real world: ${params.now}

<user_task>
### Requirement Background (Optional)
${background}

### Review Checklist
${params.ruleText}

### Review Plan
${params.planGuidance?.trim() ? params.planGuidance.trim() : '(not provided)'}

Now please review the code changes in <review_files> above and return the structured comments document.`
}

/** System prompt for the reflection filter (fact-checking pass). */
export const FILTER_SYSTEM_PROMPT = `You are a fact-checker for code review comments.

These review comments come from an Agent that could invoke tools to read the full codebase. You can see only the diffs of the files it reviewed together. Anything you cannot see, the Agent may well have seen.

Your task is narrow: remove only the comments that this diff **proves** to be factually wrong. You are not judging whether a comment is useful, well-prioritized, or worth a reviewer's time.

The two mistakes available to you are not equally bad:

- Keeping an incorrect comment costs a reviewer a few seconds of attention.
- Removing a correct comment silently destroys a real finding. It never reaches anyone, and nobody learns that it was dropped.

So when your evidence falls short of proof, approve. "Suspicious", "I cannot verify this", "low value", "the flagged code looks fine to me", and "I would not have raised this" all mean approve.

### The only two grounds for removal

**Ground A — the comment targets code that is not in its subject file's diff.**
The symbol, statement, or construct the comment describes appears nowhere in the <file> whose path the comment names. Typical shapes: it discusses the body of a function on a file that only declares or references it; it discusses host-language logic on a file that holds none; it claims code was removed or an error handled, and its subject file's diff contains no such change.

**Ground B — a specific diff line literally contradicts the comment's central claim.**
The comment asserts a concrete fact and the diffs show the opposite in plain text. The contradiction must be readable straight off the diff, not derived through a chain of reasoning.

If you cannot point to the specific diff line that establishes Ground A or Ground B, approve the comment.

### Protected subjects — never remove

These are vetoes, applied before you judge correctness at all. Whatever you conclude about the comment, approve it if its subject is memory safety (allocation size, buffer length, index bounds, off-by-one, use-after-free, null dereference); concurrency (locks and lock modes, atomics, data races, synchronization); linkage and declaration consistency; behavioral or compatibility change; or a parameter the function accepts and never uses. On a protected subject you do not get to be confident. Approve.

### Not grounds for removal

- Style, formatting, naming, or readability comments — provided what they state is true.
- Comments reasoning about runtime behavior, business semantics, or code in files you cannot see.
- Disagreement with the recommendation, or unverifiability.
- A real problem quoting a slightly wrong line. Judge the claim, not the citation.

### Method

For every comment: (1) protected-subject veto → approve and stop; (2) style/value veto on a true statement → approve and stop; (3) Ground A → remove; (4) Ground B → remove; (5) approve.`

/**
 * Build the reflection filter's user message.
 * @param params - Group diffs and the draft comments to check.
 * @returns The composed user prompt.
 */
export function filterUserPrompt(params: { diffs: string; comments: RawComment[] }): string {
  const list = params.comments
    .map((comment, index) =>
      `${index}. path=${comment.path}${comment.startLine !== undefined ? ` line=${comment.startLine}` : ''}\n   ${comment.content}`)
    .join('\n')
  return `### Code Diff

<review_files>
${params.diffs}
</review_files>

### Review Comments

${list}

### Output

Return one structured document: {"approve_all": true} when every comment survives, or {"approve_all": false, "remove": [{"index": <comment number>, "reason": "<Ground A or Ground B>", "disproof": "<the specific diff line that disproves it>"}]} listing only comments meeting Ground A or Ground B.`
}

/* ─────────────────────────── review plan (pre-review) ─────────────────────────── */

/** Structured-output schema for one bundle's pre-review plan. */
export const PLAN_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Brief purpose and scope of the change' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          description: { type: 'string', description: 'Location, nature, and potential impact of the risk' },
          tool_plan: {
            type: 'array',
            items: { type: 'string' },
            description: 'Planned context checks, one line each (tool intent, not an invocation)',
          },
        },
        required: ['severity', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'issues'],
  additionalProperties: false,
}

/** System prompt for the pre-review planner (ported from the upstream plan task). */
export const PLAN_SYSTEM_PROMPT = `You are an expert in code review task planning. Your responsibility is to analyze the code changes and produce a structured review plan: the risk points worth checking, and the context checks that would confirm each one.

## Analysis Rules
1. **Scope**: Only analyze newly added and modified code; ignore deleted code.
2. **Ordering**: Issues sorted by severity in descending order (high → medium → low).
3. **Severity Definitions**:
   - \`high\`: May cause security vulnerabilities, data loss, system crashes, or critical functional failures
   - \`medium\`: May affect performance, maintainability, or involve potential edge-case problems
   - \`low\`: Code style, readability, or non-critical best practice suggestions
4. **Context checks**: \`tool_plan\` lines are intentions for the reviewer, not actions — describe what to read or search and why it would confirm the risk.
5. **Description Requirements**: Each issue description must cover three dimensions — problem location, nature of the problem, and potential impact.
6. **Empty Result**: If the changes carry no identifiable risk, return an empty \`issues\` array. Do not invent issues to fill the list.

## Output
Return one structured document: \`summary\` (brief purpose and scope of the change) and \`issues\` (the risk points, most severe first).`

/**
 * Build the planner's user message (ported from the upstream plan task).
 * @param params - Bundle diffs, sibling changes, rule checklist, and context.
 * @returns The composed user prompt.
 */
export function planUserPrompt(params: {
  otherChangedFiles: string[]
  diffs: string
  ruleText: string
  background?: string
  now: string
}): string {
  const others = params.otherChangedFiles.length > 0 ? params.otherChangedFiles.join('\n') : '(none)'
  const background = params.background?.trim() ? params.background.trim() : '(not provided)'
  return `Other files changed in this update (not in this review group):
<other_changed_files>
${others}
</other_changed_files>

<review_files>
${params.diffs}
</review_files>

Current time in the real world: ${params.now}

### Requirement Background (Optional)
${background}

### Review Checklist
${params.ruleText}

### Task
Please analyze the code changes above and return the structured review plan.`
}

/** One planned risk point. */
export interface PlannedIssue {
  severity: string
  description: string
  toolPlan: string[]
}

/** One bundle's pre-review plan. */
export interface ReviewPlan {
  summary: string
  issues: PlannedIssue[]
}

/**
 * Admit a planner's structured document; malformed entries are dropped here.
 * @param raw - The untrusted structured document.
 * @returns The admitted plan (empty summary and issues when unusable).
 */
export function normalizePlan(raw: unknown): ReviewPlan {
  if (!isRecord(raw)) return { summary: '', issues: [] }
  const summary = typeof raw['summary'] === 'string' ? raw['summary'] : ''
  const entries = raw['issues']
  const issues: PlannedIssue[] = []
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!isRecord(entry)) continue
      const description = typeof entry['description'] === 'string' ? entry['description'] : ''
      const severity = typeof entry['severity'] === 'string' && ['high', 'medium', 'low'].includes(entry['severity'])
        ? entry['severity']
        : 'medium'
      if (description === '') continue
      const toolPlan = Array.isArray(entry['tool_plan'])
        ? entry['tool_plan'].filter((line): line is string => typeof line === 'string' && line.trim() !== '')
        : []
      issues.push({ severity, description, toolPlan })
    }
  }
  return { summary, issues }
}

/**
 * Render a plan as the review prompt's guidance block: the upstream plain-text
 * shape (Summary line, numbered severity-tagged issues, `→` context checks).
 * @param plan - The admitted plan.
 * @returns The guidance text, or the empty string when the plan carries nothing.
 */
export function renderPlanGuidance(plan: ReviewPlan): string {
  if (plan.summary.trim() === '' && plan.issues.length === 0) return ''
  const lines = [`Summary: ${plan.summary.trim()}`]
  plan.issues.forEach((issue, index) => {
    lines.push(`${index + 1}. [${issue.severity}] ${issue.description.trim()}`)
    for (const step of issue.toolPlan) lines.push(`   → ${step.trim()}`)
  })
  return lines.join('\n')
}

/* ─────────────────────── comment relocation (LLM fallback) ─────────────────────── */

/** Structured-output schema for one relocation batch. */
export const RELOCATE_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  properties: {
    locations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The comment number from the request' },
          snippet: {
            type: 'string',
            description: "Verbatim added lines copied from the diff, markers stripped, joined with newlines",
          },
        },
        required: ['index', 'snippet'],
        additionalProperties: false,
      },
    },
  },
  required: ['locations'],
  additionalProperties: false,
}

/** System prompt for comment relocation (ported from the upstream re-location task). */
export const RELOCATE_SYSTEM_PROMPT = `You are a code location assistant. Given a unified diff and review comments, your sole task is to extract the exact code snippet from the diff that each comment refers to.`

/**
 * Build the relocation batch's user message.
 * @param params - The bundle diff and the comments that failed deterministic anchoring.
 * @returns The composed user prompt.
 */
export function relocateUserPrompt(params: {
  diffs: string
  comments: Array<{ index: number; content: string; startLine?: number; snippet?: string }>
}): string {
  const list = params.comments
    .map(comment => {
      const at = comment.startLine !== undefined ? ` (claimed line ${comment.startLine})` : ''
      const prior = comment.snippet !== undefined ? `\n   previous snippet (failed to match): ${JSON.stringify(comment.snippet)}` : ''
      return `${comment.index}. ${comment.content}${at}${prior}`
    })
    .join('\n')
  return `Below is a unified diff and review comments whose positions could not be matched. For each comment, identify the minimal contiguous range of ADDED lines (lines starting with \`+\`) that it targets.

Rules:
1. Copy the relevant lines VERBATIM from the diff — do not rewrite, reformat, or add anything.
2. Strip the leading \`+\` marker from each copied line.
3. Include only the lines directly related to the issue — no surrounding context.
4. If multiple disjoint locations apply, pick the single most relevant one. If none applies, omit that comment.
5. Return one structured document with a \`locations\` entry per matched comment.

**Diff:**
\`\`\`diff
${params.diffs}\`\`\`

**Review comments:**
${list}`
}

/**
 * Admit a relocation batch's structured document: indices address the request's
 * comment list; empty snippets are dropped.
 * @param raw - The untrusted structured document.
 * @param batchSize - The number of comments the worker was shown.
 * @returns Matched snippets keyed by request index.
 */
export function parseRelocatedSnippets(raw: unknown, batchSize: number): Map<number, string> {
  const snippets = new Map<number, string>()
  if (!isRecord(raw)) return snippets
  const locations = raw['locations']
  if (!Array.isArray(locations)) return snippets
  for (const entry of locations) {
    if (!isRecord(entry)) continue
    const index = entry['index']
    const snippet = entry['snippet']
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= batchSize) continue
    if (typeof snippet !== 'string' || snippet.trim() === '') continue
    snippets.set(index, snippet)
  }
  return snippets
}
