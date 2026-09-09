/**
 * WebSocket CDP transport that stands in for the closed-source `globalThis.ego`
 * bridge the harness expects. Implementing the exact interface surface the
 * harness reads (see package/ego-browser src/browser-runtime.ts + driver/nav.ts):
 *
 *   - `sendCDPMessage(payload: string)`            → forward over the browser WS
 *   - `onCDPMessage` (setter)                      → raw WS message string → harness
 *   - `onSendCDPMessageError(message, error_code)` → send-level failure signaling
 *   - `listTabs() → { tabs: [{ targetId, active }]}`   → /json/list page targets
 *   - `createTab(url) → { targetId }`              → Target.createTarget
 *
 * A single browser-level WS connection is reused for every command (with or
 * without a `sessionId`), which Chrome's flat protocol supports: Target sessions
 * attached with `flatten: true` ride the same socket. The harness owns session
 * attach/reattach, the 15s timeout, SESSION_LOST recovery, the 10k event buffer
 * and dialog tracking; this bridge only forwards messages and enumerates tabs.
 */

import type { PageTarget } from './chrome.ts'
import { getChrome, jsonVersion, pageTargets } from './chrome.ts'

export interface EgoBridge {
  sendCDPMessage(payload: string): void
  onCDPMessage: ((message: string) => void) | null
  onSendCDPMessageError: ((message: string, error_code?: string) => void) | null
  listTabs(): Promise<{ tabs: Array<{ targetId: string; title?: string; url?: string; active?: boolean; index?: number }> }>
  createTab(url?: string): Promise<{ targetId: string }>
  snapshot(options?: unknown): Promise<{ content: string; refs: unknown[] }>
  /* v2 task-space host surface: one synthetic agent-owned space over the
   * local Chrome, so the ported harness's task-space helpers (taskSpace(),
   * newTaskSpace(), claimTaskSpace(), …) resolve without an ego-lite host. */
  listTaskSpaces?(): Promise<{ taskSpaces: Array<Record<string, unknown>> }>
  listProfiles?(): Promise<{ profiles: Array<{ id: string; name: string; isDefault: boolean }> }>
  createTaskSpace?(name: string): Promise<Record<string, unknown>>
  useTaskSpace?(id: number): Promise<unknown>
  claimTaskSpace?(id: number, name: string): Promise<Record<string, unknown>>
  completeTaskSpace?(): Promise<unknown>
  closeTaskSpace?(): Promise<unknown>
  handOffTaskSpace?(): Promise<unknown>
  takeOverTaskSpace?(): Promise<unknown>
  animationHighlightMouseToPosition?(x: number, y: number): void
  setAgentTaskState?(state: string): void
  isAlive(): boolean
  dispose(): Promise<void>
}

let ws: WebSocket | null = null
let wsPromise: Promise<WebSocket> | null = null
let messageHandler: ((message: string) => void) | null = null
/** Monotonic small-int CDP id (Chrome rejects ids outside a small int range). */
let nextCdpId = 1
let errorHandler: ((message: string, error_code?: string) => void) | null = null
let disposed = false
/** CDP id → pending request, resolved by the single onmessage dispatcher. */
const pendingResponses = new Map<
  number,
  { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>()

/**
 * Build (or reuse) the single browser WebSocket. On any close/error the socket is
 * dropped and the send-failure handler is notified so pending harness requests are
 * rejected by `handleSendError` rather than hanging until the 15s timeout.
 */
async function connect(): Promise<WebSocket> {
  if (ws && ws.readyState === WebSocket.OPEN) return ws
  if (wsPromise) return wsPromise
  wsPromise = (async () => {
    const instance = await getChrome()
    const info = await jsonVersion(instance)
    const url = info.webSocketDebuggerUrl
    if (!url) throw new Error('dsh-ego-browser: /json/version returned no webSocketDebuggerUrl')
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dsh-ego-browser: WS open timeout')), 8000)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('dsh-ego-browser: WS error during connect'))
      }
    })
    // Single event entry point: responses (with `id`) resolve pending requests
    // (our own bridge calls, e.g. snapshot attach); every other message — the
    // harness's own command responses (id present but never registered here)
    // and events — goes to the harness via onCDPMessage.
    socket.onmessage = (event) => {
      let data: Record<string, unknown>
      try {
        data = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (typeof data.id === 'number') {
        const entry = pendingResponses.get(data.id)
        if (entry) {
          pendingResponses.delete(data.id)
          clearTimeout(entry.timer)
          if (data.error) {
            entry.reject(new Error((data.error as { message?: string }).message || 'CDP request failed'))
          } else {
            entry.resolve((data.result ?? {}) as Record<string, unknown>)
          }
          return
        }
        // Response to a request the harness sent via sendCDPMessage (never
        // registered in our map) — fall through to the harness handler.
      }
      if (messageHandler) messageHandler(String(event.data))
    }
    socket.onclose = () => {
      ws = null
      rejectAllPending(new Error('WebSocket CDP connection closed'))
      if (errorHandler) errorHandler('WebSocket CDP connection closed', 'EGO_CDP_CHANNEL_UNAVAILABLE')
    }
    socket.onerror = () => {
      // onclose follows; drop and notify once there (avoid double-fire by only
      // notifying here if the socket is still ours and open).
    }
    ws = socket
    return socket
  })().finally(() => {
    wsPromise = null
  })
  return wsPromise
}

