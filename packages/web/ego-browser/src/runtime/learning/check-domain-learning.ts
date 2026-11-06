// @ts-nocheck — ported from ego-browser v2.1.0 (strict:false); vendor exemption, not strict-checked.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { agentWorkspace } from '../env.ts'

/** One declared argument of a site tool, as written in manifest.json. */
export interface ToolArgSchema {
  type: string
  required: boolean
  description: string
}

/** A Node or browser site tool declared in a site skill's manifest.json. */
export interface SiteToolSchema {
  description: string
  path: string
  args: Record<string, ToolArgSchema>
  returns: { type: string; description: string }
}

/** A Node site tool, which also names the module export the runner invokes. */
export interface NodeToolSchema extends SiteToolSchema {
  callable: string
}

/** Parsed manifest.json of one site skill directory. */
export interface LearningManifest {
  id: string
  name: string
  domains: string[]
  notes: string[]
  nodeTools?: Record<string, NodeToolSchema>
  browserTools?: Record<string, SiteToolSchema>
}

/** A site skill with its note and tool paths resolved against its directory. */
export interface LearningEntry {
  id: string
  name: string
  path: string
  domains: string[]
  notes: string[]
  nodeTools: Record<string, NodeToolSchema>
  browserTools: Record<string, SiteToolSchema>
}

/** Learned context for one URL: whether a skill matched, its identity, notes, and tool signatures. */
export interface LearnedContext {
  exists: boolean
  siteId: string | null
  siteName: string | null
  domain: string
  knowledge: LearnedKnowledgeNote[]
  tools: LearnedToolSignature[]
}

/** One note file's text, tagged with the site skill that supplied it. */
export interface LearnedKnowledgeNote {
  siteId: string
  fileName: string
  content: string
}

/** One site tool's model-facing signature, with a call example. */
export interface LearnedToolSignature {
  siteId: string
  toolName: string
  toolType: 'node' | 'browser'
  description: string
  args: Record<string, ToolArgSchema>
  example: string
}

/**
 * Directory holding one subdirectory per learned site skill.
 * @param workspace - agent workspace root; defaults to the current agent's workspace.
 * @returns the `learnings` path under `workspace`.
 */
export function learningsRoot(workspace = agentWorkspace()): string {
  return join(workspace, 'learnings')
}

/** Root directory of the installed site skills; alias of learningsRoot. */
export const siteSkillsRoot = learningsRoot

/**
 * Check whether any site skill declares a domain matching a URL's hostname.
 * @param urlOrDomain - page URL or bare hostname to match against manifest domains.
 * @param options - root override and agent workspace used to locate the learnings root.
 * @returns whether a skill matched, the parsed hostname, the searched root, and the matching entries.
 */
export async function checkDomainLearningExists(
  urlOrDomain: string,
  options: { root?: string; agentWorkspace?: string } = {},
): Promise<{ exists: boolean; hostname: string; root: string; matches: LearningEntry[] }> {
  const hostname = urlHostname(urlOrDomain)
  const root =
    options.root || learningsRoot(options.agentWorkspace || agentWorkspace())
  const matches = hostname ? await siteSkillsForUrl(hostname, { root }) : []
  return {
    exists: matches.length > 0,
    hostname,
    root,
    matches,
  }
}

/**
 * Check whether one site skill directory has a manifest.json.
 * @param siteId - site skill directory name under the learnings root.
 * @param options - root override and agent workspace used to locate the learnings root.
 * @returns whether the manifest exists, plus the resolved root, site directory, and manifest path.
 */
export async function checkLearningExists(
  siteId: string,
  options: { root?: string; agentWorkspace?: string } = {},
): Promise<{ exists: boolean; root: string; siteDir: string; manifestPath: string }> {
  const root =
    options.root || learningsRoot(options.agentWorkspace || agentWorkspace())
  const siteDir = join(root, siteId)
  const manifestPath = join(siteDir, 'manifest.json')
  const exists = await pathExists(manifestPath)
  return {
    exists,
    root,
    siteDir,
    manifestPath,
  }
}

