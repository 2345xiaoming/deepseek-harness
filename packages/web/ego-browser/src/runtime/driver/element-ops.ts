// @ts-nocheck — ported from ego-browser v2.1.0-beta.2 (strict:false); vendor exemption, not strict-checked.
import { cdp } from '../cdp-eval.ts'
import { browserRefMap, ensureRefMapForRef } from '../ref-state.ts'
import { resolveElementObjectId } from '../element-resolver.ts'

/**
 * Resolve any selector form to a CDP Runtime objectId handle.
 * Accepts @ref / ref=N, loc=css:/loc=role:/loc=href:, text=, xpath=, and raw
 * CSS — the same surface as the pointer/observe helpers, via the unified resolver.
 * Refreshes the RefMap on demand when the input is a ref and the map is empty.
 * @param selectorOrRef - selector or ref string.
 * @returns the remote object handle and the session that owns it; the caller
 *   must release it with releaseHandle.
 */
export async function resolveHandle(selectorOrRef): Promise<{ objectId: string; sessionId: string; frameId?: string }> {
  await ensureRefMapForRef(selectorOrRef)
  return resolveElementObjectId(
    { sendRaw: cdp },
    undefined,
    browserRefMap,
    selectorOrRef,
  )
}

/**
 * Release a Runtime objectId handle. Best-effort: "already gone" errors
 * (stale handle, lost session, destroyed context) are swallowed, and a falsy
 * objectId skips the CDP call entirely.
 * @param objectId - runtime remote object id to release.
 * @param sessionId - session that owns the handle.
 * @returns resolves once the release attempt settles, successful or not.
 */
export async function releaseHandle(objectId, sessionId): Promise<void> {
  if (!objectId) return
  try {
    await cdp('Runtime.releaseObject', { objectId }, sessionId)
  } catch {
    // Handle/session already invalid; releasing is best-effort.
  }
}

/**
 * Resolve a handle, run fn(handle), then release the handle — even when fn throws.
 * @param selectorOrRef - selector or ref string.
 * @param fn - callback bound to the resolved handle.
 * @returns whatever fn returns.
 */
export async function withHandle(selectorOrRef, fn): Promise<any> {
  const handle = await resolveHandle(selectorOrRef)
  try {
    return await fn(handle)
  } finally {
    await releaseHandle(handle.objectId, handle.sessionId)
  }
}

/**
 * Resolve an element and call a function on it via Runtime.callFunctionOn,
 * with the element bound as `this`. The resolved handle is released afterward;
 * the returned objectId is already freed and must not be reused.
 * @param selectorOrRef - selector or ref string.
 * @param functionDeclaration - function source whose `this` is the element.
 * @param args - arguments passed by value; defaults to none.
 * @returns the CDP call result plus the identity of the released handle.
 */
export async function resolveAndCall(
  selectorOrRef,
  functionDeclaration,
  args = [],
): Promise<any> {
  return withHandle(selectorOrRef, async ({ objectId, sessionId }) => {
    const result = await cdp(
      'Runtime.callFunctionOn',
      {
        functionDeclaration,
        objectId,
        arguments: args.map(value => ({ value })),
        returnByValue: true,
        awaitPromise: false,
      },
      sessionId,
    )
    return { result, objectId, sessionId }
  })
}
