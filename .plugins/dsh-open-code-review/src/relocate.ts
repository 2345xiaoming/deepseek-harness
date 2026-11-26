/**
 * Comment positioning: deterministic relocation and verification of
 * worker-reported line numbers against the unified diff. A verbatim snippet
 * that matches contiguous added lines remaps the comment to that span (the
 * occurrence nearest the claimed line wins); otherwise the claimed range is
 * verified when it falls inside a changed hunk of the new file. This is the
 * deterministic half of OpenCodeReview's comment-positioning module.
 * @module @dsh-external/dsh-open-code-review/relocate
 */

import type { RawComment } from './worker.ts'

/** One changed (added) line with its new-file number and text. */
interface AddedLine {
  line: number
  text: string
}

/** One changed hunk span in the new file. */
interface ChangedRange {
  start: number
  end: number
}

/**
 * Extract every added line from one unified diff.
 * @param diff - Unified diff text.
 * @returns Added lines with 1-based new-file line numbers.
 */
export function addedLines(diff: string): AddedLine[] {
  const lines: AddedLine[] = []
  let newLine = 0
  let inHunk = false
  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk !== null) {
      newLine = Number(hunk[1])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+')) {
      lines.push({ line: newLine, text: raw.slice(1) })
      newLine += 1
    } else if (raw.startsWith('-')) {
      // deleted line: does not advance the new-file counter
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" marker
    } else {
      newLine += 1
    }
  }
  return lines
}

/**
 * Extract the new-file line span of every changed hunk.
 * @param diff - Unified diff text.
 * @returns Hunk spans (start and end inclusive, 1-based).
 */
export function changedRanges(diff: string): ChangedRange[] {
  const ranges: ChangedRange[] = []
  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (hunk === null) continue
    const start = Number(hunk[1])
    const count = hunk[2] !== undefined ? Number(hunk[2]) : 1
    if (count > 0) ranges.push({ start, end: start + count - 1 })
  }
  return ranges
}

/** Position outcome for one comment after deterministic relocation. */
export interface PositionedComment {
  comment: RawComment
  /** Verified 1-based new-file start line, when position could be established. */
  startLine?: number
  endLine?: number
  positionVerified: boolean
}

/**
 * Relocate and verify one comment against its subject diff.
 * @param comment - Worker-reported comment, optionally carrying a verbatim snippet.
 * @param subjectDiff - Unified diff of the comment's subject file.
 * @returns The comment with its verified position.
 */
export function positionComment(comment: RawComment, subjectDiff: string): PositionedComment {
  const added = addedLines(subjectDiff)
  const snippet = comment.snippet?.trim()

  if (snippet !== undefined && snippet !== '' && added.length > 0) {
    const needle = snippet.split('\n').map(line => line.trim())
    let best: ChangedRange | undefined
    for (let i = 0; i + needle.length - 1 < added.length; i += 1) {
      if (added[i]!.text.trim() !== needle[0]) continue
      let matched = true
      for (let j = 1; j < needle.length; j += 1) {
        const entry = added[i + j]
        const previous = added[i + j - 1]!
        if (entry === undefined || entry.text.trim() !== needle[j] || previous.line + 1 !== entry.line) {
          matched = false
          break
        }
      }
      if (!matched) continue
      const candidate: ChangedRange = { start: added[i]!.line, end: added[i + needle.length - 1]!.line }
      // Prefer the occurrence nearest the claimed line.
      const claimed = comment.startLine ?? candidate.start
      if (best === undefined || Math.abs(candidate.start - claimed) < Math.abs(best.start - claimed)) {
        best = candidate
      }
    }
    if (best !== undefined) {
      return { comment, startLine: best.start, endLine: best.end, positionVerified: true }
    }
    // Snippet unmatched among the additions: fall through to line verification.
  }

  if (comment.startLine !== undefined) {
    const start = comment.startLine
    const end = comment.endLine ?? start
    const range = changedRanges(subjectDiff).find(candidate => start >= candidate.start && start <= candidate.end)
    const verified = range !== undefined && end >= start && end <= range.end
    return {
      comment,
      startLine: start,
      endLine: end,
      positionVerified: verified,
    }
  }
  return { comment, positionVerified: false }
}

/**
 * Relocate and verify a batch, each against its own subject file's diff.
 * @param comments - Worker-reported comments.
 * @param diffByPath - Subject-file diffs keyed by repository-relative path.
 * @returns Positioned comments in input order.
 */
export function positionComments(
  comments: RawComment[],
  diffByPath: Map<string, string>,
): PositionedComment[] {
  return comments.map(comment => {
    const diff = diffByPath.get(comment.path) ?? ''
    return positionComment(comment, diff)
  })
}
