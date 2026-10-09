/**
 * @dsh-external/dsh-mcp-settings — client 半区：注册设置页顶级 "MCP" section。
 * 读写走 ui-settings 的 configForms（条目 = Host 插件自身，revision fence
 * 由框架负责）；inject face 在 apply 时构造一次，保持组件订阅身份稳定。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { McpSettingsSection, type McpSettingsSectionInjected } from './McpSettingsSection.tsx'
import { en, zh, type McpLocaleKey } from './locales.ts'
import { MCP_SETTINGS_ENTRY, STATUS_PATH, TOGGLE_CONFIG_ROW_PATH, type McpServersSectionWire, type McpStatusDocumentWire } from '../wire.ts'

export type { McpSettingsSectionInjected, McpSettingsSectionProps } from './McpSettingsSection.tsx'
export type { McpLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP servers management section copy. */
    'settings.mcp': McpLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.mcp'

/** Services required by the Settings section registration. */
export const inject = ['slots', 'locale', 'configForms']

/** Contribute the MCP section to the Web Settings shell. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mcp-settings: dictionaries')

  const t = ctx.locale.bind(NS)
  const form = ctx.configForms.get<McpServersSectionWire>(MCP_SETTINGS_ENTRY)
  /** Submit one path-addressed write; a refusal reads back and surfaces as a form error. */
  const write = async (ops: Parameters<typeof form.mutate>[0]): Promise<void> => {
    if (!await form.mutate(ops)) throw new Error(t('saveRefused'))
  }
  // One stable face object: the component's useSyncExternalStore identities never move.
  const injected: McpSettingsSectionInjected = {
    getSnapshot: () => form.getSnapshot(),
    subscribe: listener => form.subscribe(listener),
    addServer: (serverName, entry) => write([{ op: 'set', path: ['servers', serverName], value: entry as never }]),
    patchServer: (serverName, changed) => write(
      Object.entries(changed).map(([field, value]) => ({
        op: 'set' as const,
        path: ['servers', serverName, field],
        value: value as never,
      })),
    ),
    toggleServer: (serverName, enabled) => write([{ op: 'set', path: ['servers', serverName, 'enabled'], value: enabled }]),
    removeServer: serverName => write([{ op: 'unset', path: ['servers', serverName] }]),
    fetchStatus: async () => {
      const response = await fetch(STATUS_PATH, { cache: 'no-store' })
      if (!response.ok) throw new Error(`mcp-settings: status read failed (${response.status})`)
      const document = await response.json() as McpStatusDocumentWire
      return { servers: document.servers, configRows: document.configRows ?? [] }
    },
    toggleConfigRow: async (serverName, enabled) => {
      const response = await fetch(TOGGLE_CONFIG_ROW_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverName, enabled }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: string } | undefined
        throw new Error(body?.error ?? `mcp-settings: toggle failed (${response.status})`)
      }
    },
  }

  // The page follows the Host's namespace: a composition without the manager
  // plugin shows no trace of the section.
  ctx.effect(() => ctx.configForms.whileServed([MCP_SETTINGS_ENTRY], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp',
    order: 16,
    label: () => t('nav'),
    locale: NS,
    inject: () => injected,
  }, McpSettingsSection))), 'dsh-mcp-settings: settings section')
}
