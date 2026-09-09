/**
 * Self-contained semantic snapshot for the ego bridge.
 *
 * The closed-source ego runtime provided `ego.snapshot(options)` → `{ content, refs }`,
 * which the harness's `observe.snapshotRaw` feeds straight into the ref map
 * (`browserSnapshotRefsToRefMap` reads `backendNodeId`/`role`/`name` from each ref).
 * In a pure-Chrome deployment nobody else builds that snapshot, so this module does:
 *
 *   1. pick the active page target (mirrors the bridge's listTabs contract),
 *   2. attach a flattened CDP session to it,
 *   3. walk `Accessibility.getFullAXTree` (main-frame tree), skipping ignored nodes,
 *   4. emit an indented text tree (role ← name/value) and collect
 *      `{ backendNodeId, role, name }` refs for interactive/useful roles.
 *
 * The output does not intend to clone the closed runtime byte-for-byte — it only
 * needs to be self-consistent: the `@N` refs resolve back through the harness's
 * `element-resolver` (which re-reads AX by role/name), and `content` reads as a
 * truthful, agent-legible page outline.
 */

import { getChrome } from './chrome.ts'
import { attachSession, sendRaw } from './ws-cdp.ts'

export interface SnapshotRef {
  backendNodeId: number
  role: string
  name: string | undefined
}

export interface Snapshot {
  content: string
  refs: SnapshotRef[]
}

interface AxNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string | number }
  backendDOMNodeId?: number
  childIds?: string[]
}

/** Extract the accessible value string from an AX property. */
function axString(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object') {
    // CDP AXValue: { type, value, ... }
    const v = (value as { value?: unknown }).value
    if (v === undefined || v === null) return ''
    if (typeof v === 'string') return v
    return String(v)
  }
  return String(value)
}

// Roles whose names/values are not useful as a standalone leaf line.
const PRUNE_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'StaticText',
  'InlineTextBox',
  'paragraph',
  'comment',
  'mark',
  'suggestion',
  'group',
  'list',
  'listitem',
  'strong',
  'emphasis',
])

function roleLabel(node: AxNode): string {
  const role = axString(node.role)
  return role || 'generic'
}

function nodeLabel(node: AxNode): string {
  const name = axString(node.name)
  const value = axString(node.value)
  const role = roleLabel(node)
  if (name && value && value !== name) {
    return `${role}: ${name} = ${value}`
  }
  if (name) {
    if (PRUNE_ROLES.has(role)) return name
    return `${role}: ${name}`
  }
  return role
}

/**
 * Walk the (non-ignored) AX forest into an indented text tree plus a ref list,
 * de-duplicating refs by role|name so interaction targets stay unambiguous.
 */
export function buildSnapshot(tree: AxNode[]): Snapshot {
  const byId = new Map<string, AxNode>()
  for (const node of tree) byId.set(node.nodeId, node)

  const childSet = new Set<string>()
  for (const node of tree) {
    for (const c of node.childIds ?? []) childSet.add(c)
  }
  const tops = tree.filter(n => !childSet.has(n.nodeId) && !n.ignored)

  const lines: string[] = []
  const refs: SnapshotRef[] = []
  const seen = new Set<string>()

  const walk = (node: AxNode, depth: number): void => {
    const ignored = Boolean(node.ignored)
    if (!ignored) {
      const role = roleLabel(node)
      const name = axString(node.name) || undefined
      const backendNodeId = node.backendDOMNodeId
      const key = `${role}|${name || ''}`
      if (backendNodeId !== undefined && backendNodeId !== null && !PRUNE_ROLES.has(role) && !seen.has(key)) {
        seen.add(key)
        refs.push({ backendNodeId, role, name })
      }
      const indent = '  '.repeat(depth)
      const label = nodeLabel(node)
      if (label) lines.push(`${indent}${label}`)
    }
    // Ignored nodes are AX wrappers (e.g. "none"-role containers): they emit no
    // line, but their subtrees hold the real content, so keep walking them at
    // the same depth.
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child) walk(child, ignored ? depth : depth + 1)
    }
  }

  for (const top of tops) walk(top, 0)
  return { content: lines.join('\n'), refs }
}

async function activePageTargetId(): Promise<string> {
  const instance = await getChrome()
  const res = await fetch(`http://127.0.0.1:${instance.port}/json/list`)
  const list = (await res.json()) as Array<{ id: string; type: string }>
  const pages = list.filter(t => t.type === 'page')
  if (pages.length === 0) {
    throw new Error('dsh-ego-browser: no page target to snapshot')
  }
  // Last page target matches the harness active-tab fallback.
  return pages[pages.length - 1]!.id
}

/**
 * Produce the harness-shaped `{ content, refs }` snapshot for the active page.
 * `maxResultLength` bounds the returned text (used by task-space probes).
 */
export async function egoSnapshot(options: { scope?: 'only_within_viewport' | 'full_page'; maxResultLength?: number } = {}): Promise<Snapshot> {
  const targetId = await activePageTargetId()
  const sessionId = await attachSession(targetId)
  const result = await sendRaw('Accessibility.getFullAXTree', {}, sessionId)
  const nodes = (result.nodes as AxNode[] | undefined) ?? []
  const snapshot = buildSnapshot(nodes)
  const max = options.maxResultLength
  if (max && max > 0 && snapshot.content.length > max) {
    snapshot.content = `${snapshot.content.slice(0, max)}…`
  }
  return snapshot
}
