// @ts-nocheck — ported from ego-browser v2.1.0-beta.2 (strict:false); vendor exemption, not strict-checked.
/** Snapshot refs for one Page target, keyed by the `@N` id the Page API publishes. */
export class RefMap {
  /** Public ref id to the node identity, accessible name, and frame recorded for it. */
  map: Map<string, any>
  /** When false, a stale ref fails instead of the resolver retrying through its locator. */
  readonly allowFallback: boolean

  constructor({ allowFallback = true } = {}) {
    this.map = new Map()
    this.allowFallback = allowFallback
  }

  /**
   * Record one ref whose frame the snapshot did not attribute; the entry is
   * replaced in place.
   * @param refId - public ref id.
   * @param backendNodeId - native backend node id the ref names.
   * @param role - accessibility role recorded with the ref.
   * @param name - accessible name recorded with the ref.
   * @param nth - index among equal role and name matches, when the snapshot numbered them.
   */
  add(refId, backendNodeId, role, name, nth = undefined): void {
    this.addWithFrame(refId, backendNodeId, role, name, nth, undefined)
  }

  /**
   * Record one ref together with the frame it was seen in; the entry is
   * replaced in place.
   * @param refId - public ref id.
   * @param backendNodeId - native backend node id the ref names.
   * @param role - accessibility role recorded with the ref.
   * @param name - accessible name recorded with the ref.
   * @param nth - index among equal role and name matches, when the snapshot numbered them.
   * @param frameId - native frame id, omitted when the ref belongs to the Page.
   * @param frameOrigin - how the frame was attributed, omitted when unknown.
   */
  addWithFrame(
    refId,
    backendNodeId,
    role,
    name,
    nth = undefined,
    frameId = undefined,
    frameOrigin = undefined,
  ): void {
    this.map.set(refId, {
      backendNodeId,
      role,
      name,
      nth,
      frameId,
      ...(frameOrigin ? { frameOrigin } : {}),
    })
  }

  /**
   * Read one published ref.
   * @param refId - public ref id.
   * @returns the recorded entry, or undefined when the ref was never added or was cleared.
   */
  get(refId): any {
    return this.map.get(refId)
  }

  /**
   * Drop every ref, for example before a full snapshot replaces them.
   */
  clear(): void {
    this.map.clear()
  }
}

/**
 * Read the numeric ref id out of a selector or ref token.
 * @param input - user-supplied selector, `@21`, `ref=21`, or `21`.
 * @returns the id as a string, or null when the input names no numeric ref.
 */
export function parseRef(input): string | null {
  const trimmed = String(input || '').trim()
  for (const candidate of [
    trimmed.startsWith('@') ? trimmed.slice(1) : null,
    trimmed.startsWith('ref=') ? trimmed.slice(4) : null,
    trimmed,
  ]) {
    if (candidate && /^\d+$/.test(candidate)) {
      return candidate
    }
  }
  return null
}
