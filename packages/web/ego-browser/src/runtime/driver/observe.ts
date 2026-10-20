// @ts-nocheck — ported from ego-browser v2.1.0-beta.2 (strict:false); vendor exemption, not strict-checked.
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'

import { state } from '../state.ts'
import { cdp, runtimeValue } from '../cdp-eval.ts'
import {
  browserEgo,
  browserSnapshotRefsToRefMap,
  drainBrowserEvents,
  ensureSession,
  isBrowserRuntime,
} from '../browser-runtime.ts'
import { invokeEgo } from '../ego-errors.ts'
import { resolveElementCenter } from '../element-resolver.ts'
import { compactSnapshotResult } from '../snapshot-result.ts'
import {
  browserRefMap,
  ensureRefMapForRef,
  registerSnapshotForRefRefresh,
} from '../ref-state.ts'

/** Options for one Page snapshot. */
export type SnapshotOptions = {
  /** Region to capture: the visible viewport, the full Page, or one subtree. */
  scope?: 'only_within_viewport' | 'full_page' | 'subtree'
  /** Subtree root node; used with `scope: 'subtree'`. */
  root?: number
  /** Attach action marks to returned snapshot nodes. */
  includeActionMarks?: boolean
  /** Attach each ref's stable locator to the returned content. */
  includeStableLocator?: boolean
}

type ScreenshotClip = {
  x: number
  y: number
  width: number
  height: number
  scale?: number
}

/** Declarative screenshot scale; `'css'` sizes the output in CSS pixels. */
export type ScreenshotScale = 'css'

/** Options for one screenshot capture. */
export type CaptureScreenshotOptions = {
  /** Capture the whole scrollable document instead of the visible region. */
  full?: boolean
  /** Legacy escape hatch that passes `clip` through without device-pixel-ratio correction. */
  raw?: boolean
  /** Region to capture, in CSS pixels unless `raw` is set. */
  clip?: ScreenshotClip
  /** Scale mode; only `'css'` is accepted. */
  scale?: ScreenshotScale
}

/**
 * Drain the CDP events buffered for the current Page session, or for the
 * preferred target when no browser runtime is active.
 * @returns the buffered events in arrival order; the buffer is empty afterwards.
 */
export async function drainEvents(): Promise<any[]> {
  const sessionId = isBrowserRuntime() ? await ensureSession() : undefined
  return drainBrowserEvents(sessionId)
}

/**
 * Take a Page snapshot, compact its content in place, and replace the current
 * ref map with the refs it returned.
 * @param options - snapshot scope and inclusion flags.
 * @returns the snapshot result, with its content already compacted.
 */
export async function snapshot(options: SnapshotOptions = {}): Promise<any> {
  const result: any = await invokeEgo('snapshot', () =>
    browserEgo().snapshot(options),
  )
  compactSnapshotResult(result)
  browserSnapshotRefsToRefMap(browserRefMap, result.refs || [])
  return result
}

registerSnapshotForRefRefresh(() => snapshot())

/** Alias of `snapshot`, kept as the entry point that yields the full snapshot result with its refs. */
export const snapshotRaw = snapshot

/**
 * Return snapshot content with agent-friendly defaults: full page, action marks,
 * and stable locators included.
 * @param options - overrides for scope, root, and the inclusion flags.
 * @returns the snapshot content, or an empty string when it is absent.
 */
export async function snapshotText(options: SnapshotOptions = {}): Promise<any> {
  const result = await snapshot({
    scope: options.scope ?? 'full_page',
    ...(options.root === undefined ? {} : { root: options.root }),
    includeActionMarks: options.includeActionMarks ?? true,
    includeStableLocator: options.includeStableLocator ?? true,
  })
  return result.content || ''
}

/**
 * Resolve the on-screen center of a selector or `@ref`.
 * @param selectorOrRef - CSS selector, `@ref`, `loc=`, or `xpath=` expression; a ref
 *   takes one snapshot first when the shared ref map is empty.
 * @returns the CSS-pixel center plus the session that owns the element.
 */
export async function elementCenter(selectorOrRef): Promise<{ x: any; y: any; sessionId: any }> {
  await ensureRefMapForRef(selectorOrRef)
  return resolveElementCenter(
    { sendRaw: cdp },
    undefined,
    browserRefMap,
    selectorOrRef,
  )
}

