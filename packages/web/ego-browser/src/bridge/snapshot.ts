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

export interface SnapshotOptions {
  scope?: 'only_within_viewport' | 'full_page'
  maxResultLength?: number
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

/**
 * `DOMSnapshot` tables, declared as possibly-missing entries because this reads
 * a CDP payload: an index outside a table's range yields `undefined` at runtime
 * whatever the declared element type promises.
 */
interface SnapshotNodeTable {
  backendNodeId: Array<number | undefined>
}

/**
 * `nodeIndex[i]` points into the node table and `bounds[i]` is that node's
 * `[x, y, width, height]` in document coordinates.
 */
interface SnapshotLayoutTable {
  nodeIndex: Array<number | undefined>
  bounds: Array<[number, number, number, number] | undefined>
}

interface SnapshotDocument {
  nodes?: SnapshotNodeTable
  layout?: SnapshotLayoutTable
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
 *
 * With `visibleBackendNodeIds`, only nodes whose subtree reaches the viewport
 * survive: a node stays when it has such a descendant even if its own box is
 * off-screen (a tall container, or an unmeasured wrapper), but it becomes a
 * `@N` ref only when its own box intersects. The set comes from layout boxes,
 * which cover text nodes as well as elements, so a node missing from it has no
 * measurable box rather than a known off-screen one.
 */
export function buildSnapshot(
  tree: AxNode[],
  visibleBackendNodeIds?: ReadonlySet<number>,
): Snapshot {
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

  const hasVisibleBox = (node: AxNode): boolean => {
    const id = node.backendDOMNodeId
    return id !== undefined && Boolean(visibleBackendNodeIds?.has(id))
  }
  // Memoized so a deep tree costs one pass, not one per ancestor level.
  const subtreeVisibility = new Map<string, boolean>()
  const reachesViewport = (node: AxNode): boolean => {
    const cached = subtreeVisibility.get(node.nodeId)
    if (cached !== undefined) return cached
    let visible = hasVisibleBox(node)
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child && reachesViewport(child)) visible = true
    }
    subtreeVisibility.set(node.nodeId, visible)
    return visible
  }
  const visible = (node: AxNode): boolean =>
    visibleBackendNodeIds === undefined || reachesViewport(node)

  const walk = (node: AxNode, depth: number): void => {
    const ignored = Boolean(node.ignored)
    if (!ignored && visible(node)) {
      const role = roleLabel(node)
      const name = axString(node.name) || undefined
      const backendNodeId = node.backendDOMNodeId
      const key = `${role}|${name || ''}`
      const refEligible =
        visibleBackendNodeIds === undefined || hasVisibleBox(node)
      if (backendNodeId !== undefined && backendNodeId !== null && refEligible && !PRUNE_ROLES.has(role) && !seen.has(key)) {
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

/**
 * Backend node ids whose own layout box intersects the current viewport.
 *
 * One `DOMSnapshot.captureSnapshot` covers the whole tree, where per-element
 * `DOM.getBoxModel` would cost a round trip each. `Page.getLayoutMetrics`
 * supplies the viewport rectangle: its `pageX`/`pageY` are the scroll offsets
 * that place that rectangle in the document coordinates the bounds use.
 */
async function viewportBackendNodeIds(sessionId: string): Promise<Set<number>> {
  const [metrics, snapshot] = await Promise.all([
    sendRaw('Page.getLayoutMetrics', {}, sessionId),
    sendRaw(
      'DOMSnapshot.captureSnapshot',
      { computedStyles: [], includePaintOrder: false, includeDOMRects: false },
      sessionId,
    ),
  ])
  const layoutViewport = (metrics.cssLayoutViewport ?? {}) as {
    pageX?: number
    pageY?: number
    clientWidth?: number
    clientHeight?: number
  }
  const left = layoutViewport.pageX ?? 0
  const top = layoutViewport.pageY ?? 0
  const right = left + (layoutViewport.clientWidth ?? 0)
  const bottom = top + (layoutViewport.clientHeight ?? 0)

  const document = ((snapshot.documents ?? []) as SnapshotDocument[])[0]
  const layout = document?.layout
  const nodes = document?.nodes
  const ids = new Set<number>()
  if (!layout || !nodes) return ids
  const { nodeIndex, bounds } = layout
  for (let i = 0; i < nodeIndex.length; i += 1) {
    const index = nodeIndex[i]
    const box = bounds[i]
    if (index === undefined || box === undefined) continue
    const [x, y, width, height] = box
    if (![x, y, width, height].every(Number.isFinite)) continue
    const backendNodeId = nodes.backendNodeId[index]
    if (backendNodeId === undefined) continue
    const intersects =
      x < right && x + width > left && y < bottom && y + height > top
    if (intersects) ids.add(backendNodeId)
  }
  return ids
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
 *
 * An absent `scope` means the whole page: `Page.snapshot` applies its own
 * viewport default (public-api-schema), while callers that pass no options —
 * ref refresh, the user-control probe — need every `@N` to stay resolvable.
 */
export async function egoSnapshot(options: SnapshotOptions = {}): Promise<Snapshot> {
  const targetId = await activePageTargetId()
  const sessionId = await attachSession(targetId)
  const result = await sendRaw('Accessibility.getFullAXTree', {}, sessionId)
  const nodes = (result.nodes as AxNode[] | undefined) ?? []
  const visible =
    options.scope === 'only_within_viewport'
      ? await viewportBackendNodeIds(sessionId)
      : undefined
  const snapshot = buildSnapshot(nodes, visible)
  const max = options.maxResultLength
  if (max && max > 0 && snapshot.content.length > max) {
    snapshot.content = `${snapshot.content.slice(0, max)}…`
  }
  return snapshot
}
