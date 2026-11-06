/**
 * `browser_js` source policy: the string the tool hands to `js()` for each
 * input shape, plus the syntax inspections behind it. These are pure source
 * decisions, so no Chrome is launched.
 */

import { describe, expect, it } from 'vitest'
import {
  browserJsSource,
  hasReturnStatement,
  hasTopLevelAwait,
  isSingleExpression,
} from '../src/runtime/js-source.ts'

describe('browser_js source selection', () => {
  it('passes a bare expression through, so js() yields its completion value', () => {
    expect(browserJsSource('document.title')).toBe('document.title')
  })

  it('passes a statement body through, so js() yields the last statement value', () => {
    expect(browserJsSource('const x = 1; x + 1')).toBe('const x = 1; x + 1')
  })

  it('passes an outer return through, which js() wraps itself', () => {
    expect(browserJsSource('return document.title')).toBe('return document.title')
  })

  it('returns a top-level await expression from an async wrapper', () => {
    expect(browserJsSource('await f()')).toBe('(async () => { return (await f()\n) })()')
  })

  it('keeps a top-level await body in an async wrapper that preserves its return', () => {
    expect(browserJsSource('const r = await f(); return r')).toBe(
      '(async () => { const r = await f(); return r\n })()',
    )
  })
})

describe('hasTopLevelAwait', () => {
  it('detects await at the source level', () => {
    expect(hasTopLevelAwait('await f()')).toBe(true)
  })

  it('ignores await inside a nested function', () => {
    expect(hasTopLevelAwait('(async () => await f())()')).toBe(false)
  })

  it('reports false for syntax acorn cannot parse', () => {
    expect(hasTopLevelAwait('const =')).toBe(false)
  })
})

describe('hasReturnStatement', () => {
  it('detects a return at the source level', () => {
    expect(hasReturnStatement('return document.title')).toBe(true)
  })

  it('ignores a return inside a nested function', () => {
    expect(hasReturnStatement('(() => { return 1 })()')).toBe(false)
  })

  it('reports false for syntax acorn cannot parse', () => {
    expect(hasReturnStatement('const =')).toBe(false)
  })
})

describe('isSingleExpression', () => {
  it('accepts one expression', () => {
    expect(isSingleExpression('a + b')).toBe(true)
  })

  it('accepts an object literal as an expression rather than a block', () => {
    expect(isSingleExpression('{ a: 1 }')).toBe(true)
  })

  it('walks literal values that are null or carry no node type', () => {
    expect(isSingleExpression('a === null')).toBe(true)
    expect(isSingleExpression('/x/.test(a)')).toBe(true)
  })

  it('rejects a statement', () => {
    expect(isSingleExpression('const x = 1')).toBe(false)
  })

  it('rejects an outer return', () => {
    expect(isSingleExpression('return x')).toBe(false)
  })

  it('rejects syntax acorn cannot parse', () => {
    expect(isSingleExpression('const =')).toBe(false)
  })
})
