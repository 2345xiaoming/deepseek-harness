/**
 * End-to-end smoke: load the built package, mount it in a real-ish Context with
 * the tools registry, then exercise the browser_snapshot + browser_goto tools
 * against real headless Chrome.
 *
 * Run from the DSH checkout root:
 *   node packages/web/ego-browser/tests/smoke.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as EgoBrowser from '@deepseek-ai/dsh-ego-browser'

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
const fiber = await ctx.plugin(EgoBrowser, { enabled: true })

const names = ctx.tools.schemas().map((s) => s.name)
const browserTools = names.filter((n) => n.startsWith('browser_'))
console.log('registered browser tools:', browserTools.join(', '))
if (browserTools.length !== 7) {
  console.error('SMOKE FAIL: expected 7 browser_* tools')
  process.exit(1)
}

const callId = (() => {
  let n = 0
  return () => `smoke-${++n}`
})()
async function call(name, args) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: callId(),
    name,
    arguments: args,
  })
}

// goto example.com then snapshot
const gotoOut = await call('browser_goto', { url: 'https://example.com' })
console.log('goto ->', JSON.stringify(gotoOut).slice(0, 120))

const snapOut = await call('browser_snapshot', {})
const snapText = String(snapOut?.content?.[0]?.text ?? '')
console.log('snapshot head:\n', snapText.slice(0, 300))
if (!/Example Domain/i.test(snapText)) {
  console.error('SMOKE FAIL: snapshot did not capture example.com content')
  process.exit(1)
}
console.log('SMOKE OK')
await fiber.dispose()
process.exit(0)