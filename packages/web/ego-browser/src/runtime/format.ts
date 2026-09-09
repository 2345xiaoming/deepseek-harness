// @ts-nocheck — ported from ego-browser v2.0.0-beta.4 (strict:false); vendor exemption, not strict-checked.
import { inspect } from 'node:util'

export function formatCliLogValue(value: unknown) {
  if (typeof value === 'string') {
    return value
  }
  return inspect(value, {
    depth: 6,
    breakLength: Infinity,
    compact: true,
  })
}
