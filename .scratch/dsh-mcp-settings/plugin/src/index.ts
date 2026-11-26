/**
 * @dsh-external/dsh-mcp-settings — Host 半区：MCP 服务器管理器。
 *
 * 插件自身 Config 的 volatile `servers` 字段是唯一真相源（随所在 profile 的
 * patch 落盘；settings 页的写入以 loader volatile 提交到达，无需重启）。每个
 * 启用条目在本 ctx 上以进程内插件挂载一个 @deepseek-ai/dsh-mcp-client 实例
 * （root 作用域 → 工具进全局工具层，所有活动会话即时可见）；停用 / 删除 /
 * 管理器卸载即 dispose 对应 fiber（连接断开、工具注销、serverName 保留释放）。
 * 条目配置变更 = 换代（先 dispose 后重挂）。挂载失败（如 serverName 与 patch
 * 手工行冲突）只影响该条目：捕获后记录错误，不影响其它条目与宿主。
 * @module @dsh-external/dsh-mcp-settings
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Volatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVER_NAME_PATTERN, STATUS_PATH, TOGGLE_CONFIG_ROW_PATH, type McpTransport } from './wire.ts'

export { SERVER_NAME_PATTERN, STATUS_PATH, TOGGLE_CONFIG_ROW_PATH } from './wire.ts'

/** Cordis plugin name; the injector keys loader rows by the package name. */
export const name = '@dsh-external/dsh-mcp-settings'

/** `webServer` serves the status projection; `tools` counts live registrations. The loader is read optionally: config rows are a projection, never a startup dependency. Settings arrives optionally: it only carries this entry's page policy. */
export const inject = ['tools', 'webServer']

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
    /** Whether the entry is disabled at the options level; `EntryOptions.disabled` is nullable. */
    disabled?: boolean | null
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

/** Resolved shape of the manager's `servers` section. */
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
   *
   * Every include entry is a candidate and the first whose sibling patch file
   * actually exists wins, so a profile composing several bases — or one whose
   * path is not a `.yml` file at all — is still resolved instead of throwing on
   * the first entry inspected.
   */
  function profilePatchPathOf(loader: LoaderFace): string {
    const candidates: string[] = []
    for (const entry of loader.entries()) {
      if (entry.id !== 'include') continue
      const basePath = entry.options.config?.path
      if (typeof basePath !== 'string' || basePath === '') continue
      // The include carries its base config as a file: URL in the running host.
      const clean = basePath.startsWith('file:') ? fileURLToPath(basePath) : basePath
      const base = clean.endsWith('.yml') || clean.endsWith('.yaml') ? dirname(clean) : clean
      candidates.push(join(base, 'cordis.patch.yml'))
    }
    const found = candidates.find(candidate => existsSync(candidate))
    if (found !== undefined) return found
    throw new Error(`mcp-settings: cannot locate the profile patch file (tried ${candidates.join(', ')})`)
  }

/**
 * Rewrite the row for `entryId` in the profile patch, or append it when absent.
 *
 * The include applier indexes patch targets by the ROOT-level id the insert
 * declared ("mcp-context7"); a nested loader id ("include:mcp-context7")
 * would warn and skip, so the original insert would win on every re-apply.
 * `leafId` is therefore both the lookup key and the row's own id.
 *
 * The row is located at ROOT level only: a nested `- id:` (an insert's child,
 * a disabled group) belongs to another owner and must not be rewritten from
 * under it. Absent, the row is appended — a missing patch file is created,
 * and the loader picks it up on watch.
 * @param existing - the patch file's current text ('' when it does not exist).
 * @param leafId - the root-level id to upsert.
 * @param row - the replacement row, ending in a newline.
 * @returns the new file text.
 */
function upsertPatchRow(existing: string, leafId: string, row: string): string {
  const lines = existing.split('\n')
  const header = `- id: ${leafId}`
  const start = lines.findIndex(line => line.trimEnd() === header)
  if (start === -1) {
    const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
    return `${existing}${separator}${row}`
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith('- ')) {
      end = i
      break
    }
  }
  return [...lines.slice(0, start), ...row.replace(/\n$/, '').split('\n'), ...lines.slice(end)].join('\n')
}

