// @ts-nocheck — ported from ego-browser v2.1.0 (strict:false); vendor exemption, not strict-checked.
import { parseRef, RefMap } from './ref-map.ts'

/** Ref map for the current Page, shared by every ported browser helper. */
export const browserRefMap = new RefMap()

let ensuring = false
let snapshotImpl: (() => Promise<unknown>) | null = null

/**
 * Register the snapshot implementation {@link ensureRefMapForRef} runs to
 * repopulate the shared ref map; the last registration wins.
 * @param fn - Snapshot function invoked once per needed refresh.
 */
export function registerSnapshotForRefRefresh(fn: () => Promise<unknown>): void {
  snapshotImpl = fn
}

/**
 * Refresh the shared ref map for one `@N` ref that has no entries yet, so a
 * ref from an earlier snapshot still resolves. Non-string and non-ref
 * selectors, a non-empty map, a missing snapshot implementation, and a refresh
 * already in flight all return without snapshotting.
 * @param selectorOrRef - Selector about to be resolved.
 * @returns after the snapshot settles; a snapshot failure propagates to the caller.
 */
export async function ensureRefMapForRef(selectorOrRef: unknown): Promise<void> {
  if (ensuring) return
  if (typeof selectorOrRef !== 'string') return
  if (!parseRef(selectorOrRef)) return
  if (browserRefMap.map.size > 0) return
  if (!snapshotImpl) return
  ensuring = true
  try {
    await snapshotImpl()
  } finally {
    ensuring = false
  }
}
