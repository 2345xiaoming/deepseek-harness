// @ts-nocheck — ported from ego-browser v2.1.0 (strict:false); vendor exemption, not strict-checked.
import { RefMap } from './ref-map.ts'

const MAX_INVALIDATED_REFS_PER_TARGET = 10_000

type SnapshotRef = {
  refId?: string | number
  backendNodeId?: number
  frameId?: string
  frameOrigin?: 'page' | 'frame' | 'unknown'
  role?: string
  name?: string
  documentId?: string
}

type StoredRef = SnapshotRef & { refId: string; active: boolean }

/** Serialized public ref state for one Page target: the next free ref number and every ref published so far. */
export type PageRefState = { nextRef: number; refs: StoredRef[] }

/** Public Page refs retain node identity even when native snapshot ids restart. */
export class PageRefRegistry {
  readonly #targets = new Map<string, RefMap>()
  readonly #states = new Map<string, PageRefState>()

  /**
   * Return the ref map for one target, creating an empty one on first use.
   * @param targetId - native page target id.
   * @returns the target's ref map, which rejects locator fallback.
   */
  forTarget(targetId: string): RefMap {
    assertTargetId(targetId)
    let refs = this.#targets.get(targetId)
    if (!refs) {
      refs = new RefMap({ allowFallback: false })
      this.#targets.set(targetId, refs)
    }
    return refs
  }

  /**
   * Replace the target's refs with a fresh snapshot, expiring the refs the
   * snapshot omits.
   * @param targetId - native page target id.
   * @param snapshotRefs - refs the new snapshot published.
   * @returns the rebuilt ref map for the target.
   */
  replace(targetId: string, snapshotRefs: SnapshotRef[] = []): RefMap {
    return this.#register(targetId, snapshotRefs, true)
  }

  /**
   * Merge a subtree snapshot into the target's refs without expiring the rest.
   * @param targetId - native page target id.
   * @param snapshotRefs - refs the subtree snapshot published.
   * @returns the rebuilt ref map for the target.
   */
  merge(targetId: string, snapshotRefs: SnapshotRef[] = []): RefMap {
    return this.#register(targetId, snapshotRefs, false)
  }

  /**
   * Read the target's ref state for persistence.
   * @param targetId - native page target id.
   * @returns a structured copy the caller may mutate, or undefined when the
   *   target has no state.
   */
  exportState(targetId: string): PageRefState | undefined {
    return structuredClone(this.#states.get(targetId))
  }

  /**
   * Replace the target's refs with persisted state.
   * @param targetId - native page target id.
   * @param state - state from `exportState`; omitting it clears the target.
   * @throws when the state fails `validatePageRefState`.
   */
  restore(targetId: string, state?: PageRefState): void {
    this.clear(targetId)
    if (state) this.#states.set(targetId, validatePageRefState(state))
    this.#rebuild(targetId)
  }

  /**
   * Deactivate every ref whose frame document id no longer matches.
   * @param targetId - native page target id.
   * @param documents - frame id to current document id.
   */
  invalidateChangedDocuments(
    targetId: string,
    documents: Map<string, string>,
  ): void {
    const state = this.#states.get(targetId)
    if (!state) return
    for (const ref of state.refs) {
      if (
        !ref.documentId ||
        ref.documentId !== pageRefDocumentId(ref, documents)
      ) {
        ref.active = false
      }
    }
    this.#rebuild(targetId)
  }

  #register(
    targetId: string,
    snapshotRefs: SnapshotRef[],
    replace: boolean,
  ): RefMap {
    assertTargetId(targetId)
    const state = this.#states.get(targetId) || { nextRef: 1, refs: [] }
    const byIdentity = new Map(
      state.refs
        .filter(ref => ref.frameOrigin !== 'unknown')
        .map(ref => [nodeIdentity(ref), ref]),
    )
    const byId = new Map(state.refs.map(ref => [ref.refId, ref]))
    const firstUnused = state.nextRef
    if (replace) for (const ref of state.refs) ref.active = false
    for (const ref of snapshotRefs) {
      if (
        !ref ||
        !Number.isSafeInteger(ref.backendNodeId) ||
        ref.backendNodeId! <= 0
      )
        continue
      // An unknown frame origin cannot establish identity across snapshots.
      const previous =
        ref.frameOrigin === 'unknown'
          ? undefined
          : byIdentity.get(nodeIdentity(ref))
      let refId = previous?.refId
      if (!refId) {
        const nativeId = Number(ref.refId ?? ref.backendNodeId)
        const candidate =
          Number.isSafeInteger(nativeId) &&
          nativeId >= firstUnused &&
          !byId.has(String(nativeId))
            ? nativeId
            : state.nextRef
        refId = String(candidate)
        state.nextRef = Math.max(state.nextRef, candidate + 1)
        if (!Number.isSafeInteger(state.nextRef))
          throw new Error('Page ref ids exhausted')
      }
      ref.refId = Number(refId)
      const stored: StoredRef = {
        refId,
        backendNodeId: ref.backendNodeId,
        role: ref.role,
        name: ref.name,
        frameId: ref.frameId,
        frameOrigin: ref.frameOrigin,
        documentId: ref.documentId,
        active: true,
      }
      byId.set(refId, stored)
      byIdentity.set(nodeIdentity(stored), stored)
    }
    state.refs = [...byId.values()]
    this.#states.set(targetId, state)
    return this.#rebuild(targetId)
  }

