/**
 * Wire-level shapes of the `mcp-servers` settings namespace, shared by the
 * host half (its source of truth) and the client half (the settings section
 * form). The client bundle never imports the host module; both import this
 * file. env/headers values are wire-redacted secrets: the namespace's
 * `describe` response omits them and lists their paths in `secrets`.
 */

/** Settings namespace owned by this feature; registered by the host manager. */
export const MCP_SERVERS_NAMESPACE: 'mcp-servers' = 'mcp-servers'

/** Status route served by the host manager to the settings section. */
export const STATUS_PATH = '/@dsh-external/dsh-mcp-settings/status'

/** The transports the page manages, mirroring mcp-client's discriminant. */
export type McpTransport = 'stdio' | 'streamable-http'

/** One managed MCP server as stored in the settings document. */
export interface McpServerEntryWire {
  enabled?: boolean
  transport: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

/** Resolved shape of the whole namespace section. */
export interface McpServersSectionWire {
  servers: Record<string, McpServerEntryWire>
}

/** mcp-client's serverName charset, mirrored for client-side form validation. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Structurally narrow a wire section; undefined keeps the last accepted snapshot. */
export function decodeMcpServersSection(section: unknown): McpServersSectionWire | undefined {
  if (typeof section !== 'object' || section === null) return undefined
  const servers = (section as { servers?: unknown }).servers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return undefined
  return { servers: servers as Record<string, McpServerEntryWire> }
}

/** One server's projected runtime state from the Host status route. */
export interface McpServerStatusWire {
  /** Whether the entry is enabled (mounted or mounting). */
  enabled: boolean
  /** Last mount error, when the last mount attempt rejected. */
  error?: string
  /** Count of live `mcp__<name>__*` tools in the global layer. */
  toolCount: number
}

/** JSON payload of the Host status route. */
export interface McpStatusDocumentWire {
  servers: Record<string, McpServerStatusWire>
}
