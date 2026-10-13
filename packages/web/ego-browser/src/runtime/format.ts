// @ts-nocheck — ported from ego-browser v2.1.0-beta.2 (strict:false); vendor exemption, not strict-checked.
import { inspect } from 'node:util'

/**
 * Render one value for the CLI log: strings pass through unchanged and every
 * other value is inspected as one compact line.
 * @param value - Value to render.
 * @returns the string itself, or its single-line `util.inspect` text.
 */
export function formatCliLogValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return inspect(value, {
    depth: 6,
    breakLength: Infinity,
    compact: true,
  })
}