  /**
   * Deactivate every published ref for the target, for example after its
   * document changed.
   * @param targetId - native page target id.
   */
  invalidate(targetId: string): void {
    assertTargetId(targetId)
    const state = this.#states.get(targetId)
    if (state) for (const ref of state.refs) ref.active = false
    this.#rebuild(targetId)
  }

  /**
   * Report whether one published ref is currently deactivated.
   * @param targetId - native page target id.
   * @param refId - public ref id to test.
   * @returns true when the target has state for the ref and it is inactive.
   */
  isInvalidated(targetId: string, refId: string): boolean {
    assertTargetId(targetId)
    return (
      this.#states
        .get(targetId)
        ?.refs.some(ref => ref.refId === refId && !ref.active) ?? false
    )
  }

  /**
   * Drop all ref state for the target.
   * @param targetId - native page target id.
   */
  clear(targetId: string): void {
    assertTargetId(targetId)
    this.#targets.delete(targetId)
    this.#states.delete(targetId)
  }

  #rebuild(targetId: string): RefMap {
    const refs = new RefMap({ allowFallback: false })
    const state = this.#states.get(targetId)
    if (state) {
      let inactive = state.refs.filter(ref => !ref.active).length
      state.refs = state.refs.filter((ref) => {
        if (!ref.active && inactive > MAX_INVALIDATED_REFS_PER_TARGET) {
          inactive--
          return false
        }
        if (ref.active)
          refs.addWithFrame(
            ref.refId,
            ref.backendNodeId,
            ref.role,
            ref.name,
            undefined,
            ref.frameId,
            ref.frameOrigin,
          )
        return true
      })
    }
    this.#targets.set(targetId, refs)
    return refs
  }
}

/**
 * Reject corrupt persisted mappings instead of reconstructing native ids.
 * @param value - parsed persisted state of one Page target.
 * @returns a structured copy of the validated state.
 * @throws when the state is not a valid Page ref mapping.
 */
export function validatePageRefState(value: unknown): PageRefState {
  const state = value as PageRefState
  const ids = new Set<string>()
  if (
    !state ||
    !Number.isSafeInteger(state.nextRef) ||
    state.nextRef < 1 ||
    !Array.isArray(state.refs) ||
    state.refs.some((ref) => {
      if (
        !ref ||
        typeof ref.refId !== 'string' ||
        !/^[1-9]\d*$/.test(ref.refId) ||
        ids.has(ref.refId) ||
        Number(ref.refId) >= state.nextRef ||
        !Number.isSafeInteger(ref.backendNodeId) ||
        ref.backendNodeId! <= 0 ||
        typeof ref.active !== 'boolean' ||
        ![undefined, 'page', 'frame', 'unknown'].includes(
          ref.frameOrigin,
        ) ||
        [ref.frameId, ref.documentId, ref.role, ref.name].some(
          value => value !== undefined && typeof value !== 'string',
        )
      )
        return true
      ids.add(ref.refId)
      return false
    })
  )
    throw new Error('Invalid persisted Page refs; take a new snapshot')
  return structuredClone(state)
}

function nodeIdentity(ref: SnapshotRef): string {
  return JSON.stringify([
    ref.frameId ?? null,
    ref.backendNodeId,
    ref.documentId ?? null,
  ])
}

/**
 * Identify the document one ref belongs to, so a document change can expire it.
 * @param ref - snapshot ref to identify.
 * @param documents - frame id to current document id.
 * @returns the ref's frame document id, or the sorted set of every known
 *   document id when the ref's frame origin is unknown.
 */
export function pageRefDocumentId(
  ref: SnapshotRef,
  documents: Map<string, string>,
): string | undefined {
  return ref.frameOrigin === 'unknown'
    ? JSON.stringify([...documents].sort(([a], [b]) => a.localeCompare(b)))
    : documents.get(ref.frameId || '')
}

function assertTargetId(targetId: string): void {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new TypeError('PageRefRegistry requires a non-empty targetId')
  }
}
