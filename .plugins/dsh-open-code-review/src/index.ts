/**
 * @dsh-external/dsh-open-code-review — Alibaba OpenCodeReview's hybrid code
 * review as a DSH plugin. Deterministic engineering (git target selection,
 * layered rule resolution, related-file bundling, comment positioning) wraps
 * LLM review workers — one isolated subagent per bundle — followed by a
 * fact-checking reflection filter. Exposes `ocr_preview`, `ocr_rules`,
 * `ocr_review`, `ocr_scan`, a system-prompt guidance section, and a read-only
 * API route for the findings panel.
 * @module @dsh-external/dsh-open-code-review
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
// Type-only imports land the service augmentations (`ctx.subagents`,
// `ctx.webServer`, `ctx.workingDirectory`) on the shared Context.
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ReviewResult } from './types.ts'
import type { LlmRoute } from './worker.ts'
import { FINDINGS_API_PREFIX, FINDINGS_LAST_RUN_PATH } from './findings.ts'
import { registerOcrTools } from './tools.ts'
import type { ToolHost, ToolHostConfig } from './tools.ts'

export const name = '@dsh-external/dsh-open-code-review'
export const inject = ['tools', 'llm', 'systemPrompt']

/** Trust surface consumed here; the connection package owns the full type. */
interface ConnectionTrust {
  requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** Model-facing guidance order: after the core tool sections. */
const GUIDANCE_ORDER = 2850

/** Plugin configuration (deployment-varying choices are config, not constants). */
export interface Config {
  /** Worker channel: `auto` prefers isolated subagents when the host mounts them. */
  worker: 'auto' | 'subagent' | 'llm'
  /** Registered `ctx.subagents` provider name for isolated bundle workers. */
  subagentProvider: string
  /**
   * Agent Preset id mounting a read-only tool surface for isolated workers.
   * Without it the subagent channel refuses to run (rc.2 scopes child tools
   * through presets), and `worker: auto` falls back to the llm channel.
   */
  subagentPreset?: string
  /** LLM route for `llm` workers (provider + model must be set together). */
  llmProvider?: string
  llmModel?: string
  /**
   * Reasoning effort for `llm` workers. Unset leaves the field off the request so
   * the route applies its own default; a route that does not support the
   * requested effort refuses the call before I/O.
   */
  llmReasoningEffort?: string
  /**
   * Output-token ceiling for one worker request. A worker whose stream is cut
   * here returns no structured document and its whole bundle is skipped, so
   * large bundles need headroom.
   */
  maxTokens: number
  /** Cooperative timeout budget for one tool call, in milliseconds. */
  toolTimeoutMs: number
  /** Worker concurrency across bundles. */
  concurrency: number
  /** Run a pre-review plan task per bundle and feed its guidance to the review worker. */
  plan: boolean
  /** Comment positioning: deterministic only, or with the LLM relocation fallback. */
  relocation: 'deterministic' | 'llm'
  /** Exclusion globs applied at target selection. */
  exclude: string[]
  /** Repository-relative project rule file layered over the built-in ruleset. */
  ruleFile: string
  /** Whether the built-in per-language ruleset participates in resolution. */
  systemRules: boolean
  /** Whether to contribute the model-facing ocr_* guidance section. */
  guidance: boolean
  /** Whether to serve the read-only findings API route. */
  apiRoute: boolean
}

/** Schemastery configuration schema. */
export const Config: z<Config> = z.object({
  worker: z.union([z.const('auto'), z.const('subagent'), z.const('llm')]).default('auto'),
  subagentProvider: z.string().default('spawn'),
  subagentPreset: z.string(),
  llmProvider: z.string(),
  llmModel: z.string(),
  llmReasoningEffort: z.string(),
  maxTokens: z.number().min(256).max(65536).default(8192),
  toolTimeoutMs: z.number().min(60_000).max(3_600_000).default(1_800_000),
  concurrency: z.number().min(1).max(8).default(2),
  plan: z.boolean().default(true),
  relocation: z.union([z.const('deterministic'), z.const('llm')]).default('llm'),
  exclude: z.array(z.string()).default([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/*.min.js',
    '**/*.map',
    '**/*.lock',
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/yarn.lock',
    '**/go.sum',
    '**/*.snap',
  ]),
  ruleFile: z.string().default('.opencodereview/rule.json'),
  systemRules: z.boolean().default(true),
  guidance: z.boolean().default(true),
  apiRoute: z.boolean().default(true),
})

/** Latest recorded review/scan run, served by the findings API. */
interface RunRecord {
  kind: 'review' | 'scan'
  at: string
  payload: ReviewResult
}

/** Model-facing guidance: when and how to run the ocr_* workflow. */
const GUIDANCE = `## Code review (ocr_* tools)
For code review requests, use the OpenCodeReview tools instead of ad-hoc review:
- \`ocr_preview\` — deterministically select what to review (workspace / commit / branch range) and plan bundles.
- \`ocr_rules\` — fetch per-path review checklists (project rules merge over the built-in per-language ruleset).
- \`ocr_review\` — run the full hybrid review: isolated per-bundle review workers with codebase access, verified line positions, and a fact-checking filter that removes only proven-wrong comments.
- \`ocr_scan\` — audit whole files where there is no meaningful diff.
Triage findings: Critical/High (bugs, security, data loss) always report; Medium report with context; Low only when clearly valuable. Silently drop likely false positives. When the user asks to "review and fix", apply High/Critical fixes directly and describe Medium fixes that need manual work.`

/**
 * Mount the OpenCodeReview tools, guidance section, and findings API.
 * @param ctx - Plugin context (`tools`, `llm`, `systemPrompt` injected).
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // An empty string means "not configured": the README example uses '' as the
  // unset spelling, and an empty route would permanently shadow the observed one.
  const llmProvider = config.llmProvider !== undefined && config.llmProvider !== '' ? config.llmProvider : undefined
  const llmModel = config.llmModel !== undefined && config.llmModel !== '' ? config.llmModel : undefined
  if ((llmProvider === undefined) !== (llmModel === undefined)) {
    throw new Error(`${name}: llmProvider and llmModel must be configured together`)
  }
  const reasoningEffort = config.llmReasoningEffort !== undefined && config.llmReasoningEffort !== ''
    ? ReasoningEffortId(config.llmReasoningEffort)
    : undefined
  let observedRoute: LlmRoute | undefined
  let observedSessionId: GenerateOptions['sessionId']
  let lastRun: RunRecord | undefined

  // Observe the live model route and session id for `llm` workers: routes that
  // stamp session-scoped transport headers (opencode-go) refuse a bare call
  // (waterfall must delegate).
  ctx.on('llm/stream', (options, next) => {
    observedRoute = { provider: options.provider, model: options.model }
    observedSessionId = options.sessionId
    return next()
  })

  const toolConfig: ToolHostConfig = {
    worker: config.worker,
    subagentProvider: config.subagentProvider,
    ...(config.subagentPreset === undefined || config.subagentPreset === '' ? {} : { subagentPreset: config.subagentPreset }),
    ...(llmProvider !== undefined && llmModel !== undefined
      ? { llmRoute: { provider: llmProvider, model: llmModel } }
      : {}),
    ...(reasoningEffort === undefined ? {} : { llmReasoningEffort: reasoningEffort }),
    maxTokens: config.maxTokens,
    toolTimeoutMs: config.toolTimeoutMs,
    concurrency: config.concurrency,
    plan: config.plan,
    relocation: config.relocation,
    exclude: config.exclude,
    ruleFile: config.ruleFile,
    systemRules: config.systemRules,
  }

  const host: ToolHost = {
    config: toolConfig,
    llm: ctx.llm as LlmService,
    route: () => toolConfig.llmRoute ?? observedRoute,
    sessionId: () => observedSessionId,
    subagents: () => ctx.get('subagents'),
    defaultRepo: (agent: Agent | undefined, signal?: AbortSignal): Promise<string> => {
      const service = ctx.get('workingDirectory')
      if (service === undefined || agent === undefined) {
        throw new Error('no session working directory available; pass repo explicitly')
      }
      return service.ensure(agent, signal)
    },
    recordRun: (kind, payload) => {
      lastRun = { kind, at: new Date().toISOString(), payload }
    },
  }

  ctx.effect(() => registerOcrTools(ctx, host), `${name}: tools`)

  if (config.guidance) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'open-code-review:guidance',
      order: GUIDANCE_ORDER,
      text: GUIDANCE,
      interpolate: false,
    }), `${name}: guidance`)
  }

  if (config.apiRoute) {
    const webServer = ctx.get('webServer')
    if (webServer !== undefined) {
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: FINDINGS_API_PREFIX,
        handler: (req: IncomingMessage, res: ServerResponse) => {
          try {
            const connection: ConnectionTrust | undefined = ctx.get('connection')
            if (connection === undefined) {
              res.statusCode = 503
              res.end()
              return
            }
            const rejection = connection.requestRejection(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
          } catch {
            // Gate failures never leak internals to a pre-auth caller.
            res.statusCode = 500
            res.end('internal error')
            return
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          if (req.method !== 'GET' || url.pathname !== FINDINGS_LAST_RUN_PATH) {
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'not found' }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(lastRun ?? { kind: null }))
        },
      }), `${name}: api`)
    }
  }

  ctx.logger?.info?.(`[${name}] OpenCodeReview tools mounted (worker=${config.worker}, provider=${config.subagentProvider})`)
}
