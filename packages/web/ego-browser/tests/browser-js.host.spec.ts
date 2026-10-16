/**
 * `browser_js` over a real headless Chrome. The tool must return the evaluated
 * value: evaluating an expression as an async function body that never returns
 * yields `undefined`, so these cases pin the completion-value, explicit-return,
 * and top-level-await shapes against that regression.
 *
 * Requires a Chrome binary on PATH (or `DSH_EGO_BROWSER_CHROME`); the suite
 * skips when none is found so CI without a browser stays green.
 */

import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as EgoBrowser from '../src/index.ts'

const CHROME_HINT = process.env.DSH_EGO_BROWSER_CHROME || ''
const TEST_TIMEOUT = 60_000
const PROBE_PAGE = 'data:text/html,<title>js probe</title><h1>ok</h1>'

function chromeAvailable(): boolean {
  if (CHROME_HINT) return true
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/local/bin/chromium']) {
    if (existsSync(bin)) return true
  }
  return false
}

const describeBrowser = chromeAvailable() ? describe : describe.skip

describeBrowser('browser_js against real Chrome', () => {
  it(
    'returns the evaluated value for expression, statement, return, and await shapes',
    async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const fiber = await ctx.plugin(EgoBrowser, { enabled: true })
      try {
        const call = (name: string, args: unknown) =>
          ctx.tools.execute({
            name,
            arguments: args,
            callId: ToolCallId('ego-browser-browser-js'),
            signal: new AbortController().signal,
          })
        const evaluate = async (expression: string): Promise<unknown> => {
          const result = await call('browser_js', { expression })
          expect(result.isError).not.toBe(true)
          return result.value
        }

        await call('browser_goto', { url: PROBE_PAGE })

        expect(await evaluate('1 + 1')).toBe('2')
        expect(await evaluate('document.title')).toBe('"js probe"')
        expect(await evaluate('return document.title')).toBe('"js probe"')
        expect(await evaluate('await Promise.resolve(42)')).toBe('42')
      } finally {
        await fiber.dispose()
      }
    },
    TEST_TIMEOUT,
  )
})