// Sequence number for default screenshot file names. Combined with the pid it
// keeps concurrent agent processes (parallel task spaces) from overwriting each
// other's shots in the shared tmpdir, and successive shots in one run distinct.
let screenshotSeq = 0

/**
 * Capture a screenshot through the current Page session and write it to disk.
 * @param path - absolute output path; omitted writes a unique file under the system temp directory.
 * @param options - capture region, full-page flag, and scale mode.
 * @returns the path the PNG was written to.
 * @throws TypeError when the path is relative.
 */
export async function captureScreenshot(
  path?: string,
  options: CaptureScreenshotOptions = {},
): Promise<string> {
  assertScreenshotScale(options.scale)
  const sessionId = isBrowserRuntime() ? await ensureSession() : undefined
  return captureScreenshotForSession(path, options, sessionId)
}

/**
 * Capture a screenshot through one explicit target session. Page objects use
 * this entry point so another active tab cannot affect evaluation or capture.
 * @param path - absolute output path; omitted writes a unique file under the system temp directory.
 * @param options - capture region, full-page flag, and scale mode.
 * @param sessionId - target session to evaluate and capture in; omitted uses the current session.
 * @returns the path the PNG was written to.
 * @throws TypeError when the path is relative.
 */
export async function captureScreenshotForSession(
  path?: string,
  options: CaptureScreenshotOptions = {},
  sessionId?: string,
): Promise<string> {
  assertScreenshotScale(options.scale)
  assertScreenshotPath(path)
  const outputPath =
    path ??
    join(tmpdir(), `ego-browser-shot-${process.pid}-${++screenshotSeq}.png`)
  const full = options.full ?? false
  // CSS-pixel sizing is the default and the only declarative scale mode. Keep
  // the legacy raw flag as an internal compatibility escape hatch.
  const scale = options.scale ?? 'css'
  const raw = scale === 'css' ? false : (options.raw ?? false)
  const params: any = {
    format: 'png',
    captureBeyondViewport: full,
  }
  if (raw) {
    if (options.clip) {
      params.clip = { ...options.clip }
    }
  } else {
    const dprExpression = 'window.devicePixelRatio'
    const dpr =
      Number(
        runtimeValue(
          await cdp(
            'Runtime.evaluate',
            {
              expression: dprExpression,
              returnByValue: true,
            },
            sessionId,
          ),
          dprExpression,
        ),
      ) || 1
    const cssScale = 1 / dpr
    if (options.clip) {
      params.clip = { scale: cssScale, ...options.clip }
    } else {
      const infoExpression =
        '({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})'
      const info = runtimeValue(
        await cdp(
          'Runtime.evaluate',
          {
            expression: infoExpression,
            returnByValue: true,
          },
          sessionId,
        ),
        infoExpression,
      )
      params.clip = {
        // CDP interprets clip coordinates in the page's document coordinate
        // space. A viewport screenshot therefore starts at the current scroll
        // offset, while a full-page screenshot still starts at the document
        // origin.
        x: full ? 0 : info.sx,
        y: full ? 0 : info.sy,
        width: full ? info.pw : info.w,
        height: full ? info.ph : info.h,
        scale: cssScale,
      }
    }
  }
  const result = await cdp('Page.captureScreenshot', params, sessionId)
  await mkdir(dirname(outputPath), { recursive: true })
  await state.writeFile(outputPath, Buffer.from(result.data, 'base64'))
  return outputPath
}

function assertScreenshotScale(
  scale: unknown,
): asserts scale is ScreenshotScale | undefined {
  if (scale !== undefined && scale !== 'css') {
    throw new TypeError('captureScreenshot scale must be css')
  }
}

/**
 * Reject a relative screenshot path: the capture writes through the host
 * process, so a relative path resolves against the host directory and escapes
 * the session workspace instead of landing beside the caller's files.
 * @param path - caller-supplied output path; omitted writes under the temp directory.
 * @throws TypeError when the path is present and not absolute.
 */
function assertScreenshotPath(
  path: string | undefined,
): void {
  if (path !== undefined && !isAbsolute(path)) {
    throw new TypeError(`captureScreenshot path must be absolute: ${path}`)
  }
}