/**
 * List the site skills whose manifest domains match a URL's hostname. A directory
 * whose manifest is missing or invalid is skipped rather than failing the lookup.
 * @param url - page URL or bare hostname to match.
 * @param options - root override and agent workspace used to locate the learnings root.
 * @returns one entry per matching site skill, in directory order.
 */
export async function siteSkillsForUrl(url, options: any = {}): Promise<LearningEntry[]> {
  const hostname = urlHostname(url)
  if (!hostname) {
    return []
  }
  const root =
    options.root || learningsRoot(options.agentWorkspace || agentWorkspace())
  const matches = []
  for (const siteDir of await iterLearningDirs(root)) {
    let manifest
    try {
      manifest = await loadLearningManifest(siteDir)
    } catch {
      continue
    }
    const domains = Array.isArray(manifest.domains) ? manifest.domains : []
    if (
      domains.some(
        domain =>
          typeof domain === 'string' && domainMatches(hostname, domain),
      )
    ) {
      matches.push(learningEntry(siteDir, manifest))
    }
  }
  return matches
}

/**
 * List the site skill directories under a learnings root.
 * @param root - learnings root to scan.
 * @returns the non-underscore subdirectory paths in name order, or an empty list when the root is unreadable.
 */
export async function iterLearningDirs(root: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_'))
    .map(entry => join(root, entry.name))
    .sort()
}

/**
 * Read and parse one site skill's manifest.json.
 * @param siteDir - site skill directory holding manifest.json.
 * @returns the parsed manifest.
 * @throws when manifest.json is missing, is not valid JSON, or does not hold a JSON object.
 */
export async function loadLearningManifest(
  siteDir: string,
): Promise<LearningManifest> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(siteDir, 'manifest.json'), 'utf8'))
  } catch (error) {
    throw new Error(
      `site skill ${JSON.stringify(siteDir)} has invalid or missing manifest.json: ${error.message}`,
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `site skill ${JSON.stringify(siteDir)} manifest must be an object`,
    )
  }
  return parsed as LearningManifest
}

/**
 * Resolve one parsed manifest into a learning entry: absolute note paths and
 * normalized tool maps.
 * @param siteDir - site skill directory the manifest was read from.
 * @param manifest - parsed manifest supplying id, name, domains, notes, and tools.
 * @returns the entry, defaulting a missing id or name to the directory name.
 */
export function learningEntry(
  siteDir: string,
  manifest: LearningManifest,
): LearningEntry {
  const notes = Array.isArray(manifest.notes) ? manifest.notes : []
  return {
    id: manifest.id || siteDir.split(/[\\/]/).at(-1),
    name: manifest.name || manifest.id || siteDir.split(/[\\/]/).at(-1),
    path: siteDir,
    domains: Array.isArray(manifest.domains) ? [...manifest.domains] : [],
    notes: notes.map(note => join(siteDir, note)),
    nodeTools: toolSchemasNode(manifest),
    browserTools: toolSchemasBrowser(manifest),
  }
}

/**
 * Whether a path exists and can be stat-ed.
 * @param path - filesystem path to stat.
 * @returns true when stat succeeds, false on any failure.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Extract the lowercase hostname from a URL or bare hostname.
 * @param url - absolute URL or bare hostname; a missing scheme is read as https.
 * @returns the hostname without a trailing dot, or '' when it cannot be parsed.
 */
export function urlHostname(url): string {
  try {
    const parsed = String(url).includes('://')
      ? new URL(String(url))
      : new URL(`https://${url}`)
    return (parsed.hostname || '').toLowerCase().replace(/\.$/, '')
  } catch {
    return ''
  }
}

function domainMatches(hostname, pattern) {
  const normalized = String(pattern || '')
    .toLowerCase()
    .replace(/\.$/, '')
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(2)
    return hostname.endsWith(`.${suffix}`)
  }
  return hostname === normalized
}

function toolSchemasNode(
  manifest: LearningManifest,
): Record<string, NodeToolSchema> {
  const value = manifest.nodeTools
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value }
}

function toolSchemasBrowser(
  manifest: LearningManifest,
): Record<string, SiteToolSchema> {
  const value = manifest.browserTools
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value }
}
