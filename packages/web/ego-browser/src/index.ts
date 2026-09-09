/**
 * @deepseek-ai/dsh-ego-browser — browser automation for DSH agents.
 *
 * Self-contained CDP-over-WebSocket bridge (no closed-source ego runtime) driving
 * the local headless Chrome through the ported ego-browser harness. Registers the
 * `browser_*` model-facing tools; Chrome boots lazily on first real browser call.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

import { installEgoBridge } from './bridge/ws-cdp.ts'
import { disposeChrome } from './bridge/chrome.ts'
import { egoSnapshot } from './bridge/snapshot.ts'
import { applyEgoBrowserTools } from './tools.ts'
import { helperContext } from './runtime/helpers.ts'
import { formatCliLogValue } from './runtime/format.ts'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>

export const name = 'ego-browser'
export const inject = ['tools']

export interface Config {
  enabled: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return

  // Install the CDP bridge as globalThis.ego and register all tools. The bridge
  // owns Chrome lifecycle; the disposer (fiber-scoped) tears down WS + Chrome +
  // restores globalThis.ego so hot-reload/unload leaves nothing behind.
  ctx.effect(() => {
    const restoreEgo = installEgoBridge({
      snapshot: opts =>
        egoSnapshot(
          opts as { scope?: 'only_within_viewport' | 'full_page'; maxResultLength?: number },
        ),
      disposeChrome,
    })
    return () => restoreEgo()
  }, 'ego-browser: install bridge')

  applyEgoBrowserTools(ctx)
  applyBrowserRunTool(ctx)
}

/**
 * The `browser_run` escape hatch: execute arbitrary helper JS with the full
 * harness facade (page/browser/site/cdp/…, plus a capture-bound console.log) in a
 * fresh AsyncFunction scope — deliberately NOT via runMain's `Object.assign(
 * globalThis, context)`, so the DSH host process never gets page/browser/etc.
 * globals or its console.log replaced. Returns the captured console.log output.
 */
function applyBrowserRunTool(ctx: Context): void {
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'browser_run',
        description:
          'Run an ego-browser helper script: arbitrary JS with the full v2 harness face (flat helpers: snapshot/gotoAndWait/click/js/captureScreenshot/waitForElement/cdp/browserFetch; task-space API: taskSpace()/newTaskSpace()/claimTaskSpace()/listTaskSpaces(); site skills: runSiteTool/learnContext). console.log(...) inside the script is captured and returned as the tool result.',
        parameters: {
          js: {
            type: 'string',
            required: true,
            description: 'JavaScript body (await allowed). Use console.log(...) for output.',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args: unknown, value: unknown) => [
            { type: 'text', text: String(value) },
          ],
        },
        async execute(args: { js: string }) {
          const chunks: string[] = []
          const capturedConsole = {
            log: (...vals: unknown[]) => {
              chunks.push(vals.map(formatCliLogValue).join(' ') + '\n')
            },
            error: (...vals: unknown[]) => {
              chunks.push('[error] ' + vals.map(formatCliLogValue).join(' ') + '\n')
            },
            warn: (...vals: unknown[]) => {
              chunks.push('[warn] ' + vals.map(formatCliLogValue).join(' ') + '\n')
            },
          }
          const context = helperContext()
          const names = [...Object.keys(context), 'console']
          const values = [...Object.values(context), capturedConsole]
          const fn = new AsyncFunction(...names, `"use strict";\n${args.js}`)
          try {
            await fn(...values)
          } catch (error) {
            chunks.push(
              `[browser_run threw] ${error instanceof Error ? error.message : String(error)}`,
            )
          }
          return chunks.join('') || '(no output)'
        },
      }),
    ),
  'ego-browser: browser_run',
  )
}
