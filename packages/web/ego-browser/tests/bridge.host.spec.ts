/**
 * Bridge integration tests against a real headless Chrome (when available).
 *
 * These tests exercise the full CDP-over-WebSocket path: launch Chrome, attach a
 * flattened session, evaluate JS, enumerate tabs, create targets, and build an
 * accessibility snapshot. They require a Chrome binary on PATH (or
 * DSH_EGO_BROWSER_CHROME); the suite skips when no binary is found so CI without
 * a browser stays green.
 */

import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { launchChrome, adoptChrome, disposeChrome, jsonVersion, pageTargets } from '../src/bridge/chrome.ts'
import { sendRaw, attachSession } from '../src/bridge/ws-cdp.ts'
import { egoSnapshot } from '../src/bridge/snapshot.ts'

const CHROME_HINT = process.env.DSH_EGO_BROWSER_CHROME || ''
const TEST_TIMEOUT = 30_000

function chromeAvailable(): boolean {
  if (CHROME_HINT) return true
  for (const bin of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/local/bin/chromium']) {
    if (existsSync(bin)) return true
  }
  return false
}

const describeBrowser = chromeAvailable() ? describe : describe.skip

describeBrowser('ego-browser bridge against real Chrome', () => {
  it(
    'launches Chrome, evaluates JS over the flat protocol, and lists tabs',
    async () => {
      const instance = await launchChrome()
      adoptChrome(instance)
      try {
        const version = await jsonVersion(instance)
        expect(version.webSocketDebuggerUrl).toBeTruthy()

        const targets = await pageTargets(instance)
        expect(targets.filter(t => t.type === 'page').length).toBeGreaterThanOrEqual(1)

        const pages = targets.filter(t => t.type === 'page')
        const sessionId = await attachSession(pages[0]!.id)
        expect(sessionId).toBeTruthy()

        const result = await sendRaw('Runtime.evaluate', { expression: '1 + 1', returnByValue: true }, sessionId)
        expect((result.result as { value?: unknown }).value).toBe(2)
      } finally {
        await disposeChrome()
      }
    },
    TEST_TIMEOUT,
  )

  it(
    'builds an accessibility snapshot with refs',
    async () => {
      const instance = await launchChrome()
      adoptChrome(instance)
      try {
        const pages = (await pageTargets(instance)).filter(t => t.type === 'page')
        const sessionId = await attachSession(pages[0]!.id)
        await sendRaw(
          'Page.navigate',
          { url: 'data:text/html,<html><body><h1>Hello</h1><button>Click me</button></body></html>' },
          sessionId,
        )
        await new Promise(r => setTimeout(r, 500))

        const snapshot = await egoSnapshot()
        expect(snapshot.content.length).toBeGreaterThan(0)
        expect(snapshot.refs.length).toBeGreaterThanOrEqual(1)
        expect(snapshot.content).toMatch(/Hello/)
      } finally {
        await disposeChrome()
      }
    },
    TEST_TIMEOUT,
  )

  it(
    'creates a new page target',
    async () => {
      const instance = await launchChrome()
      adoptChrome(instance)
      try {
        const before = (await pageTargets(instance)).filter(t => t.type === 'page').length
        const pages = (await pageTargets(instance)).filter(t => t.type === 'page')
        const sessionId = await attachSession(pages[0]!.id)
        await sendRaw('Target.createTarget', { url: 'about:blank' }, sessionId)
        const after = (await pageTargets(instance)).filter(t => t.type === 'page').length
        expect(after).toBe(before + 1)
      } finally {
        await disposeChrome()
      }
    },
    TEST_TIMEOUT,
  )
})
