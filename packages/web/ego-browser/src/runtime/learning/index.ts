// @ts-nocheck — ported from ego-browser v2.1.0-beta.2 (strict:false); vendor exemption, not strict-checked.
import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import {
  iterLearningDirs,
  learningEntry,
  loadLearningManifest,
  siteSkillsForUrl,
  siteSkillsRoot,
  urlHostname,
  LearningManifest,
  LearnedContext,
  LearnedKnowledgeNote,
  LearnedToolSignature,
  NodeToolSchema,
  ToolSchema,
} from './check-domain-learning.ts'

export {
  checkDomainLearningExists,
  checkLearningExists,
  iterLearningDirs,
  learningsRoot,
  pathExists,
  siteSkillsForUrl,
  siteSkillsRoot,
} from './check-domain-learning.ts'
export {
  validateLearning,
  validateLearnings,
  validateSiteSkills,
} from './validate-learning-format.ts'

/**
 * Load learned context for a given URL: matched site skills, the text of their
 * notes, and their tool signatures.
 * @param url - page URL or bare hostname to look up.
 * @param options - root override and agent workspace forwarded to siteSkillsForUrl.
 * @returns the matched context, or an empty context with `exists: false` when no skill matches.
 */
export async function loadLearnedContext(
  url: string,
  options: any = {},
): Promise<LearnedContext> {
  const matches = await siteSkillsForUrl(url, options)
  if (matches.length === 0) {
    return {
      exists: false,
      siteId: null,
      siteName: null,
      domain: urlHostname(url),
      knowledge: [],
      tools: [],
    }
  }

  const toolSignatures: LearnedToolSignature[] = []
  const knowledgeNotes: LearnedKnowledgeNote[] = []

  for (const entry of matches) {
    const siteId = entry.id

    for (const notePath of entry.notes) {
      if (!isLearningNotePath(entry.path, notePath)) {
        continue
      }
      let content: string
      try {
        content = await readFile(notePath, 'utf8')
      } catch {
        continue
      }
      const fileName = notePath.split(/[\\/]/).pop() || ''
      knowledgeNotes.push({ siteId, fileName, content })
    }

    // Build tool signatures with usage examples
    const nodeTools: Record<string, NodeToolSchema> = entry.nodeTools || {}
    for (const [toolName, schema] of Object.entries(nodeTools)) {
      toolSignatures.push({
        siteId,
        toolName,
        toolType: 'node',
        description: schema.description || '',
        args: schema.args || {},
        returns: schema.returns || null,
        example: `await runSiteTool("${siteId}", "${toolName}", { ... })`,
      })
    }

    const browserTools: Record<string, ToolSchema> = entry.browserTools || {}
    for (const [toolName, schema] of Object.entries(browserTools)) {
      toolSignatures.push({
        siteId,
        toolName,
        toolType: 'browser',
        description: schema.description || '',
        args: schema.args || {},
        returns: schema.returns || null,
        example: `await runSiteBrowserTool("${siteId}", "${toolName}", { ... })`,
      })
    }
  }

  return {
    exists: true,
    siteId: matches[0].id,
    siteName: matches[0].name,
    domain: urlHostname(url),
    knowledge: knowledgeNotes,
    tools: toolSignatures,
  }
}

function isLearningNotePath(siteDir: string, notePath: string) {
  const relativePath = relative(resolve(siteDir), resolve(notePath))
  const parts = relativePath.split(/[\\/]/)
  return (
    parts.length === 2 &&
    parts[0] === 'notes' &&
    parts[1].endsWith('.md') &&
    parts.every(part => part && part !== '.' && part !== '..')
  )
}

/**
 * Find the site skill whose manifest declares the given id.
 * @param siteId - manifest `id` to match, not the directory name.
 * @param options - root override and agent workspace used to locate the site skills root.
 * @returns the skill's directory and parsed manifest.
 * @throws when no site skill declares the id; the error names the searched root and workspace override.
 */
export async function findSiteSkill(
  siteId: string,
  options: any = {},
): Promise<{ siteDir: string; manifest: LearningManifest }> {
  const root = options.root || siteSkillsRoot(options.agentWorkspace)
  for (const siteDir of await iterLearningDirs(root)) {
    const manifest = await loadLearningManifest(siteDir)
    if (manifest.id === siteId) {
      return { siteDir, manifest }
    }
  }
  throw siteSkillNotFoundError(siteId, root)
}

