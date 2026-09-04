/**
 * In-process assembly fixture for the dsh-mcp-settings host tests: the tools
 * runtime, an in-memory settings provider (the smallest real SettingsProvider
 * subclass, per the settings package's own test-fixture pattern), and the
 * manager plugin, booted on one bare Cordis context.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as McpSettings from '../src/index.ts'

/** The checkout root; the shared stdio MCP fixture server lives under it. */
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** Reuses the mcp-client package's stdio fixture server: tools `add`, `greet`, … */
export const fixtureServerPath = join(repoRoot, 'packages/mcp/mcp-client/tests/fixture-server.ts')

/** In-memory settings provider; records the would-be persisted document. */
export class MemoryProvider extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
  }
}

export interface Boot {
  ctx: Context
  provider: MemoryProvider
  webServer: WebServer
}

/** Mounts tools + settings + webserver + the manager plugin; `doc` pre-seeds persisted sections. */
export async function boot(options: { doc?: Record<string, unknown>; manager?: { statusErrorAfterMs?: number } } = {}): Promise<Boot> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemoryProvider, options)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(McpSettings, options.manager)
  const provider = ctx.get('settings')
  if (!(provider instanceof MemoryProvider)) throw new Error('settings service is not the MemoryProvider')
  const webServer = ctx.get('webServer')
  if (!(webServer instanceof WebServer)) throw new Error('webServer service is missing')
  return { ctx, provider, webServer }
}

/** Names of every tool in the global layer, as the agent's next request would see them. */
export function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name)
}
