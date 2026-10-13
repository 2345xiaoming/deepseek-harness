// @ts-nocheck — ported from ego-browser v2.1.0-beta.2 (strict:false); vendor exemption, not strict-checked.
import { cdp, js } from '../cdp-eval.ts'
import { state } from '../state.ts'

/** Wait budget for {@link waitForDocumentLoad}, in seconds. */
export type WaitForLoadOptions = {
  /** Seconds to allow before the wait gives up. Defaults to 15. */
  timeout?: number
}

/**
 * Wait until the page's main frame reports a committed URL and
 * `document.readyState` is `complete`. Sessions that cannot read the frame tree
 * fall back to `readyState` alone.
 * @param options - seconds to wait before giving up; defaults to 15.
 * @returns true when the document loaded before the deadline, false on timeout.
 */
export async function waitForDocumentLoad(options: WaitForLoadOptions = {}): Promise<boolean> {
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
