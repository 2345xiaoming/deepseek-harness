/**
 * @dsh-external/dsh-mcp-settings — Host 半区：MCP 服务器管理器。
 *
 * settings namespace `mcp-servers` 是唯一真相源。每个启用条目在本 ctx 上以
 * 进程内插件挂载一个 @deepseek-ai/dsh-mcp-client 实例（root 作用域 → 工具进
 * 全局工具层，所有活动会话即时可见）；停用 / 删除 / 管理器卸载即 dispose 对
 * 应 fiber（连接断开、工具注销、serverName 保留释放）。条目配置变更 = 换代
 * （先 dispose 后重挂）。挂载失败（如 serverName 与 patch 手工行冲突）只影响
 * 该条目：捕获后记录错误，不影响其它条目与宿主。
 * @module @dsh-external/dsh-mcp-settings
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage } from 'node:http'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCP_SERVERS_NAMESPACE, SERVER_NAME_PATTERN, STATUS_PATH, TOGGLE_CONFIG_ROW_PATH, type McpTransport } from './wire.ts'

export { MCP_SERVERS_NAMESPACE, SERVER_NAME_PATTERN, STATUS_PATH, TOGGLE_CONFIG_ROW_PATH } from './wire.ts'

/** Cordis plugin name; the injector keys loader rows by the package name. */
export const name = '@dsh-external/dsh-mcp-settings'

/** Settings consumer; `webServer` serves the status projection; `tools` counts live registrations. The loader is read optionally: config rows are a projection, never a startup dependency. */
export const inject = ['settings', 'tools', 'webServer']

/** Loader row module name for patch-configured mcp-client servers. */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Minimal structural face of a loader entry this plugin touches. */
export interface LoaderEntryFace {
  /** Loader entry id (the patch row key). */
  readonly id: string
  /** Resolved entry options (module name, config, disabled). */
  readonly options: {
    /** Module name of the row (the plugin package). */
    name?: string
    /** Whether the entry is disabled at the options level. */
    disabled?: boolean
    /** The mcp-client plugin config of the row. */
    config?: Record<string, unknown>
  }
  /** Effective disabled state (includes ancestor-group/expression logic). */
  readonly disabled?: boolean
  /** Apply an options patch (disposes/re-applies the fiber transactionally). */
  update(options: { disabled: boolean }): Promise<void>
}

/** Minimal structural face of the loader service. */
export interface LoaderFace {
  entries(): Iterable<LoaderEntryFace>
}

/** One server's projected runtime state (never stored in the settings document). */
export interface McpServerStatus {
  /** Whether the entry is enabled (mounted or mounting). */
  enabled: boolean
  /** Last mount error, when the last mount attempt rejected. */
  error?: string
  /** Count of live `mcp__<name>__*` tools in the global layer. */
  toolCount: number
}

/** One patch-configured mcp-client row's projected state. */
export interface McpConfigRowStatus {
  /** The mcp-client serverName of the row. */
  serverName: string
  /** Whether the loader entry is currently enabled. */
  enabled: boolean
  /** Count of live `mcp__<serverName>__*` tools in the global layer. */
  toolCount: number
}

/** JSON payload of the status route. */
export interface McpStatusDocument {
  servers: Record<string, McpServerStatus>
  /** Patch-configured mcp-client rows (read-only config, toggleable). */
  configRows: McpConfigRowStatus[]
}

/** One managed MCP server. Flat object: dict keys and secret fields stay reachable for wire redaction. */
export interface McpServerEntry {
  /** Whether the server is currently mounted. Disabled entries keep their configuration. */
  enabled: boolean
  /** Transport discriminant. */
  transport: McpTransport
  /** stdio: executable to spawn. Required when `transport` is `stdio`. */
  command?: string
  /** stdio: arguments for the spawned command. */
  args: string[]
  /** stdio: per-process environment; values are wire-redacted secrets. */
  env: Record<string, string>
  /** stdio: working directory of the spawned command; empty means inherit. */
  cwd: string
  /** streamable-http: endpoint URL. Required when `transport` is `streamable-http`. */
  url?: string
  /** streamable-http: request headers; values are wire-redacted secrets. */
  headers: Record<string, string>
}

/** Resolved shape of the `mcp-servers` settings namespace. */
export interface McpServersSection {
  /** Managed servers, keyed by serverName. */
  servers: Record<string, McpServerEntry>
}

