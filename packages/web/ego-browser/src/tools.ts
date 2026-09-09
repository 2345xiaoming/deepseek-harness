/**
 * Thin `defineTool` wrappers over the v2 ego-browser harness's flat helper
 * surface (ported to src/runtime from ego-lite v2.0.0-beta.4). The tool
 * contracts are unchanged from the v1 port: snapshot → @N refs, goto/click by
 * ref or locator, JS eval with async-IIFE wrapping, screenshot file output and
 * wait helpers; `browser_run` (registered in index.ts) remains the escape
 * hatch for the full helper face.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import {
  captureScreenshot,
  click,
  gotoAndWait,
  js,
  pageInfo,
  snapshotRaw,
  waitForElement,
  waitForLoad,
  waitForNetworkIdle,
} from './runtime/helpers.ts'

const textRender = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: String(value) },
]

type SnapshotResult = {
  content?: string
  refs?: Array<{ backendNodeId?: number; role?: string; name?: string }>
}

/** Format a snapshot result: the text outline plus a compact `@N` ref legend. */
function formatSnapshotResult(raw: SnapshotResult): string {
  const lines = [raw.content ?? '']
  const refLines: string[] = []
  for (const ref of raw.refs ?? []) {
    if (ref?.backendNodeId === undefined) continue
    refLines.push(`@${ref.backendNodeId} [${ref.role || ''}${ref.name ? `: ${ref.name}` : ''}]`)
  }
  if (refLines.length > 0) {
    lines.push('', '── refs ──', refLines.join('\n'))
  }
  return lines.join('\n')
}

/** v2 helper timeouts are in seconds; tools keep the ms contract. */
function secondsOption(ms?: number): { timeout: number } | Record<string, never> {
  return ms === undefined ? {} : { timeout: ms / 1000 }
}

/**
 * Register the ego-browser tool set on `ctx.tools`. All registrations are
 * fiber-scoped (via ctx.effect) so hot-reload/unload cleans them up.
 */
export function applyEgoBrowserTools(ctx: Context): void {
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'browser_snapshot',
        description: 'Read an accessibility snapshot of the current page: a text outline plus @N snapshot refs for interacting with elements.',
        parameters: {
          scope: { type: 'string', description: 'only_within_viewport | full_page (default full_page)' },
        },
        output: { schema: { type: 'string' }, render: textRender },
        async execute(args: { scope?: string }) {
          const raw = (await snapshotRaw({
            scope: args.scope === 'only_within_viewport' ? 'only_within_viewport' : 'full_page',
          })) as SnapshotResult
          return formatSnapshotResult(raw)
        },
      }),
    ),
  'ego-browser: browser_snapshot',
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'browser_goto',
        description: 'Navigate the current tab (or open/reuse a matching tab) to a URL and wait for it to load.',
        parameters: {
          url: { type: 'string', required: true, description: 'Absolute URL to navigate to.' },
          timeout: { type: 'number', description: 'Timeout ms (default 20000).' },
        },
        output: { schema: { type: 'string' }, render: textRender },
        async execute(args: { url: string; timeout?: number }) {
          const timeoutMs = args.timeout ?? 20000
          let loaded = false
          try {
            const result = await gotoAndWait(args.url, {
              wait: true,
              ...secondsOption(timeoutMs),
            })
            loaded = Boolean(result?.loaded)
          } catch (error) {
            // Chrome's Page.navigate response can lag behind the navigation on slow
            // sites (it waits for the load to settle); the page often arrives anyway.
            // Verify by URL instead of failing the call.
            if (error instanceof Error && /timed out/i.test(error.message)) {
              const info = await pageInfo().catch(() => null)
              const arrived = info && (info as { url?: string }).url?.split('?')[0] === args.url.split('?')[0]
              if (arrived) {
                await waitForLoad({ ...secondsOption(timeoutMs) }).catch(() => {})
                return `navigated to ${args.url} (navigation response lagged; page reached target URL)`
              }
            }
            throw error
          }
          return `navigated to ${args.url}${loaded ? '' : ' (load wait timed out, page may still be loading)'}`
        },
      }),
    ),
  'ego-browser: browser_goto',
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'browser_click',
        description: 'Click an element by snapshot ref (@N) or locator (loc=css:, loc=role:, xpath=, or raw CSS).',
        parameters: {
          target: { type: 'string', required: true, description: '@N ref, loc=..., xpath=..., or CSS selector.' },
          timeout: { type: 'number', description: 'Timeout ms (default 10000; element resolution has its own internal bounds).' },
        },
        output: { schema: { type: 'string' }, render: textRender },
        async execute(args: { target: string; timeout?: number }) {
          await click(args.target)
          return `clicked: ${args.target}`
        },
      }),
    ),
  'ego-browser: browser_click',
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'browser_js',
        description: `Evaluate a JavaScript expression in the current page and return the serialized result.
String expressions are wrapped in an async IIFE, so top-level statements and \`return\` work.`,
        parameters: {
          expression: { type: 'string', required: true, description: 'JavaScript expression or body; wrapped in an async IIFE before evaluation.' },
        },
        output: { schema: { type: 'string' }, render: textRender },
        async execute(args: { expression: string }) {
          const value = await js(`(async () => { ${args.expression} })()`)
          return value === undefined ? 'undefined' : JSON.stringify(value)
        },
      }),
    ),
  'ego-browser: browser_js',
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'browser_screenshot',
        description: 'Capture a screenshot of the current page to a PNG file and return its path.',
        parameters: {
          path: { type: 'string', description: 'Output PNG path (default: temp file).' },
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default false).' },
        },
        output: { schema: { type: 'string' }, render: textRender },
        async execute(args: { path?: string; fullPage?: boolean }) {
          const path = await captureScreenshot(
            args.path,
            args.fullPage === undefined ? {} : { full: args.fullPage },
          )
          return `screenshot saved: ${path}`
        },
      }),
    ),
  'ego-browser: browser_screenshot',
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'browser_wait',
        description: 'Wait until an element matches a selector (optionally visible) or the page reaches a load state.',
        parameters: {
          selector: { type: 'string', description: '@N ref, loc=..., xpath=..., or CSS selector to wait for.' },
          state: { type: 'string', description: 'attached | visible (default attached).' },
          loadState: { type: 'string', description: 'load | networkidle (when waiting for a load state).' },
          timeout: { type: 'number', description: 'Timeout ms (default 10000).' },
        },
        output: { schema: { type: 'boolean' }, render: textRender },
        async execute(args: { selector?: string; state?: string; loadState?: string; timeout?: number }) {
          const timeoutMs = args.timeout ?? 10000
          if (args.loadState === 'networkidle') {
            return Boolean(await waitForNetworkIdle({ ...secondsOption(timeoutMs) }))
          }
          if (args.loadState) {
            return Boolean(await waitForLoad({ ...secondsOption(timeoutMs) }))
          }
          if (!args.selector) throw new Error('browser_wait requires selector or loadState')
          return Boolean(
            await waitForElement(args.selector, {
              ...secondsOption(timeoutMs),
              visible: args.state === 'visible',
            }),
          )
        },
      }),
    ),
  'ego-browser: browser_wait',
  )
}

/** The full set of browser_* tool names (including browser_run), for anchoring. */
export const EGO_BROWSER_TOOL_NAMES = [
  'browser_snapshot',
  'browser_goto',
  'browser_click',
  'browser_js',
  'browser_screenshot',
  'browser_wait',
  'browser_run',
]
