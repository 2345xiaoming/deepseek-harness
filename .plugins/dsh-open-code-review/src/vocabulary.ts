/**
 * Finding vocabulary: one source for the severity and category lists and the
 * types derived from them. The worker prompt schema, the canonical tool
 * output schemas, the normalization guards, and every severity-ordered
 * renderer read this module, so the vocabulary can never drift between them.
 * @module @dsh-external/dsh-open-code-review/vocabulary
 */

/** Severity buckets, most to least critical. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const

/** Finding category vocabulary (the delegate skill's enum). */
export const CATEGORIES = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'test',
  'style',
  'documentation',
  'other',
] as const

/** One severity bucket value. */
export type FindingSeverity = (typeof SEVERITIES)[number]

/** One finding category value. */
export type FindingCategory = (typeof CATEGORIES)[number]
