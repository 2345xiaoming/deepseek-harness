/**
 * Layered review-rule resolution: project `.opencodereview/rule.json` entries
 * override the ported system rule map, whose globs resolve to per-language
 * review checklists. A project entry replaces the system rule unless it sets
 * `merge_system_rule`, in which case the merged text states the system rule
 * first and the user rule second (the upstream template). Files that share
 * source, matched pattern, and rule text collapse into one {@link RuleGroup}
 * (the delegate `GroupRules` port).
 * @module @dsh-external/dsh-open-code-review/rules
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuleGroup, RuleSource } from './types.ts'
import { globMatch } from './glob.ts'
import { RULE_DOC_MAP, RULE_DOCS } from './assets/rule-docs.ts'

/** One project-level rule entry (the `.opencodereview/rule.json` row). */
export interface ProjectRule {
  /** Repository-relative path or glob. */
  path: string
  /** Review checklist text governing the matched file. */
  rule: string
  /** When true the system rule is kept and combined with the user rule (default false: replace). */
  merge_system_rule?: boolean
}

/** Resolved rule detail for one file. */
export interface ResolvedRule {
  source: RuleSource
  pattern: string
  text: string
}

/** Loaded rule configuration for one repository. */
export interface RuleConfig {
  /** Project rule entries, in author order. */
  projectRules: ProjectRule[]
  /** Top-level `include` globs: bypass the configured exclusion list (not a whitelist). */
  include: string[]
  /** Top-level `exclude` globs: the highest-precedence filter. */
  exclude: string[]
}

/**
 * Validate one top-level glob list at the file boundary.
 * @param value - Raw `include`/`exclude` value from the parsed rule file.
 * @param field - Field name for the diagnostic.
 * @param ruleFile - Rule file path for the diagnostic.
 * @returns The validated glob list (empty when absent).
 * @throws When the value is not an array of non-empty strings.
 */
function validateGlobList(value: unknown, field: string, ruleFile: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`invalid rule file ${ruleFile}: "${field}" must be an array of non-empty strings`)
  }
  return value as string[]
}

/**
 * Validate one rule entry at the file boundary: unknown fields are ignored,
 * but `path` and `rule` must be non-empty strings and `merge_system_rule` a
 * boolean. Malformed entries fail loud with their index.
 * @param entry - Raw entry from the parsed rule file.
 * @param index - Zero-based entry index for the diagnostic.
 * @returns The validated entry.
 * @throws When any field is missing or of the wrong type.
 */
function validateRuleEntry(entry: unknown, index: number): ProjectRule {
  const record = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : undefined
  if (record === undefined) throw new Error(`rule entry #${index}: must be an object`)
  const path = record['path']
  const rule = record['rule']
  const merge = record['merge_system_rule']
  if (typeof path !== 'string' || path.trim() === '') throw new Error(`rule entry #${index}: "path" must be a non-empty string`)
  if (typeof rule !== 'string' || rule.trim() === '') throw new Error(`rule entry #${index}: "rule" must be a non-empty string`)
  if (merge !== undefined && typeof merge !== 'boolean') throw new Error(`rule entry #${index}: "merge_system_rule" must be a boolean`)
  return { path, rule, ...(merge !== undefined ? { merge_system_rule: merge } : {}) }
}

/**
 * Load the project rule file. A missing file is the empty configuration; a
 * malformed file or entry throws with its path or index.
 * @param repo - Repository root.
 * @param ruleFile - Repository-relative rule file path.
 * @returns The parsed rule configuration.
 */
export async function loadRuleConfig(repo: string, ruleFile: string, signal?: AbortSignal): Promise<RuleConfig> {
  let raw: string
  try {
    raw = await readFile(join(repo, ruleFile), { encoding: 'utf8', ...(signal !== undefined ? { signal } : {}) })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { projectRules: [], include: [], exclude: [] }
    throw new Error(`cannot read rule file ${ruleFile}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`invalid rule file ${ruleFile}: ${String(error)}`)
  }
  const record = parsed as { rules?: unknown; include?: unknown; exclude?: unknown }
  if (!Array.isArray(record.rules)) throw new Error(`invalid rule file ${ruleFile}: "rules" must be an array`)
  return {
    projectRules: record.rules.map(validateRuleEntry),
    include: validateGlobList(record.include, 'include', ruleFile),
    exclude: validateGlobList(record.exclude, 'exclude', ruleFile),
  }
}

/**
 * Merge text in the upstream template: the system checklist first, then the
 * user rule, under explicit section headers.
 * @param systemRule - Resolved system checklist for the file.
 * @param userRule - Project rule text.
 * @returns The combined checklist.
 */
export function mergeWithSystemRule(systemRule: string, userRule: string): string {
  if (systemRule === '') return userRule
  if (userRule === '') return systemRule
  return '## System-Specific Rules (Mandatory)\n\n'
    + systemRule
    + '\n\n---\n\n'
    + '## User-Specific Rules (Mandatory)\n\n'
    + userRule
}

/**
 * Resolve the governing rule text for one file: the first matching project
 * entry wins; it replaces the system rule unless `merge_system_rule` is set.
 * Without a project entry the system map's first matching pattern applies,
 * else the default checklist.
 * @param config - Loaded project rules.
 * @param path - Repository-relative file path.
 * @param systemRules - Whether ported system rules participate.
 * @returns The rule with its source and matched pattern.
 */
export function resolveRule(config: RuleConfig, path: string, systemRules: boolean): ResolvedRule {
  for (const entry of config.projectRules) {
    if (!globMatch(entry.path, path)) continue
    const merge = entry.merge_system_rule ?? false
    if (merge && systemRules) {
      return {
        source: 'project',
        pattern: entry.path,
        text: mergeWithSystemRule(systemRuleFor(path).text, entry.rule),
      }
    }
    return { source: 'project', pattern: entry.path, text: entry.rule }
  }
  if (systemRules) return systemRuleFor(path)
  return { source: 'default', pattern: 'default', text: RULE_DOCS['default'] ?? '' }
}

/** Resolve only the system-map layer for one path. */
function systemRuleFor(path: string): ResolvedRule {
  for (const [pattern, doc] of Object.entries(RULE_DOC_MAP)) {
    if (!globMatch(pattern, path)) continue
    return {
      source: 'system',
      pattern,
      text: RULE_DOCS[doc] ?? RULE_DOCS['default'] ?? '',
    }
  }
  return { source: 'default', pattern: 'default', text: RULE_DOCS['default'] ?? '' }
}

/**
 * Group files that share source, matched pattern, and resolved rule text, so a
 * review checklist is stated once per group. Identical text from different
 * sources stays in separate groups.
 * @param config - Loaded project rules.
 * @param paths - Files to resolve.
 * @param systemRules - Whether ported system rules participate.
 * @returns Rule groups in first-seen order.
 */
export function groupRules(config: RuleConfig, paths: string[], systemRules: boolean): RuleGroup[] {
  const keyIndex = new Map<string, number>()
  const groups: RuleGroup[] = []
  for (const path of paths) {
    const resolved = resolveRule(config, path, systemRules)
    const key = `${resolved.source}\u0000${resolved.pattern}\u0000${resolved.text}`
    let index = keyIndex.get(key)
    if (index === undefined) {
      index = groups.length
      keyIndex.set(key, index)
      groups.push({
        id: index + 1,
        source: resolved.source,
        pattern: resolved.pattern,
        text: resolved.text,
        files: [],
      })
    }
    groups[index]!.files.push(path)
  }
  return groups
}
