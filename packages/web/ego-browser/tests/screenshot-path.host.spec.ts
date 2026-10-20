/**
 * Screenshot output-path contract: the capture writes through the host process,
 * so a relative path resolves against the host directory and escapes the session
 * workspace. The assertion must fire before any browser work starts.
 */
import { describe, expect, it } from 'vitest'
import { captureScreenshotForSession } from '../src/runtime/driver/observe.ts'

describe('screenshot output path', () => {
  it('rejects a relative path before touching the browser', async () => {
    await expect(captureScreenshotForSession('relative.png')).rejects.toThrow(/must be absolute/)
  })

  it('does not reject an absolute path on the path assertion', async () => {
    const failure = await captureScreenshotForSession('/tmp/ego-browser-path-test.png')
      .then(() => undefined, (error: unknown) => error as Error)
    expect(String(failure?.message ?? '')).not.toMatch(/must be absolute/)
  })
})
