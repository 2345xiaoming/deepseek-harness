// @ts-nocheck — ported from ego-browser v2.0.0-beta.4 (strict:false); vendor exemption, not strict-checked.
import { cdp } from '../cdp-eval.ts'
import { withHandle } from './element-ops.ts'

/**
 * Set files on a file input.
 * @param {string} selector CSS selector / @ref / loc= / xpath= for an input[type=file].
 * @param {string|string[]} path Absolute file path or paths to upload.
 * @returns {Promise<void>}
 */
export async function uploadFile(selector, path) {
  const files = Array.isArray(path) ? path : [path]
  await withHandle(selector, async ({ objectId, sessionId }) => {
    await cdp('DOM.setFileInputFiles', { files, objectId }, sessionId)
  })
}
