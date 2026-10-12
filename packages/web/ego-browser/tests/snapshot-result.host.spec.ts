/**
 * Snapshot result contracts: ref rewriting and frame-provenance attribution
 * must treat quoted accessible names and locator values as opaque text, and
 * locator sanitization must drop only the locators that fail validation while
 * keeping their refs. Assertions ported from upstream ego-lite
 * `snapshot-result.test.mjs`.
 */

import { describe, expect, it } from 'vitest'
import {
  preparePageSnapshotResult,
  rewriteSnapshotRefIds,
  sanitizeSnapshotLocators,
} from '../src/runtime/snapshot-result.ts'

describe('snapshot ref rewriting', () => {
  it('rewrites only ref metadata, leaving quoted names and locator values intact', () => {
    const input = [
      'button "literal \\"[ref=1]\\"" [ref=1, loc=css:[data-ref="[ref=1]"]]',
      '  button "Second" [ref=2]',
      '  text "keep [ref=1]"',
      'button [ref=99]',
      '',
    ].join('\r\n')

    expect(
      rewriteSnapshotRefIds(input, new Map([['1', '2'], ['2', '3']])),
    ).toBe(
      [
        'button "literal \\"[ref=1]\\"" [ref=2, loc=css:[data-ref="[ref=1]"]]',
        '  button "Second" [ref=3]',
        '  text "keep [ref=1]"',
        'button [ref=99]',
        '',
      ].join('\r\n'),
    )
  })
})

describe('snapshot frame provenance', () => {
  it('backfills frame provenance for iframe descendants from a unique locator', async () => {
    const input = {
      content: [
        'iframe [ref=12]',
        'root',
        '  button "Run iframe action" [ref=21, loc=role:button[name="Run iframe action"]]',
      ].join('\n'),
      refs: [
        {
          refId: 21,
          backendNodeId: 21,
          role: 'button',
          name: 'Run iframe action',
          loc: 'role:button[name="Run iframe action"]',
        },
      ],
    }

    const result = await preparePageSnapshotResult(
      {
        async cdp(method, params, sessionId) {
          expect(method).toBe('Accessibility.getFullAXTree')
          const ownedByFrame =
            sessionId === 'session:page' && params?.frameId === 'frame-same'
          if (!ownedByFrame) return { nodes: [] }
          return {
            nodes: [
              {
                backendDOMNodeId: 21,
                ignored: false,
                role: { value: 'button' },
                name: { value: 'Run iframe action' },
              },
            ],
          }
        },
      },
      'session:page',
      new Map([
        ['frame-same', 'session:page'],
        ['frame-oopif', 'session:oopif'],
      ]),
      input,
    )

    expect(result.refs?.[0]?.frameId).toBe('frame-same')
    expect(result.refs?.[0]?.frameProvenance).toBe('frame')
  })

  it('ignores ref tokens inside accessible names when attributing frame provenance', async () => {
    const input = {
      content: [
        'root',
        '  link "See [ref=3] in the spec" [ref=3]',
        '  iframe [ref=12]',
        '    root',
        '      link "See [ref=3] in the spec" [ref=42]',
      ].join('\n'),
      refs: [
        { refId: 3, backendNodeId: 3, role: 'link', name: 'See [ref=3] in the spec' },
        { refId: 42, backendNodeId: 42, role: 'link', name: 'See [ref=3] in the spec' },
      ],
    }

    const result = await preparePageSnapshotResult(
      {
        async cdp() {
          return { nodes: [] }
        },
      },
      'session:page',
      new Map([['frame-child', 'session:page']]),
      input,
    )

    expect(
      result.refs?.[0]?.frameProvenance,
      'the page-owned ref must not be re-homed by a quoted ref token',
    ).toBe('page')
    expect(result.refs?.[1]?.frameProvenance).toBe('frame')
    expect(result.refs?.[1]?.frameId).toBe('frame-child')
  })

  it('does not invent frame provenance for an ambiguous iframe descendant', async () => {
    const input = {
      content: [
        'iframe [ref=12]',
        'root',
        '  button "Duplicate action" [ref=21, loc=role:button[name="Duplicate action"]]',
      ].join('\n'),
      refs: [
        {
          refId: 21,
          backendNodeId: 21,
          role: 'button',
          name: 'Duplicate action',
          loc: 'role:button[name="Duplicate action"]',
        },
      ],
    }

    const result = await preparePageSnapshotResult(
      {
        async cdp(method, params, sessionId) {
          expect(method).toBe('Accessibility.getFullAXTree')
          const inFirstFrame =
            sessionId === 'session:page' && params?.frameId === 'frame-first'
          const inSecondFrame = sessionId === 'session:second'
          if (!inFirstFrame && !inSecondFrame) return { nodes: [] }
          return {
            nodes: [
              {
                backendDOMNodeId: 21,
                ignored: false,
                role: { value: 'button' },
                name: { value: 'Duplicate action' },
              },
            ],
          }
        },
      },
      'session:page',
      new Map([
        ['frame-first', 'session:page'],
        ['frame-second', 'session:second'],
      ]),
      input,
    )

    expect(result.refs?.[0]?.frameId).toBeUndefined()
    expect(result.refs?.[0]?.frameProvenance).toBe('unknown')
  })
})

describe('snapshot locator sanitization', () => {
  it('drops locators for invalid refs and keeps them for valid ones', async () => {
    const input = {
      content: [
        'textfield "Prompt" [ref=10, loc=css:#prompt, url=https://example.com/prompt]',
        'text "literal ref=10, loc=css:#prompt"',
        'button "Save" [ref=11, loc=role:button[name="Save"]]',
      ].join('\n'),
      refs: [
        { backendNodeId: 10, role: 'textfield', name: 'Prompt', loc: 'css:#prompt' },
        { backendNodeId: 11, role: 'button', name: 'Save', loc: 'role:button[name="Save"]' },
      ],
    }

    const result = await sanitizeSnapshotLocators(
      input,
      async ref => ref.backendNodeId === 11,
    )

    expect(result.content).toBe(
      [
        'textfield "Prompt" [ref=10, url=https://example.com/prompt]',
        'text "literal ref=10, loc=css:#prompt"',
        'button "Save" [ref=11, loc=role:button[name="Save"]]',
      ].join('\n'),
    )
    expect(result.refs?.[0]?.loc).toBeUndefined()
    expect(result.refs?.[1]?.loc).toBe('role:button[name="Save"]')
  })
})
