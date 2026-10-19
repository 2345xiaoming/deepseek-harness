/**
 * Page-ref identity contracts: a public `@N` ref issued by one snapshot keeps
 * naming the same node across later snapshots and rounds, expires with its
 * document, and survives persistence without ever reusing a published id.
 * Assertions ported from upstream ego-lite `page-ref-registry.test.mjs`.
 */

import { describe, expect, it } from 'vitest'
import {
  PageRefRegistry,
  pageRefDocumentId,
  validatePageRefState,
} from '../src/runtime/page-ref-registry.ts'

describe('page ref identity', () => {
  it("keeps a node's public ref across snapshots that renumber or reuse native ids", () => {
    const registry = new PageRefRegistry()
    registry.replace('page-target', [
      { refId: 1, backendNodeId: 35, role: 'iframe' },
      { refId: 2, backendNodeId: 36, role: 'iframe' },
    ])

    // The same node returns under a different native id and keeps its ref.
    const renumbered = [{ refId: 1, backendNodeId: 36, role: 'iframe' }]
    registry.merge('page-target', renumbered)
    expect(renumbered[0]?.refId).toBe(2)

    // A different node arriving with the already-published native id 2 must
    // receive a fresh public ref instead of stealing @2.
    const collision = [
      { refId: 2, backendNodeId: 43, role: 'button', frameId: 'first-frame' },
    ]
    registry.merge('page-target', collision)
    expect(collision[0]?.refId).not.toBe(2)

    const state = registry.exportState('page-target')
    expect(
      state?.refs.find(ref => ref.backendNodeId === 36),
    ).toMatchObject({ refId: '2' })
    expect(
      state?.refs.find(ref => ref.backendNodeId === 43)?.refId,
    ).toBe('3')
  })

  it('keeps equal backend node ids from different frames on distinct public refs', () => {
    const registry = new PageRefRegistry()
    registry.replace('page', [
      { refId: 1, backendNodeId: 42, frameId: 'first' },
      { refId: 2, backendNodeId: 42, frameId: 'second' },
    ])

    const subtree = [
      { refId: 1, backendNodeId: 42, frameId: 'second', name: 'Renamed' },
    ]
    registry.merge('page', subtree)

    expect(subtree[0]?.refId).toBe(2)
    expect(
      registry.exportState('page')?.refs.find(ref => ref.refId === '2'),
    ).toMatchObject({ frameId: 'second', name: 'Renamed' })
  })

  it('expires refs a full snapshot omits and never recycles them across rounds', () => {
    const registry = new PageRefRegistry()
    registry.replace('page', [{ refId: 1, backendNodeId: 42 }])
    registry.replace('page', [])

    // The next round restores the exported state; the expired ref stays
    // invalid and the replacement node receives a fresh id.
    const restored = new PageRefRegistry()
    restored.restore('page', registry.exportState('page'))
    const replacement = [{ refId: 1, backendNodeId: 43 }]
    restored.merge('page', replacement)

    expect(restored.isInvalidated('page', '1')).toBe(true)
    expect(replacement[0]?.refId).toBe(2)
  })

  it('invalidates refs when their document changes', () => {
    const registry = new PageRefRegistry()
    registry.replace('page', [
      { refId: 1, backendNodeId: 42, frameId: 'frame', documentId: 'doc-1' },
      { refId: 2, backendNodeId: 43, frameId: 'frame', documentId: 'doc-1' },
    ])

    registry.invalidateChangedDocuments('page', new Map([['frame', 'doc-1']]))
    expect(registry.isInvalidated('page', '1')).toBe(false)

    registry.invalidateChangedDocuments('page', new Map([['frame', 'doc-2']]))
    expect(registry.isInvalidated('page', '1')).toBe(true)
    expect(registry.isInvalidated('page', '2')).toBe(true)

    // A known frame keys on its document; an unknown frame origin keys on
    // the whole document set so any document change invalidates the ref.
    const documents = new Map([['frame', 'doc-1'], ['other', 'doc-2']])
    expect(
      pageRefDocumentId({ frameId: 'frame', frameOrigin: 'page' }, documents),
    ).toBe('doc-1')
    const shifted = new Map([['frame', 'doc-1'], ['other', 'doc-3']])
    expect(
      pageRefDocumentId({ frameOrigin: 'unknown' }, shifted),
    ).not.toBe(pageRefDocumentId({ frameOrigin: 'unknown' }, documents))
  })

  it('rejects corrupt persisted ref states instead of reconstructing native ids', () => {
    const ref = { refId: '1', backendNodeId: 42, active: true }
    for (const state of [
      { nextRef: 1, refs: [ref] },
      { nextRef: 2, refs: [ref, { ...ref, backendNodeId: 43 }] },
      { nextRef: 2, refs: [{ ...ref, backendNodeId: 0 }] },
    ]) {
      expect(() => validatePageRefState(state)).toThrow(
        /Invalid persisted Page refs/,
      )
    }
  })
})