/**
 * Low-level CDP request over the shared browser WS, used by the snapshot
 * implementation (and available for future bridge internals). Resolves with the
 * CDP `result` object, or rejects on error/timeout.
 */
export async function sendRaw(
  method: string,
  params: Record<string, unknown> = {},
  sessionId?: string,
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const socket = await ensureOpenSocket()
  const id = nextCdpId++
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(id)
      reject(new Error(`dsh-ego-browser: CDP ${method} timeout`))
    }, timeoutMs)
    pendingResponses.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}

/**
 * Attach to a target and return its flattened session id (mirrors what the
 * harness does in `ensureSession`, but bridged locally so snapshot is
 * self-contained).
 */
export async function attachSession(targetId: string): Promise<string> {
  const result = await sendRaw('Target.attachToTarget', { targetId, flatten: true })
  const sessionId = result.sessionId as string
  if (!sessionId) throw new Error('dsh-ego-browser: Target.attachToTarget returned no sessionId')
  return sessionId
}

async function ensureOpenSocket(): Promise<WebSocket> {
  if (disposed) throw new Error('dsh-ego-browser: bridge is disposed')
  const socket = await connect()
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error('dsh-ego-browser: CDP WebSocket not open')
  }
  return socket
}

function sendCDPMessage(payload: string): void {
  // Fire-and-forget: the harness resolves via onCDPMessage(id) or rejects via
  // onSendCDPMessageError. A send-level failure must surface immediately, not wait
  // for the 15s harness timeout.
  void (async () => {
    try {
      const socket = await ensureOpenSocket()
      socket.send(payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (errorHandler) errorHandler(message, 'EGO_CDP_SEND_FAILED')
    }
  })()
}

export async function listTabs(): Promise<{
  tabs: Array<{ targetId: string; title?: string; url?: string; active?: boolean; index?: number }>
}> {
  const instance = await getChrome()
  const targets = (await pageTargets(instance)).filter((t: PageTarget) => t.type === 'page')
  // active: Chrome /json/list does not report "active"; the harness falls back to
  // `tabs.find(active) || tabs.at(-1)`, so marking none active keeps the last tab
  // as the effective selection.
  return {
    tabs: targets.map((t: PageTarget, i: number) => ({
      targetId: t.id,
      title: t.title || '',
      url: t.url || '',
      active: false,
      index: i,
    })),
  }
}

export async function createTab(url = 'about:blank'): Promise<{ targetId: string }> {
  const socket = await ensureOpenSocket()
  const response = await new Promise<{ targetId?: string } | null>((resolve, reject) => {
    const id = nextCdpId++
    const timer = setTimeout(() => {
      pendingResponses.delete(id)
      reject(new Error('dsh-ego-browser: Target.createTarget timeout'))
    }, 8000)
    pendingResponses.set(id, {
      resolve: result => resolve((result as { targetId?: string }) ?? null),
      reject,
      timer,
    })
    socket.send(JSON.stringify({ id, method: 'Target.createTarget', params: { url } }))
  })
  if (!response?.targetId) {
    throw new Error('dsh-ego-browser: Target.createTarget returned no targetId')
  }
  return { targetId: response.targetId }
}

function isAlive(): boolean {
  return !disposed && Boolean(ws && ws.readyState === WebSocket.OPEN)
}

async function dispose(): Promise<void> {
  disposed = true
  messageHandler = null
  errorHandler = null
  if (ws) {
    try {
      ws.close()
    } catch {
      // already closed
    }
    ws = null
  }
  rejectAllPending(new Error('dsh-ego-browser: bridge disposed'))
}

/** Reject every in-flight request (used on connection loss and dispose). */
function rejectAllPending(error: Error): void {
  for (const entry of pendingResponses.values()) {
    clearTimeout(entry.timer)
    entry.reject(error)
  }
  pendingResponses.clear()
}

export interface InstallEgoBridgeOptions {
  /** `ego.snapshot` implementation (built by bridge/snapshot.ts). */
  snapshot: (options?: Record<string, unknown>) => Promise<{ content: string; refs: unknown[] }>
  /** Chrome teardown (bridge/chrome.ts disposeChrome). */
  disposeChrome: () => Promise<void>
}

/**
 * Task-space shim: the v2 harness drives browsing through a task-space object
 * model (helpers.taskSpace() → Page objects). There is no ego-lite host here,
 * so the bridge presents one synthetic agent-owned space backed by the single
 * local Chrome instance. All state-changing host calls are idempotent no-ops.
 */
function syntheticTaskSpace(): Record<string, unknown> {
  const name = process.env.EGO_BROWSER_NAME || 'default'
  return { taskId: 1, id: 1, name, ownership: 'agent', recentTabTitles: [] }
}

function bridgeTaskSpaceSurface(): Pick<
  EgoBridge,
  | 'listTaskSpaces'
  | 'listProfiles'
  | 'createTaskSpace'
  | 'useTaskSpace'
  | 'claimTaskSpace'
  | 'completeTaskSpace'
  | 'closeTaskSpace'
  | 'handOffTaskSpace'
  | 'takeOverTaskSpace'
  | 'animationHighlightMouseToPosition'
  | 'setAgentTaskState'
> {
  return {
    listTaskSpaces: async () => ({ taskSpaces: [syntheticTaskSpace()] }),
    listProfiles: async () => ({
      profiles: [{ id: 'default', name: 'default', isDefault: true }],
    }),
    createTaskSpace: async (name: string) => ({
      ...syntheticTaskSpace(),
      name: name || (syntheticTaskSpace().name as string),
    }),
    useTaskSpace: async () => undefined,
    claimTaskSpace: async () => syntheticTaskSpace(),
    completeTaskSpace: async () => ({ done: true }),
    closeTaskSpace: async () => undefined,
    handOffTaskSpace: async () => ({ done: true }),
    takeOverTaskSpace: async () => syntheticTaskSpace(),
    animationHighlightMouseToPosition: () => undefined,
    setAgentTaskState: () => undefined,
  }
}

/**
 * Install the CDP bridge as `globalThis.ego`. Returns a disposer that restores
 * the previous `globalThis.ego` (if any) and tears down the bridge + Chrome.
 */
export function installEgoBridge(options: InstallEgoBridgeOptions): () => void {
  const previous = (globalThis as Record<string, unknown>).ego
  const bridge: EgoBridge = {
    sendCDPMessage,
    onCDPMessage: null,
    onSendCDPMessageError: null,
    listTabs,
    createTab,
    ...bridgeTaskSpaceSurface(),
    snapshot: (opts?: Record<string, unknown>) => options.snapshot(opts).then(s => ({ ...s, refs: s.refs } as never)),
    isAlive,
    dispose: () => options.disposeChrome().then(() => dispose()),
  }
  Object.defineProperty(bridge, 'onCDPMessage', {
    get: () => messageHandler,
    set: (fn: ((message: string) => void) | null) => {
      messageHandler = fn
    },
  })
  Object.defineProperty(bridge, 'onSendCDPMessageError', {
    get: () => errorHandler,
    set: (fn: ((message: string, error_code?: string) => void) | null) => {
      errorHandler = fn
    },
  })
  ;(globalThis as Record<string, unknown>).ego = bridge
  return () => {
    void (async () => {
      await options.disposeChrome()
      await dispose()
    })()
    if (previous === undefined) {
      delete (globalThis as Record<string, unknown>).ego
    } else {
      ;(globalThis as Record<string, unknown>).ego = previous
    }
  }
}
