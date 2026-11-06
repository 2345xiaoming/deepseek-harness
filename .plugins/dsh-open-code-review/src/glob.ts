/**
 * Minimal glob matcher for the rule map's fixed pattern vocabulary:
 * `**` (any path segment run), `*` (within a segment), `?`, `{a,b}`
 * alternation, and `[abc]` / `[!abc]` character classes. Patterns match
 * case-insensitively against repository-relative POSIX paths — the ported
 * upstream lowercases both the pattern and the path before matching.
 * @module @dsh-external/dsh-open-code-review/glob
 */

/** Escape one regex metacharacter in a literal fragment. */
function escapeLiteral(fragment: string): string {
  return fragment.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a glob pattern to an anchored, case-insensitive regular expression.
 * @param pattern - Glob with `**`, `*`, `?`, `{a,b}`, and `[abc]` support.
 * @returns The anchored matcher for repository-relative POSIX paths.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*'
      if (isDouble) {
        // `**/` spans zero or more whole segments; a bare `**` spans anything.
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
      } else {
        out += '[^/]*'
        i += 1
      }
    } else if (ch === '?') {
      out += '[^/]'
      i += 1
    } else if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end === -1) {
        out += escapeLiteral(ch)
        i += 1
      } else {
        const branches = pattern.slice(i + 1, end).split(',').map(escapeLiteral)
        out += `(?:${branches.join('|')})`
        i = end + 1
      }
    } else if (ch === '[') {
      const end = pattern.indexOf(']', i)
      if (end === -1) {
        out += escapeLiteral(ch)
        i += 1
      } else {
        let body = pattern.slice(i + 1, end)
        let negate = ''
        if (body.startsWith('!') || body.startsWith('^')) {
          negate = '^'
          body = body.slice(1)
        }
        // Inside a class only backslash needs escaping; ranges keep `-`.
        out += `[${negate}${body.replace(/[\\]/g, '\\\\')}]`
        i = end + 1
      }
    } else {
      out += escapeLiteral(ch)
      i += 1
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

/**
 * Test a repository-relative path against one glob pattern (case-insensitive).
 * @param pattern - Glob compiled by {@link globToRegExp}.
 * @param path - Repository-relative POSIX path.
 * @returns Whether the path matches.
 */
export function globMatch(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path)
}
