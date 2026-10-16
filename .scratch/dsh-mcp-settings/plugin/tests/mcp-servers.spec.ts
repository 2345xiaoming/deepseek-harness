import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { redactSecrets } from '@deepseek-ai/dsh-settings'
import { boot, bootWithEntries, entryFace, fixtureServerPath, repoRoot, toolNames } from './helpers.ts'
import { Config, mountConfig, redactStatusError, writePatchRow } from '../src/index.ts'
import { entryPatch } from '../src/client/McpSettingsSection.tsx'
import { STATUS_PATH, TOGGLE_CONFIG_ROW_PATH, type McpServersSectionWire } from '../src/wire.ts'
import { startHttpMcpFixture } from '../../../../packages/mcp/mcp-client/tests/http-fixture.ts'

export const pingFixturePath = join(repoRoot, '.scratch/dsh-mcp-settings/plugin/tests/fixture-ping.ts')
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

describe('mcp-settings entry config', () => {
  it('registers a stdio entry tools in the global tool set without restart', async () => {
    const { ctx, update } = await boot()
    afterAll(async () => await ctx.dispose())

    await update({
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
      servers: {
        page: { transport: 'stdio', command: process.execPath, args: [fixtureServerPath], cwd: repoRoot },
      },
    })
    afterAll(async () => await ctx.dispose())

    await vi.waitFor(() => {
      expect(toolNames(ctx)).toContain('mcp__page__add')
    }, { timeout: 20_000 })
  })

  it('unregisters the tools when the entry is removed from the section', async () => {
    const { ctx, update, replace } = await boot()
    afterAll(async () => await ctx.dispose())

    await update({
      servers: { page: { transport: 'stdio', command: process.execPath, args: [fixtureServerPath], cwd: repoRoot } },
    })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__add'), { timeout: 20_000 })

    await replace({ servers: {} })
    await vi.waitFor(() => expect(toolNames(ctx).filter(n => n.startsWith('mcp__page__'))).toEqual([]))
  })

  it('rejects illegal keys and unpaired transport fields before persisting', async () => {
    const { ctx, update, entry } = await boot()
    afterAll(async () => await ctx.dispose())

    await expect(update({
      servers: { 'bad name!': { transport: 'stdio', command: 'true', args: [], env: {}, cwd: '' } },
    })).rejects.toThrow(/must match/)

    await expect(update({
      servers: { demo: { transport: 'stdio' } },
    })).rejects.toThrow(/stdio requires a non-empty command/)

    await expect(update({
      servers: { demo: { transport: 'streamable-http' } },
    })).rejects.toThrow(/streamable-http requires a non-empty url/)

    expect((entry.options.config as { servers: Record<string, unknown> }).servers).toEqual({})
  })

  it('toggling an entry off unregisters its tools and re-enabling restores them', async () => {
    const { ctx, update } = await boot()
    afterAll(async () => await ctx.dispose())

    await update({
      servers: { page: { transport: 'stdio', command: process.execPath, args: [fixtureServerPath], cwd: repoRoot } },
    })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__add'), { timeout: 20_000 })

    await update({ servers: { page: { enabled: false } } })
    await vi.waitFor(() => expect(toolNames(ctx).filter(n => n.startsWith('mcp__page__'))).toEqual([]))

    await update({ servers: { page: { enabled: true } } })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__add'), { timeout: 20_000 })
  })

  it('editing a command replaces the live generation with the next fixture', async () => {
    const { ctx, update } = await boot()
    afterAll(async () => await ctx.dispose())

    await update({
      servers: { page: { transport: 'stdio', command: process.execPath, args: [fixtureServerPath], cwd: repoRoot } },
    })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__add'), { timeout: 20_000 })

    await update({ servers: { page: { args: [pingFixturePath] } } })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__ping'), { timeout: 20_000 })
    expect(toolNames(ctx)).not.toContain('mcp__page__add')
  })

  it('registers a streamable-http entry whose tools join the global set', async () => {
    const fixture = await startHttpMcpFixture()
    const { ctx, update } = await boot()
    afterAll(async () => {
      await ctx.dispose()
      await fixture.close()
    })

    await update({
      servers: { remote: { transport: 'streamable-http', url: fixture.url } },
    })
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__remote__ping'), { timeout: 20_000 })
  })

  it('keeps stored secrets across a sparse settings update', async () => {
    const { ctx, fiber, update } = await boot({
      servers: {
        page: {
          transport: 'stdio', command: process.execPath, args: [pingFixturePath],
          env: { MCP_FIXTURE_KEY: 'hunter2' },
        },
      },
    })
    afterAll(async () => await ctx.dispose())
    await vi.waitFor(() => expect(toolNames(ctx)).toContain('mcp__page__ping'), { timeout: 20_000 })

    // A sparse write naming one field must not erase the stored secret from
    // the manager's live view.
    await update({ servers: { page: { cwd: repoRoot } } })
    const live = fiber.config.servers.get() as Record<string, { env: Record<string, string>; cwd: string }>
    expect(live.page.env).toEqual({ MCP_FIXTURE_KEY: 'hunter2' })
    expect(live.page.cwd).toBe(repoRoot)
  })

  it('declares env and header values as wire-redacted secrets', () => {
    const section = {
      servers: {
        page: {
          transport: 'stdio', command: 'x',
          env: { MCP_FIXTURE_KEY: 'hunter2' },
          headers: { Authorization: 'Bearer secret' },
        },
      },
    }
    const redacted = redactSecrets(Config as never, section)
    const value = redacted.value as McpServersSectionWire
    expect(value.servers.page.env).toEqual({})
    expect(value.servers.page.headers).toEqual({})
    expect(redacted.secrets).toContainEqual({ path: ['servers', 'page', 'env', 'MCP_FIXTURE_KEY'], set: true })
    expect(redacted.secrets).toContainEqual({ path: ['servers', 'page', 'headers', 'Authorization'], set: true })
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
    const { ctx, update } = await boot()
    afterAll(async () => await ctx.dispose())
    await expect(update({
      servers: { remote: { transport: 'streamable-http', url: 'not-a-url' } },
    })).rejects.toThrow(/not a valid absolute URL/)
  })

  it('reports an unresolved ${VAR} as that entry row error, not a host failure', async () => {
    const { ctx, webServer, update } = await boot({ statusErrorAfterMs: 300 })
    afterAll(async () => await ctx.dispose())

    await update({
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
    const { ctx, webServer, update } = await boot({ statusErrorAfterMs: 300 })
    afterAll(async () => await ctx.dispose())

    await update({
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
    const { ctx, webServer, update } = await boot()
    afterAll(async () => await ctx.dispose())

    await update({
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

    await update({ servers: { page: { enabled: false } } })
    await vi.waitFor(async () => {
      const statuses = await readStatus()
      expect(statuses.page?.enabled).toBe(false)
    })
  })

  it('projects patch-configured mcp-client rows into the status document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-settings-profile-'))
    const include = entryFace('include', '@deepseek-ai/cordis-plugin-include', { path: join(root, 'cordis.yml') }, false)
    const memory = entryFace('mcp-codebase-memory', MCP_CLIENT_PACKAGE, { serverName: 'codebase-memory' }, false)
    const context7 = entryFace('mcp-context7', MCP_CLIENT_PACKAGE, { serverName: 'context7' }, true)
    const { ctx, webServer } = await bootWithEntries([include, memory, context7])
    afterAll(async () => await ctx.dispose())

    const response = await fetch(`http://127.0.0.1:${webServer.port}${STATUS_PATH}`)
    const document = await response.json() as {
      configRows: Array<{ serverName: string; enabled: boolean; toolCount: number }>
    }
    expect(document.configRows).toContainEqual({ serverName: 'codebase-memory', enabled: true, toolCount: 0 })
    expect(document.configRows).toContainEqual({ serverName: 'context7', enabled: false, toolCount: 0 })
  })

  it('toggling a config row updates the loader entry and persists an id-targeted patch row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-settings-patch-'))
    const include = entryFace('include', '@deepseek-ai/cordis-plugin-include', { path: join(root, 'profiles', 'web', 'cordis.yml') }, false)
    // Nested loader ids are the production reality: the persisted patch row
    // must still target the ROOT-level id the insert declared.
    const memory = entryFace('include:mcp-codebase-memory', MCP_CLIENT_PACKAGE, { serverName: 'codebase-memory' }, false)
    const { ctx, webServer, fakeLoader } = await bootWithEntries([include, memory])
    afterAll(async () => await ctx.dispose())

    const patchPath = join(root, 'profiles', 'web', 'cordis.patch.yml')
    await mkdir(dirname(patchPath), { recursive: true })
    await writeFile(patchPath, '# profile patch\n- insert:\n    - id: mcp-codebase-memory\n')

    const disable = await fetch(`http://127.0.0.1:${webServer.port}${TOGGLE_CONFIG_ROW_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cbm-settings': '1' },
      body: JSON.stringify({ serverName: 'codebase-memory', enabled: false }),
    })
    expect(disable.status).toBe(200)
    expect(fakeLoader.updates.at(-1)).toEqual({ id: 'include:mcp-codebase-memory', options: { disabled: true } })
    const patchAfterDisable = await readFile(patchPath, 'utf8')
    // The leaf id is what the include applier can resolve.
    expect(patchAfterDisable).toContain('- id: mcp-codebase-memory')
    expect(patchAfterDisable).not.toContain('id: include:mcp-codebase-memory')
    expect(patchAfterDisable).toContain('disabled: true')

    const enable = await fetch(`http://127.0.0.1:${webServer.port}${TOGGLE_CONFIG_ROW_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cbm-settings': '1' },
      body: JSON.stringify({ serverName: 'codebase-memory', enabled: true }),
    })
    expect(enable.status).toBe(200)
    expect(fakeLoader.updates.at(-1)).toEqual({ id: 'include:mcp-codebase-memory', options: { disabled: false } })
    const patchAfterEnable = await readFile(patchPath, 'utf8')
    expect(patchAfterEnable).toContain('disabled: false')
    // Toggling back and forth must not accumulate duplicate root rows.
    const rootRows = patchAfterEnable.split('\n').filter(line => line === '- id: mcp-codebase-memory')
    expect(rootRows).toHaveLength(1)
  })

  it('refuses a cross-origin config-row toggle before reading the body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-settings-csrf-'))
    const include = entryFace('include', '@deepseek-ai/cordis-plugin-include', { path: join(root, 'profiles', 'web', 'cordis.yml') }, false)
    const memory = entryFace('include:mcp-codebase-memory', MCP_CLIENT_PACKAGE, { serverName: 'codebase-memory' }, false)
    const { ctx, webServer, fakeLoader } = await bootWithEntries([include, memory])
    afterAll(async () => await ctx.dispose())

    const patchPath = join(root, 'profiles', 'web', 'cordis.patch.yml')
    await mkdir(dirname(patchPath), { recursive: true })
    await writeFile(patchPath, '# profile patch\n')

    const refused = await fetch(`http://127.0.0.1:${webServer.port}${TOGGLE_CONFIG_ROW_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverName: 'codebase-memory', enabled: false }),
    })
    expect(refused.status).toBe(400)
    const payload = await refused.json() as { ok: boolean; error?: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('cross-origin')
    // Neither the runtime nor the patch file may move on a refused toggle.
    expect(fakeLoader.updates).toHaveLength(0)
    expect(await readFile(patchPath, 'utf8')).toBe('# profile patch\n')
  })

  it('masks the resolved secret value in a mount failure, not just the stored reference', () => {
    const token = `sk-test-${Math.random().toString(36).slice(2)}`
    // Whole-value reference: the only shape expandVar resolves, matching the
    // documented usage where the env var holds the complete header value.
    const entry = {
      enabled: true,
      transport: 'streamable-http',
      url: 'https://127.0.0.1:9/mcp',
      headers: { Authorization: '${MCP_SETTINGS_TEST_TOKEN}' },
    } as const
    const message = `connect ECONNREFUSED https://127.0.0.1:9/mcp with Authorization: Bearer ${token}`
    // Stand in for the host environment the mount would have expanded.
    process.env.MCP_SETTINGS_TEST_TOKEN = token
    try {
      const resolved = mountConfig('probe', {
        ...entry,
        env: {},
        args: [],
        cwd: '',
      } as never)
      const masked = redactStatusError(message, entry as never, resolved)
      expect(masked).not.toContain(token)
      expect(masked).toContain('***')
      expect(masked).toContain('ECONNREFUSED')
    } finally {
      delete process.env.MCP_SETTINGS_TEST_TOKEN
    }
  })

  it('rewrites an existing patch row in place instead of appending a duplicate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-settings-upsert-'))
    const patchPath = join(root, 'cordis.patch.yml')
    await writePatchRow(patchPath, 'include:mcp-x', MCP_CLIENT_PACKAGE, false)
    await writePatchRow(patchPath, 'include:mcp-x', MCP_CLIENT_PACKAGE, true)
    await writePatchRow(patchPath, 'include:mcp-x', MCP_CLIENT_PACKAGE, false)
    const text = await readFile(patchPath, 'utf8')
    const rows = text.split('\n').filter(line => line === '- id: mcp-x')
    expect(rows).toHaveLength(1)
    expect(text).toContain('disabled: true')
    expect(text).not.toContain('disabled: false')
  })

  it('clears args and cwd on edit while secret maps stay keep-on-blank', () => {
    const stdio = entryPatch(
      { transport: 'stdio', command: 'npx', args: '  \n ', cwd: '  ', url: '', env: '', headers: '' },
      undefined,
      undefined,
    )
    expect(stdio).toEqual({ transport: 'stdio', command: 'npx', args: [], cwd: '' })
    const http = entryPatch(
      { transport: 'streamable-http', command: '', args: '', cwd: '', url: 'https://x.test/mcp', env: '', headers: '' },
      undefined,
      undefined,
    )
    expect(http).toEqual({ transport: 'streamable-http', url: 'https://x.test/mcp' })
  })
})