const ServerEntry: z<McpServerEntry> = z.object({
  enabled: z.boolean().default(true),
  transport: z.union([z.const('stdio'), z.const('streamable-http')]).required(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string().role('secret')).default({}),
  cwd: z.string().default(''),
  url: z.string(),
  headers: z.dict(z.string().role('secret')).default({}),
})

export const Section: z<McpServersSection> = z.object({
  servers: z.dict(ServerEntry).default({}),
})

/**
 * Reject malformed resolved sections before they persist. Transport pairing
 * cannot live in the flat schema (one object serves both discriminants);
 * serverName is a dict key and cannot be schema-constrained per-key.
 * @param value - the resolved candidate section.
 * @throws {TypeError} when a key is not a legal serverName or the transport
 * fields are not paired.
 */
export function validateSection(value: McpServersSection): void {
  for (const [serverName, entry] of Object.entries(value.servers)) {
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      throw new TypeError(`mcp-servers: key "${serverName}" must match ${String(SERVER_NAME_PATTERN)}`)
    }
    if (entry.transport === 'stdio') {
      if (!entry.command || entry.command.length === 0) {
        throw new TypeError(`mcp-servers(${serverName}): transport stdio requires a non-empty command`)
      }
    } else if (!entry.url || entry.url.length === 0) {
      throw new TypeError(`mcp-servers(${serverName}): transport streamable-http requires a non-empty url`)
    } else {
      try {
        new URL(entry.url)
      } catch {
        throw new TypeError(`mcp-servers(${serverName}): url is not a valid absolute URL`)
      }
    }
  }
}

/** An exact `${NAME}` reference inside a secret/header value. */
const VAR_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/**
 * Expand an exact `${NAME}` reference against the host process environment.
 * Anything else (plain text, partial references) passes through unchanged.
 * @param value - the stored value.
 * @returns the expanded value.
 * @throws {TypeError} when a referenced variable is not set in the host environment.
 */
export function expandVar(value: string): string {
  const match = VAR_REFERENCE.exec(value)
  if (match === null) return value
  const name = match[1]!
  const resolved = process.env[name]
  if (resolved === undefined) {
    throw new TypeError(`mcp-servers: environment variable "${name}" referenced by ${value} is not set`)
  }
  return resolved
}

/**
 * Project one settings entry onto the mcp-client plugin config. Passing through
 * the mcp-client `Config` schema (the ACP mount path's precedent) resolves its
 * defaults (tool-call timeout, startup policy, reconnect); `failOnStartupError`
 * stays at the schema default so an unreachable server keeps retrying instead
 * of failing the mount. `${VAR}` references in env/header values expand before
 * the schema resolves.
 * @param serverName - the entry key, which is the mcp-client serverName.
 * @param entry - the resolved entry.
 * @returns the resolved mount config for one mcp-client instance.
 */
export function mountConfig(serverName: string, entry: McpServerEntry): McpClient.Config {
  if (entry.transport === 'stdio') {
    return McpClient.Config({
      transport: 'stdio',
      serverName,
      command: entry.command ?? '',
      args: entry.args,
      env: Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, expandVar(value)])),
      cwd: entry.cwd,
    })
  }
  return McpClient.Config({
    transport: 'streamable-http',
    serverName,
    url: entry.url ?? '',
    headers: Object.fromEntries(Object.entries(entry.headers).map(([key, value]) => [key, expandVar(value)])),
  })
}

/** A mounted generation: its fiber plus the config signature it was started with. */
interface Mount {
  fiber: Fiber
  signature: string
}

/**
 * Locate the profile's patch file: the include entry's config `path` is the
 * base cordis.yml of the profile, so the co-located `cordis.patch.yml` is the
 * user patch layer (the same file `watchUserPatches` applies).
 */
function profilePatchPathOf(loader: LoaderFace): string {
  for (const entry of loader.entries()) {
    if (entry.id !== 'include') continue
    const basePath = entry.options.config?.path
    if (typeof basePath === 'string' && basePath !== '') {
      // The include carries its base config as a file: URL in the running host.
      const clean = basePath.startsWith('file:') ? fileURLToPath(basePath) : basePath
      return join(dirname(clean), 'cordis.patch.yml')
    }
  }
  throw new Error('mcp-settings: cannot locate the profile patch file (include entry has no config path)')
}

