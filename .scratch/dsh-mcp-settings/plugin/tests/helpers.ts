/**
 * In-process assembly fixture for the dsh-mcp-settings host tests: the tools
 * runtime, a webserver, and the manager plugin. The live boot mounts the
 * manager under the real Loader as a builtin entry, so `servers` updates go
 * through the same volatile-commit path the settings page drives; the canned
 * boot mounts it directly with a stand-in loader for the patch-configured
 * (loader-row) projection tests.
 */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Context, Service, resolveConfig, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { LoaderEntryFace } from '../src/index.ts'
import * as McpSettings from '../src/index.ts'

/** The checkout root; the shared stdio MCP fixture server lives under it. */
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/** Reuses the mcp-client package's stdio fixture server: tools `add`, `greet`, … */
export const fixtureServerPath = join(repoRoot, 'packages/mcp/mcp-client/tests/fixture-server.ts')

/** Stand-in loader service exposing canned entries; records update calls. */
export class FakeLoader extends Service {
  static readonly inject: string[] = []

  readonly updates: Array<{ id: string; options: { disabled: boolean } }> = []
  private readonly entriesList: LoaderEntryFace[]

  constructor(ctx: Context, config: { entries: LoaderEntryFace[] }) {
    super(ctx, 'loader')
    this.entriesList = config.entries
    for (const entry of this.entriesList) {
      const original = entry.update
      const recordedId = entry.id
      entry.update = async (options: { disabled: boolean }) => {
        this.updates.push({ id: recordedId, options })
        if (options.disabled) {
          entry.options.disabled = true
          entry.disabled = true
        } else {
          delete entry.options.disabled
          entry.disabled = undefined
        }
        await original(options)
      }
    }
  }

  *entries(): Iterable<LoaderEntryFace> {
    yield* this.entriesList
  }
}

/** One loader entry face with a mutable disabled flag. */
export function entryFace(id: string, name: string, config: Record<string, unknown> | undefined, disabled: boolean): LoaderEntryFace {
  const face: LoaderEntryFace = {
    id,
    options: { name, config, ...disabled ? { disabled: true } : {} },
    update: async () => { /* replaced by FakeLoader.update */ },
  }
  if (disabled) face.disabled = true
  return face
}

/** Deep-merge one patch into a nested config object, as a settings edit writes it. */
function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const before = result[key]
    result[key] = before && typeof before === 'object' && !Array.isArray(before)
      && value && typeof value === 'object' && !Array.isArray(value)
      ? merge(before as Record<string, unknown>, value as Record<string, unknown>) : value
  }
  return result
}

export interface LiveBoot {
  ctx: Context
  webServer: WebServer
  /** The manager's own Loader entry; its raw config carries the `servers` section. */
  entry: ReturnType<Loader['resolve']>
  fiber: Fiber
  /** Merge one patch into the entry config through the volatile-commit path. */
  update(patch: Record<string, unknown>): Promise<void>
  /** Replace the whole entry config through the volatile-commit path. */
  replace(next: Record<string, unknown>): Promise<void>
}

export interface CannedBoot {
  ctx: Context
  webServer: WebServer
  fakeLoader: FakeLoader
}

/** Mount tools + webserver + Loader + the manager entry; `servers` seeds the initial config. */
export async function boot(options: {
  servers?: Record<string, unknown>
  statusErrorAfterMs?: number
} = {}): Promise<LiveBoot> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Loader)
  const name = 'mcp-settings'
  ctx.loader.builtins[name] = McpSettings
  const initial: Record<string, unknown> = { servers: options.servers ?? {} }
  if (options.statusErrorAfterMs !== undefined) initial.statusErrorAfterMs = options.statusErrorAfterMs
  const id = await ctx.loader.create({ id: name, name: `cordis:${name}`, config: initial })
  const entry = ctx.loader.resolve(id)
  await entry.fiber!.await()
  const fiber = entry.fiber!
  const replace = async (next: Record<string, unknown>): Promise<void> => {
    resolveConfig(fiber.runtime!, fiber.ctx.waterfall(fiber, 'internal/config', next, () => next))
    await entry.update({ config: next })
    await fiber.await()
  }
  const webServer = ctx.get('webServer')
  if (!(webServer instanceof WebServer)) throw new Error('webServer service is missing')
  return {
    ctx,
    webServer,
    entry,
    fiber,
    update: patch => replace(merge(entry.options.config as Record<string, unknown>, patch)),
    replace,
  }
}

/** Mount tools + webserver + a canned loader + the manager plugin directly (no volatile wiring). */
export async function bootWithEntries(entries: LoaderEntryFace[], options: { statusErrorAfterMs?: number } = {}): Promise<CannedBoot> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FakeLoader, { entries })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(McpSettings, {
    servers: {},
    ...options.statusErrorAfterMs === undefined ? {} : { statusErrorAfterMs: options.statusErrorAfterMs },
  })
  const webServer = ctx.get('webServer')
  if (!(webServer instanceof WebServer)) throw new Error('webServer service is missing')
  const fakeLoader = ctx.get('loader')
  if (!(fakeLoader instanceof FakeLoader)) throw new Error('loader service is not the FakeLoader')
  return { ctx, webServer, fakeLoader }
}

/** Names of every tool in the global layer, as the agent's next request would see them. */
export function toolNames(ctx: Context): string[] {
  return ctx.tools.schemas().map(schema => schema.name)
}