/**
 * Make the profile patch carry exactly one enabled/disabled row for a loader
 * entry, replacing any previous row for the same id.
 *
 * Appending grew the file by one row per toggle, so flipping a row back and
 * forth left a duplicate `- id:` block for each flip in the user's patch. The
 * upsert keeps the file canonical no matter how often the row is toggled.
 * @param patchPath - the profile patch file to rewrite.
 * @param entryId - the loader entry id whose row is written.
 * @param moduleName - the loader row's module name.
 * @param enabled - whether the entry should end up enabled.
 */
export async function writePatchRow(patchPath: string, entryId: string, moduleName: string, enabled: boolean): Promise<void> {
  const leafId = entryId.slice(entryId.lastIndexOf(':') + 1)
  const row = `- id: ${leafId}\n  name: '${moduleName}'\n  disabled: ${String(!enabled)}\n`
  await mkdir(dirname(patchPath), { recursive: true })
  let existing = ''
  try {
    existing = await readFile(patchPath, 'utf8')
  } catch {
    // A missing patch file is created with the row; the loader picks it up on watch.
  }
  await writeFile(patchPath, upsertPatchRow(existing, leafId, row))
}

/** Header a same-origin caller must send for a config-row toggle to run. */
const TOGGLE_ORIGIN_HEADER = 'x-cbm-settings'

/**
 * Refuse a cross-origin toggle before any body is read.
 *
 * The webserver answers no CORS preflight, so a foreign page cannot send the
 * custom header itself — only scripts already running in the settings page
 * (same origin), curl, or a local agent can. `Sec-Fetch-Site`, sent by every
 * current browser, is a second opinion: anything that is neither same-origin
 * nor a direct navigation is rejected even if it somehow carries the header.
 */
