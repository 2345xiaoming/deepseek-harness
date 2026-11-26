// @ts-nocheck — ported from ego-browser v2.1.0 (strict:false); vendor exemption, not strict-checked.
import { cdp } from '../cdp-eval.ts'
import { withHandle } from './element-ops.ts'

/**
 * Set files on a file input.
 * @param selector - CSS selector / @ref / loc= / xpath= for an input[type=file].
 * @param path - absolute file path, or an array of paths, to upload.
 * @returns resolves once the input's file list is replaced; the element handle
 *   is released even when the CDP call fails.
 */
export async function uploadFile(selector, path): Promise<void> {
  const files = Array.isArray(path) ? path : [path]
  await withHandle(selector, async ({ objectId, sessionId }) => {
    await cdp('DOM.setFileInputFiles', { files, objectId }, sessionId)
  })
}
