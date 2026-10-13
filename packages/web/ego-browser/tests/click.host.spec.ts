import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as EgoBrowser from '../src/index.ts'

const TEST_TIMEOUT = 30_000
const CHROME_HINT = process.env.DSH_EGO_BROWSER_CHROME || ''

/**
 * A link that starts below the fold, so a click only reaches it when the target
 * is scrolled into view first. Served over loopback: fragment navigation needs a
 * real origin, and a data: URL has an opaque one.
 */
const FIXTURE_HTML = `<!doctype html>
<html><body>
<main>
  <div style="height:1800px"></div>
  <a id="below-fold" href="#clicked">Open</a>
  <div id="clicked">arrived</div>
</main>
</body></html>`

function chromeAvailable(): boolean {
  if (CHROME_HINT) return true
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/local/bin/chromium',
  ].some(path => existsSync(path))
}

const describeBrowser = chromeAvailable() ? describe : describe.skip

describeBrowser('browser_click against real Chrome', () => {
  let fiber: Awaited<ReturnType<Context['plugin']>> | undefined
  let server: Server | undefined
  let nextCallId = 0

  afterEach(async () => {
    await fiber?.dispose()
    fiber = undefined
    if (server) {
      const closing = server
      server = undefined
      await new Promise<void>((resolve) => {
        closing.close(() => {
          resolve()
        })
      })
    }
  })

  /** Serve the fixture on an OS-assigned loopback port. */
  async function serveFixture(): Promise<string> {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(FIXTURE_HTML)
    })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}/`
  }

  it('scrolls a below-viewport link into view before clicking it', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    fiber = await ctx.plugin(EgoBrowser, { enabled: true })
    const call = (name: string, args: unknown) =>
      ctx.tools.execute({
        name,
        arguments: args,
        callId: ToolCallId(`browser-click-${++nextCallId}`),
        signal: new AbortController().signal,
      })
    const text = (result: { value?: unknown }) =>
      typeof result.value === 'string' ? result.value : JSON.stringify(result.value)

    const navigation = await call('browser_goto', { url: await serveFixture() })
    expect(navigation.isError).not.toBe(true)

    const setup = await call('browser_js', {
      expression: `
        const link = document.querySelector('#below-fold');
        return { top: link.getBoundingClientRect().top, innerHeight };
      `,
    })
    const geometry = JSON.parse(text(setup)) as { top: number; innerHeight: number }
    expect(geometry.top).toBeGreaterThan(geometry.innerHeight)

    const clicked = await call('browser_click', { target: '#below-fold' })
    expect(clicked.isError).not.toBe(true)

    const observed = await call('browser_js', {
      expression: 'return { hash: location.hash, scrollY: window.scrollY }',
    })
    const state = JSON.parse(text(observed)) as { hash: string; scrollY: number }

    // The hash proves the press reached the link; the scroll offset proves the
    // page was moved to it rather than the press landing on the document root.
    expect(state.hash).toBe('#clicked')
    expect(state.scrollY).toBeGreaterThan(0)
  }, TEST_TIMEOUT)
})
