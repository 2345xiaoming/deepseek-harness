// @ts-nocheck — ported from ego-browser v2.0.0-beta.4 (strict:false); vendor exemption, not strict-checked.
import { cdp, js } from '../cdp-eval.ts'
import { state } from '../state.ts'

export type WaitForLoadOptions = {
  timeout?: number
}

export async function waitForDocumentLoad(options: WaitForLoadOptions = {}) {
  const timeout = options.timeout ?? 15.0
  const deadline = state.now() + timeout * 1000
  while (state.now() < deadline) {
    let committed = true
    try {
      const tree = await cdp('Page.getFrameTree')
      const url = tree.frameTree?.frame?.url || ''
      committed = url !== '' && url !== ':' && url !== 'about:blank'
    } catch {
      // Page.getFrameTree may not be supported in some sessions; fall back to readyState only.
    }
    if (committed && (await js('document.readyState')) === 'complete') {
      return true
    }
    await state.sleep(300)
  }
  return false
}