/** Append one id-targeted disabled/enabled patch row for a loader entry. */
export async function appendPatchRow(patchPath: string, entryId: string, moduleName: string, enabled: boolean): Promise<void> {
  // The include applier indexes patch targets by the ROOT-level id the insert
  // declared ("mcp-context7"); a nested loader id ("include:mcp-context7")
  // would warn and skip, so the original insert would win on every re-apply.
  const leafId = entryId.slice(entryId.lastIndexOf(':') + 1)
  const row = `\n- id: ${leafId}\n  name: '${moduleName}'\n  disabled: ${String(!enabled)}\n`
  await mkdir(dirname(patchPath), { recursive: true })
  let existing = ''
  try {
    existing = await readFile(patchPath, 'utf8')
  } catch {
    // A missing patch file is created with the row; the loader picks it up on watch.
  }
  await appendFile(patchPath, existing.endsWith('\n') ? row : '\n' + row)
}

/** Read a bounded JSON request body. @throws {TypeError} on invalid JSON or oversized bodies. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > 64 * 1024) {
        reject(new TypeError('mcp-settings: request body exceeds 64 KiB'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new TypeError('mcp-settings: request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** Plugin config: deployment-varying timings the manager needs. */
export interface Config {
  /** Seconds after mount before a server with zero live tools is reported as starting-failed (still auto-retrying). */
  statusErrorAfterMs: number
}

export const Config: z<Config> = z.object({
  statusErrorAfterMs: z.number().min(100).default(10_000),
})

