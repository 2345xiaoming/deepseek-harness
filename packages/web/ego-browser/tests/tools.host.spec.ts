/**
 * Tool-registration tests: mounting the plugin registers all browser_* tools on a
 * fresh Context. These are registry-level (no Chrome is launched), so they run
 * anywhere.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as EgoBrowser from '../src/index.ts'

async function mount(): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  names: string[]
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(EgoBrowser, { enabled: true })
  const names = ctx.tools.schemas().map(s => s.name)
  return { ctx, fiber, names }
}

describe('dsh-ego-browser tool registration', () => {
  it('registers the six curated browser tools plus browser_run', async () => {
    const { names } = await mount()
    for (const expected of [
      'browser_snapshot',
      'browser_goto',
      'browser_click',
      'browser_js',
      'browser_screenshot',
      'browser_wait',
      'browser_run',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('does not register tools when disabled', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(EgoBrowser, { enabled: false })
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names.filter(n => n.startsWith('browser_'))).toHaveLength(0)
  })

  it('disposes cleanly (unmount unregisters tools)', async () => {
    const { ctx, fiber, names } = await mount()
    expect(names.length).toBeGreaterThan(0)
    await fiber.dispose()
    const after = ctx.tools.schemas().map(s => s.name)
    expect(after.filter(n => n.startsWith('browser_'))).toHaveLength(0)
  })
})