function toggleOriginAllowed(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
  return req.headers[TOGGLE_ORIGIN_HEADER] === '1'
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

/**
 * Plugin config: the settings section the MCP page edits, plus the deployment
 * timing the manager reads once. `servers` is volatile — a settings write
 * reaches the running manager through a loader volatile commit and a
 * `loader/volatile-update` event, without remounting it.
 */
export interface Config {
  /** Milliseconds after mount before a server with zero live tools is reported as starting-failed (still auto-retrying). */
  statusErrorAfterMs: number
  /** Managed servers, keyed by serverName. */
  servers: Volatile<Record<string, McpServerEntry>>
}

/** Plain options: the same shape with volatile fields unwrapped, as raw configs spell it. */
export type Options = { [K in keyof Config]?: Config[K] extends Volatile<infer T> ? T : Config[K] }

export const Config = z.object({
  statusErrorAfterMs: z.number().min(100).default(10_000),
  servers: z.dict(ServerEntry).default({}).volatile(),
})

/**
 * Below this length a "secret" is indistinguishable from ordinary prose:
 * masking a one- or two-character string shreds unrelated error text (an HTTP
 * status, a port number) while protecting nothing.
 */
const REDACT_MIN_CHARS = 4

/** The two `role('secret')` dicts `ServerEntry` declares; a third secret field must join this list. */
const SECRET_FIELDS = ['env', 'headers'] as const

/**
 * Mask every secret value inside a status message.
 *
 * The stored values alone are NOT sufficient: `mountConfig` expands `${VAR}`
 * references against the host environment before the server sees them, so a
 * mount failure quotes the RESOLVED value — a 401 or a connection error
 * carrying `Authorization: Bearer sk-...` would otherwise reach the status
 * route unmasked. `mounted` supplies the expanded maps; it is absent only when
 * the failure happened while building the config (an unresolved `${VAR}`),
 * where the stored reference is all that exists.
 *
 * The field list mirrors `ServerEntry`; `dsh-settings`' `redactSecrets` cannot
 * serve here because it reports secret POSITIONS, not the values, and this
 * scrubber has to rewrite free text rather than a structured value.
 * @param message - the raw failure text.
 * @param entry - the settings entry it came from.
 * @param mounted - the resolved mcp-client config, when the mount was attempted.
 * @returns the message with every known secret value masked.
 */
export function redactStatusError(message: string, entry: McpServerEntry, mounted?: McpClient.Config): string {
  const secrets = new Set<string>()
  // An error-reporting path must never throw itself: a section that bypassed
  // schema defaults (or a schema change) still yields a masked message.
  const stored = (entry ?? {}) as Partial<Record<(typeof SECRET_FIELDS)[number], Record<string, string> | undefined>>
  for (const field of SECRET_FIELDS) {
    for (const value of Object.values(stored[field] ?? {})) secrets.add(value)
  }
  if (mounted !== undefined) {
    // Each transport names its secret map once; the discriminant selects it.
    const live = mounted.transport === 'stdio' ? mounted.env : mounted.headers
    for (const value of Object.values(live)) secrets.add(value)
  }
  let output = message
  // Longest first: a secret containing another secret's text must not leave a
  // fragment of itself behind once the shorter one has already been masked.
  for (const value of [...secrets].filter(v => v.length >= REDACT_MIN_CHARS).sort((a, b) => b.length - a.length)) {
    output = output.replaceAll(value, '***')
  }
  return output
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const mounts = new Map<string, Mount>()
  const failures = new Map<string, string>()
  const toolCounts = new Map<string, number>()
  const startingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Live servers section: the plugin's own volatile config, resolved with per-entry defaults. */
  const source = (): McpServersSection => ({ servers: config.servers.get() as Record<string, McpServerEntry> })
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
      let mounted: McpClient.Config | undefined
      try {
        // Built before the mount try so a bad transport (missing command/url,
        // unresolved ${VAR}) lands in the entry's error state, not the queue.
        const resolved = mountConfig(serverName, entry)
        mounted = resolved
        const signature = JSON.stringify(resolved)
        if (mount?.signature === signature) continue
        if (mount) {
          mounts.delete(serverName)
          toolCounts.delete(serverName)
          clearStartingTimer(serverName)
          await mount.fiber.dispose()
        }
        const fiber = await ctx.plugin(McpClient, resolved)
        mounts.set(serverName, { fiber, signature })
        failures.delete(serverName)
        armStartingTimer(serverName)
      } catch (reason) {
        // A bad entry is inert: it never crashes the host or its neighbours.
        // `mounted` is undefined exactly when the config could not be built,
        // which is the one case whose message holds no expanded secret.
        failures.set(serverName, redactStatusError(String(reason), entry, mounted))
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
    // `ctx.get` is the typed accessor for the `loader` service that
    // `cordis-plugin-loader` declares on `Context`; unlike `ctx.loader` it does
    // not demand a static `inject` entry, and the guard keeps a host without the
    // service (this plugin is useful without the loader) on the empty path.
    const loader: LoaderFace | undefined = ctx.get('loader')
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
   *
   * The patch file is written before the runtime is touched: it is what
   * survives a restart, so a failed write must leave the running composition
   * untouched rather than flip the runtime and silently revert on next launch.
   */
  async function setConfigRowEnabled(serverName: string, enabled: boolean): Promise<void> {
    const loader: LoaderFace | undefined = ctx.get('loader')
    if (loader === undefined) throw new Error('mcp-settings: loader service is unavailable')
    let target: LoaderEntryFace | undefined
    for (const entry of loader.entries()) {
      if (entry.options.name === MCP_CLIENT_PACKAGE && entry.options.config?.serverName === serverName) {
        target = entry
        break
      }
    }
    if (target === undefined) throw new Error(`mcp-settings: no patch-configured mcp-client row named "${serverName}"`)
    const patchPath = profilePatchPathOf(loader)
    await writePatchRow(patchPath, target.id, MCP_CLIENT_PACKAGE, enabled)
    await target.update({ disabled: !enabled })
    refreshToolCounts()
  }

  const enqueueSync = (): void => {
    if (disposing) return
    queue = queue.then(syncNow, syncNow)
  }

  // A settings write lands as a volatile commit on this entry: re-sync mounts in place.
  ctx.on('loader/volatile-update', () => { enqueueSync() })

  // Refuse sections the schema cannot judge (serverName pattern, transport pairing) before they persist.
  ctx.on('internal/config', function (this: Fiber, _raw, next) {
    const raw: unknown = next()
    if (this !== ctx.fiber) return raw
    validateSection({ servers: Config(raw as Options).servers.get() as Record<string, McpServerEntry> })
    return raw
  })

  // This plugin serves its own page: suppress any auto-generated configuration page for the entry.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })

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
          if (!toggleOriginAllowed(req)) {
            throw new TypeError('mcp-settings: cross-origin toggle refused')
          }
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

  // Mount the entries the current configuration already enables.
  enqueueSync()
}
