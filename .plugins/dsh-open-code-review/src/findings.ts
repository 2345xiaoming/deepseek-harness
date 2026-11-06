/**
 * Findings wire contract shared by the host route and the client panel: the
 * last-run endpoint path and the finding-line format. The record TYPES stay
 * separate per face — the client reads untrusted JSON and must not inherit
 * the writer's required fields — but these two facts have exactly one home.
 * @module @dsh-external/dsh-open-code-review/findings
 */

/** API prefix registered on the host web server. */
export const FINDINGS_API_PREFIX = '/@dsh-external/dsh-open-code-review/api'

/** Read-only last-run record endpoint (host registration and client fetch share it). */
export const FINDINGS_LAST_RUN_PATH = `${FINDINGS_API_PREFIX}/last-run`

/** The fields a rendered finding line is built from (subset of both faces' shapes). */
export interface FindingLineParts {
  path: string
  startLine?: number
  endLine?: number
  category?: string
  content: string
  /** A line whose position the pipeline could not anchor renders with the unverified suffix. */
  positionVerified?: boolean
}

/**
 * Render one finding as a line: `path[:start[-end]] [category][unverified] content`.
 * @param finding - The finding fields.
 * @param unverifiedSuffix - Locale-owned suffix appended when the position is unverified.
 * @returns The single-line rendering (no leading list marker).
 */
export function findingLine(finding: FindingLineParts, unverifiedSuffix: string): string {
  const at = finding.startLine !== undefined
    ? `:${finding.startLine}${finding.endLine !== undefined && finding.endLine !== finding.startLine ? `-${finding.endLine}` : ''}`
    : ''
  const verified = finding.positionVerified === false ? unverifiedSuffix : ''
  return `${finding.path}${at} [${finding.category ?? 'other'}]${verified} ${finding.content}`
}
