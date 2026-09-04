/**
 * @dsh-external/dsh-mcp-settings — client 半区：注册设置页顶级 "MCP" section。
 * 读写走 ui-settings 的 settingsScope 镜像（revision fence 由框架负责）；
 * inject face 在 apply 时构造一次，保持组件订阅身份稳定。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { McpSettingsSection, type McpSettingsSectionInjected } from './McpSettingsSection.tsx'
import { en, zh, type McpLocaleKey } from './locales.ts'
import { MCP_SERVERS_NAMESPACE, STATUS_PATH, decodeMcpServersSection, type McpServersSectionWire, type McpStatusDocumentWire } from '../wire.ts'

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
export const inject = ['slots', 'locale', 'settingsScope']

/** Contribute the MCP section to the Web Settings shell. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mcp-settings: dictionaries')

  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind<McpServersSectionWire>({
    namespace: MCP_SERVERS_NAMESPACE,
    decode: decodeMcpServersSection,
  })
  // One stable face object: the component's useSyncExternalStore identities never move.
  const injected: McpSettingsSectionInjected = {
    getSnapshot: () => scope.getSnapshot(),
    subscribe: listener => scope.subscribe(listener),
    addServer: (serverName, entry) => scope.mutate([{ op: 'set', path: ['servers', serverName], value: entry as never }]),
    patchServer: (serverName, changed) => scope.mutate(
      Object.entries(changed).map(([field, value]) => ({
        op: 'set' as const,
        path: ['servers', serverName, field],
        value: value as never,
      })),
    ),
    toggleServer: (serverName, enabled) => scope.mutate([{ op: 'set', path: ['servers', serverName, 'enabled'], value: enabled }]),
    removeServer: serverName => scope.mutate([{ op: 'unset', path: ['servers', serverName] }]),
    fetchStatus: async () => {
      const response = await fetch(STATUS_PATH, { cache: 'no-store' })
      if (!response.ok) throw new Error(`mcp-settings: status read failed (${response.status})`)
      const document = await response.json() as McpStatusDocumentWire
      return document.servers
    },
  }

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp',
    order: 16,
    label: () => t('nav'),
    locale: NS,
    inject: () => injected,
  }, McpSettingsSection)), 'dsh-mcp-settings: settings section')
}