/** Replace every stored secret value in a status message with a marker. */
function redactStatusError(message: string, entry: McpServerEntry): string {
  let output = message
  const secretValues = [...Object.values(entry.env), ...Object.values(entry.headers)]
  for (const value of secretValues) {
    if (value.length > 0) output = output.replaceAll(value, '***')
  }
  return output
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const mounts = new Map<string, Mount>()
  const failures = new Map<string, string>()
  const toolCounts = new Map<string, number>()
  const startingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let source: () => McpServersSection = () => ({ servers: {} })
  let queue: Promise<void> = Promise.resolve()
  let disposing = false

  function refreshToolCounts(): void {
    const names = ctx.tools.schemas()
    for (const [serverName] of mounts) {
      toolCounts.set(serverName, names.filter(schema => schema.name.startsWith(`mcp__${serverName}__`)).length)
      if (toolCounts.get(serverName)! > 0) failures.delete(serverName)
    }
  }

  /** Schedule the "initial connection still failing" report for one entry. */
  function armStartingTimer(serverName: string): void {
    clearStartingTimer(serverName)
    startingTimers.set(serverName, setTimeout(() => {
      if (disposing || !mounts.has(serverName)) return
      if ((toolCounts.get(serverName) ?? 0) === 0 && !failures.has(serverName)) {
        failures.set(serverName, 'initial connection failed; still retrying')
      }
    }, config.statusErrorAfterMs))
  }

  function clearStartingTimer(serverName: string): void {
    const timer = startingTimers.get(serverName)
    if (timer !== undefined) {
      clearTimeout(timer)
      startingTimers.delete(serverName)
    }
  }

  async function syncNow(): Promise<void> {
    const section = source()
    const desired = new Set<string>()
    for (const [serverName, entry] of Object.entries(section.servers)) {
      desired.add(serverName)
      const mount = mounts.get(serverName)
      if (!entry.enabled) {
        failures.delete(serverName)
        toolCounts.delete(serverName)
        clearStartingTimer(serverName)
        if (mount) {
          mounts.delete(serverName)
          await mount.fiber.dispose()
        }
        continue
      }
      try {
        // Built before the mount try so a bad transport (missing command/url,
        // unresolved ${VAR}) lands in the entry's error state, not the queue.
        const config = mountConfig(serverName, entry)
        const signature = JSON.stringify(config)
        if (mount?.signature === signature) continue
        if (mount) {
          mounts.delete(serverName)
          toolCounts.delete(serverName)
          clearStartingTimer(serverName)
          await mount.fiber.dispose()
        }
        const fiber = await ctx.plugin(McpClient, config)
        mounts.set(serverName, { fiber, signature })
        failures.delete(serverName)
        armStartingTimer(serverName)
      } catch (reason) {
        // A bad entry is inert: it never crashes the host or its neighbours.
        failures.set(serverName, redactStatusError(String(reason), entry))
        ctx.logger.warn(`mcp-settings: failed to mount "${serverName}":`, reason)
      }
    }
    for (const [serverName, mount] of [...mounts]) {
      if (desired.has(serverName)) continue
      mounts.delete(serverName)
      toolCounts.delete(serverName)
      clearStartingTimer(serverName)
      await mount.fiber.dispose()
    }
    refreshToolCounts()
  }

  function toolCountOf(serverName: string): number {
    return ctx.tools.schemas().filter(schema => schema.name.startsWith(`mcp__${serverName}__`)).length
  }

  /** Every loader row mounting an mcp-client instance, with its serverName. */
  function configRowsOf(): McpConfigRowStatus[] {
    const loader = ctx.get('loader') as unknown as LoaderFace | undefined
    if (loader === undefined) return []
    const rows: McpConfigRowStatus[] = []
    for (const entry of loader.entries()) {
      if (entry.options.name !== MCP_CLIENT_PACKAGE) continue
      const serverName = entry.options.config?.serverName
      if (typeof serverName !== 'string' || serverName === '') continue
      const disabled = entry.disabled === true || entry.options.disabled === true
      rows.push({
        serverName,
        enabled: !disabled,
        toolCount: disabled ? 0 : toolCountOf(serverName),
      })
    }
    rows.sort((a, b) => a.serverName.localeCompare(b.serverName))
    return rows
  }

  function statusDocument(): McpStatusDocument {
    const servers: Record<string, McpServerStatus> = {}
    for (const [serverName, entry] of Object.entries(source().servers)) {
      const error = failures.get(serverName)
      servers[serverName] = {
        enabled: entry.enabled,
        ...error === undefined ? {} : { error },
        toolCount: entry.enabled ? (toolCounts.get(serverName) ?? 0) : 0,
      }
    }
    return { servers, configRows: configRowsOf() }
  }

  /**
   * Set one config row's disabled flag at runtime and persist an id-targeted
   * patch row (the loader include re-applies it, surviving restarts).
   */
  async function setConfigRowEnabled(serverName: string, enabled: boolean): Promise<void> {
    const loader = ctx.get('loader') as unknown as LoaderFace | undefined
    if (loader === undefined) throw new Error('mcp-settings: loader service is unavailable')
    let target: LoaderEntryFace | undefined
    for (const entry of loader.entries()) {
      if (entry.options.name === MCP_CLIENT_PACKAGE && entry.options.config?.serverName === serverName) {
        target = entry
        break
      }
    }
    if (target === undefined) throw new Error(`mcp-settings: no patch-configured mcp-client row named "${serverName}"`)
    await target.update({ disabled: !enabled })
    const patchPath = profilePatchPathOf(loader)
    await appendPatchRow(patchPath, target.id, MCP_CLIENT_PACKAGE, enabled)
    refreshToolCounts()
  }

  const enqueueSync = (): void => {
    if (disposing) return
    queue = queue.then(syncNow, syncNow)
  }

  ctx.settings.installSection(ctx, MCP_SERVERS_NAMESPACE, Section, { servers: {} }, {
    setSource: current => void (source = current),
    validate: validateSection,
    onChange: enqueueSync,
  })

  ctx.effect(() => ctx.on('tools/change', refreshToolCounts), 'mcp-settings.tools-count')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(statusDocument()))
    },
  }), 'mcp-settings.status-route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: TOGGLE_CONFIG_ROW_PATH,
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readJsonBody(req)
          const serverName = (body as { serverName?: unknown }).serverName
          const enabled = (body as { enabled?: unknown }).enabled
          if (typeof serverName !== 'string' || typeof enabled !== 'boolean') {
            throw new TypeError('mcp-settings: toggle body must carry string serverName and boolean enabled')
          }
          await setConfigRowEnabled(serverName, enabled)
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true }))
        } catch (reason) {
          res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: String(reason instanceof Error ? reason.message : reason) }))
        }
      })()
    },
  }), 'mcp-settings.config-row-toggle')

  ctx.effect(async () => async () => {
    disposing = true
    for (const timer of startingTimers.values()) clearTimeout(timer)
    startingTimers.clear()
    // Named swallow: the queue's tail at teardown; failures were already
    // reported per entry by syncNow, and nothing may block reaching quiescence.
    await queue.catch(() => {})
    for (const mount of mounts.values()) await mount.fiber.dispose()
    mounts.clear()
  }, 'mcp-settings.mounts')
}