/**
 * Run one Node site tool declared by a site skill.
 * @param siteId - site skill id that declares the tool.
 * @param toolName - tool name in the skill's nodeTools map.
 * @param args - arguments object passed to the callable.
 * @param ctx - host context given to the callable as its first argument.
 * @param options - root override and agent workspace used to locate the site skills root.
 * @returns whatever the tool callable resolves to.
 * @throws when the skill, tool, callable, or tool path is missing or escapes the skill directory.
 */
export async function runNodeSiteTool(
  siteId,
  toolName,
  args: any = {},
  ctx,
  options: any = {},
): Promise<any> {
  const { siteDir, manifest } = await findSiteSkill(siteId, options)
  const schema = toolSchemas(manifest, 'nodeTools')[toolName]
  if (!schema || typeof schema !== 'object') {
    throw new Error(
      `Node tool ${JSON.stringify(toolName)} is not declared by site skill ${JSON.stringify(siteId)}`,
    )
  }
  const toolPath = relativeSitePath(siteDir, schema.path, 'Node tool')
  const module = await import(
    `${pathToFileURL(toolPath).href}?t=${Date.now()}`,
  )
  const callableName = schema.callable
  if (typeof callableName !== 'string' || !callableName.trim()) {
    throw new Error(
      `Node tool ${JSON.stringify(toolName)} must declare a callable`,
    )
  }
  const tool = module[callableName]
  if (typeof tool !== 'function') {
    throw new Error(
      `site skill ${JSON.stringify(siteId)} is missing Node callable ${JSON.stringify(callableName)}`,
    )
  }
  return tool(ctx, args || {})
}

/**
 * Read one browser site tool's source file, which the caller wraps and evaluates
 * in the page.
 * @param siteId - site skill id that declares the tool.
 * @param toolName - tool name in the skill's browserTools map.
 * @param options - root override and agent workspace used to locate the site skills root.
 * @returns the tool file's text.
 * @throws when the skill, tool, or tool path is missing or escapes the skill directory.
 */
export async function loadBrowserToolSource(
  siteId,
  toolName,
  options: any = {},
): Promise<string> {
  const { siteDir, manifest } = await findSiteSkill(siteId, options)
  const schema = toolSchemas(manifest, 'browserTools')[toolName]
  if (!schema || typeof schema !== 'object') {
    throw new Error(
      `browser tool ${JSON.stringify(toolName)} is not declared by site skill ${JSON.stringify(siteId)}`,
    )
  }
  const toolPath = relativeSitePath(siteDir, schema.path, 'browser tool')
  return readFile(toolPath, 'utf8')
}

/**
 * Wrap a browser tool's source as an async IIFE called with a JSON copy of `args`.
 * @param source - the tool's source text, expected to be a function expression.
 * @param args - arguments serialized into the call; defaults to an empty object.
 * @returns the expression to evaluate in the page.
 */
export function wrapBrowserTool(source, args: any = {}): string {
  return `(async () => { const __egoBrowserTool = ${source}; return await __egoBrowserTool(${JSON.stringify(args || {})}); })()`
}

export { learningEntry }

function siteSkillNotFoundError(siteId, searchedRoot) {
  const workspace = process.env.EGO_BROWSER_AGENT_WORKSPACE || 'unset'
  const lines = [
    `site skill not found: ${JSON.stringify(siteId)}`,
    `  searched: ${searchedRoot}`,
    `  EGO_BROWSER_AGENT_WORKSPACE: ${workspace}`,
    '  hint: ensure your write path begins with the searched root above',
  ]
  return new Error(lines.join('\n'))
}

function toolSchemas(manifest, key) {
  const value = manifest[key] || {}
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {}
}

function relativeSitePath(siteDir, manifestPath, label) {
  if (typeof manifestPath !== 'string' || !manifestPath.trim()) {
    throw new Error(`${label} path must be a non-empty relative path`)
  }
  if (
    manifestPath.includes('\\') ||
    isAbsolute(manifestPath) ||
    manifestPath.split('/').includes('..')
  ) {
    throw new Error(
      `${label} path must be relative to the site skill directory`,
    )
  }
  const resolved = resolve(siteDir, manifestPath)
  const siteRoot = resolve(siteDir)
  if (resolved !== siteRoot && !resolved.startsWith(`${siteRoot}/`)) {
    throw new Error(`${label} path must stay inside the site skill directory`)
  }
  return resolved
}
