import { afterAll, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { boot, fixtureServerPath, repoRoot, toolNames } from './helpers.ts'
import { mountConfig } from '../src/index.ts'
import { STATUS_PATH } from '../src/wire.ts'
import type { McpServersSectionWire } from '../src/wire.ts'
import { startHttpMcpFixture } from '../../../../packages/mcp/mcp-client/tests/http-fixture.ts'

export const pingFixturePath = join(repoRoot, '.scratch/dsh-mcp-settings/plugin/tests/fixture-ping.ts')

describe('mcp-servers namespace', () => {
  it('registers a stdio entry tools in the global tool set without restart', async () => {
    const { ctx, provider } = await boot()
    afterAll(async () => await ctx.dispose())

    await provider.update('mcp-servers', {
      servers: {
        page: { transport: 'stdio', command: process.execPath, args: [fixtureServerPath], cwd: repoRoot },
      },
    })

    await vi.waitFor(() => {
      const names = toolNames(ctx)
      expect(names).toContain('mcp__page__add')
      expect(names).toContain('mcp__page__greet')
    }, { timeout: 20_000 })
  })

  it('mounts pre-existing enabled entries at boot without any settings write', async () => {
    const { ctx } = await boot({
      doc: {
        'mcp-servers': {
          servers: {
            page: { transport: 'stdio', command: process.execPath, args: [fixtureServerPath], cwd: repoRoot },
          },
        },
      },
    })
    afterAll(async () => await ctx.dispose())

    await vi.waitFor(() => {
      expect(toolNames(ctx)).toContain('mcp__page__add')
    }, { timeout: 20_000 })
  })

  it('unregisters the tools when the entry is removed from the namespace', async () => {
    const { ctx, provider } = await boot()
    afterAll(async () => await ctx.dispose())

    await provider.update('mcp-servers', {
      servers: { page: { transport: 'stdio', command: process.execPath, args: [fixtureServerPath], cwd: repoRoot } },
    })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__add'), { timeout: 20_000 })

    await provider.replace('mcp-servers', { servers: {} })
    await vi.waitFor(() => expect(toolNames(ctx).filter(n => n.startsWith('mcp__page__'))).toEqual([]))
  })

  it('rejects illegal keys and unpaired transport fields before persisting', async () => {
    const { provider } = await boot()

    await expect(provider.update('mcp-servers', {
      servers: { 'bad name!': { transport: 'stdio', command: 'true', args: [], env: {}, cwd: '' } },
    })).rejects.toThrow(/must match/)

    await expect(provider.update('mcp-servers', {
      servers: { demo: { transport: 'stdio' } },
    })).rejects.toThrow(/stdio requires a non-empty command/)

    await expect(provider.update('mcp-servers', {
      servers: { demo: { transport: 'streamable-http' } },
    })).rejects.toThrow(/streamable-http requires a non-empty url/)

    expect(provider.doc['mcp-servers']).toBeUndefined()
  })

  it('toggling an entry off unregisters its tools and re-enabling restores them', async () => {
    const { ctx, provider } = await boot()
    afterAll(async () => await ctx.dispose())

    await provider.update('mcp-servers', {
      servers: { page: { transport: 'stdio', command: process.execPath, args: [fixtureServerPath], cwd: repoRoot } },
    })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__add'), { timeout: 20_000 })

    await provider.update('mcp-servers', { servers: { page: { enabled: false } } })
    await vi.waitFor(() => expect(toolNames(ctx).filter(n => n.startsWith('mcp__page__'))).toEqual([]))

    await provider.update('mcp-servers', { servers: { page: { enabled: true } } })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__add'), { timeout: 20_000 })
  })

  it('editing a command replaces the live generation with the next fixture', async () => {
    const { ctx, provider } = await boot()
    afterAll(async () => await ctx.dispose())

    await provider.update('mcp-servers', {
      servers: { page: { transport: 'stdio', command: process.execPath, args: [fixtureServerPath], cwd: repoRoot } },
    })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__add'), { timeout: 20_000 })

    await provider.update('mcp-servers', { servers: { page: { args: [pingFixturePath] } } })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__ping'), { timeout: 20_000 })
    expect(toolNames(ctx)).not.toContain('mcp__page__add')
  })

  it('registers a streamable-http entry whose tools join the global set', async () => {
    const fixture = await startHttpMcpFixture()
    const { ctx, provider } = await boot()
    afterAll(async () => {
      await ctx.dispose()
      await fixture.close()
    })

    await provider.update('mcp-servers', {
      servers: { remote: { transport: 'streamable-http', url: fixture.url } },
    })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__remote__ping'), { timeout: 20_000 })
  })

  it('redacts env values on wire reads and keeps them across sparse field writes', async () => {
    const { ctx, provider } = await boot({
      doc: {
        'mcp-servers': {
          servers: {
            page: {
              transport: 'stdio', command: process.execPath, args: [pingFixturePath],
              env: { MCP_FIXTURE_KEY: 'hunter2' },
            },
          },
        },
      },
    })
    afterAll(async () => await ctx.dispose())
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__ping'), { timeout: 20_000 })

    const view = provider.describe({ redactSecrets: true }).find(d => d.ns === 'mcp-servers')
    expect(view).toBeDefined()
    const section = view?.value as McpServersSectionWire
    expect(section.servers.page.env).toEqual({})
    expect(view?.secrets?.some(s => s.path.join('.') === 'servers.page.env.MCP_FIXTURE_KEY' && s.set)).toBe(true)

    // A sparse write naming only cwd must not erase the stored secret.
    await provider.mutate('mcp-servers', [{ op: 'set', path: ['servers', 'page', 'cwd'], value: repoRoot }])
    const stored = (provider.doc['mcp-servers'] as McpServersSectionWire).servers.page.env
    expect(stored).toEqual({ MCP_FIXTURE_KEY: 'hunter2' })
  })

  it('expands ${VAR} env values from the host environment at mount config time', () => {
    process.env.MCP_FIXTURE_VAR = 'from-host-env'
    try {
      const config = mountConfig('page', {
        enabled: true, transport: 'stdio', command: process.execPath, args: [pingFixturePath],
        env: { MCP_FIXTURE_KEY: '${MCP_FIXTURE_VAR}' }, cwd: repoRoot,
      })
      expect(config.transport === 'stdio' && config.env.MCP_FIXTURE_KEY).toBe('from-host-env')
    } finally {
      delete process.env.MCP_FIXTURE_VAR
    }
  })

  it('rejects ${VAR} references to missing environment variables', () => {
    expect(() => mountConfig('page', {
      enabled: true, transport: 'stdio', command: process.execPath, args: [pingFixturePath],
      env: { KEY: '${NO_SUCH_DSH_VAR_XYZ}' }, cwd: repoRoot,
    })).toThrow(/not set/)
  })

  it('rejects non-absolute http urls before persisting', async () => {
    const { provider } = await boot()
    await expect(provider.update('mcp-servers', {
      servers: { remote: { transport: 'streamable-http', url: 'not-a-url' } },
    })).rejects.toThrow(/not a valid absolute URL/)
  })

  it('reports an unresolved ${VAR} as that entry row error, not a host failure', async () => {
    const { ctx, provider, webServer } = await boot({ manager: { statusErrorAfterMs: 300 } })
    afterAll(async () => await ctx.dispose())

    await provider.update('mcp-servers', {
      servers: { page: { transport: 'stdio', command: process.execPath, args: [pingFixturePath], env: { KEY: '${NO_SUCH_DSH_VAR_XYZ}' }, cwd: repoRoot } },
    })
    let lastError: string | undefined
    await vi.waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${webServer.port}${STATUS_PATH}`)
      const document = await response.json() as { servers: Record<string, { error?: string }> }
      lastError = document.servers.page?.error
      expect(lastError).toMatch(/not set/)
    }, { timeout: 10_000 })
  })

  it('reports an unreachable server as an entry error while the retry budget keeps running', async () => {
    const { ctx, provider, webServer } = await boot({ manager: { statusErrorAfterMs: 300 } })
    afterAll(async () => await ctx.dispose())

    await provider.update('mcp-servers', {
      servers: { broken: { transport: 'stdio', command: '/usr/bin/nonexistent-dsh-binary', args: [], cwd: repoRoot } },
    })
    await vi.waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${webServer.port}${STATUS_PATH}`)
      const document = await response.json() as { servers: Record<string, { error?: string; toolCount: number }> }
      expect(document.servers.broken?.error).toMatch(/initial connection failed/)
      expect(document.servers.broken?.toolCount).toBe(0)
    }, { timeout: 10_000 })
  })

  it('serves per-server status over the status route: tool counts and last errors', async () => {
    const { ctx, provider, webServer } = await boot()
    afterAll(async () => await ctx.dispose())

    await provider.update('mcp-servers', {
      servers: {
        page: { transport: 'stdio', command: process.execPath, args: [fixtureServerPath], cwd: repoRoot },
        broken: { transport: 'stdio', command: '/usr/bin/nonexistent-dsh-binary', args: [], cwd: repoRoot },
      },
    })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__add'), { timeout: 20_000 })

    const readStatus = async (): Promise<Record<string, { enabled: boolean; toolCount: number; error?: string }>> => {
      const response = await fetch(`http://127.0.0.1:${webServer.port}${STATUS_PATH}`)
      const document = await response.json() as { servers: Record<string, { enabled: boolean; toolCount: number; error?: string }> }
      return document.servers
    }

    await vi.waitFor(async () => {
      const statuses = await readStatus()
      expect(statuses.page?.toolCount).toBeGreaterThanOrEqual(1)
      expect(statuses.page?.enabled).toBe(true)
    }, { timeout: 20_000 })

    await provider.update('mcp-servers', { servers: { page: { enabled: false } } })
    await vi.waitFor(async () => {
      const statuses = await readStatus()
      expect(statuses.page?.enabled).toBe(false)
    })
  })
})
