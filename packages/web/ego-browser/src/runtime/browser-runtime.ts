// @ts-nocheck — ported from ego-browser v2.1.0-beta.2 (strict:false); vendor exemption, not strict-checked.
import { state } from './state.ts'
import {
  buildEgoError,
  invokeEgo,
  isEgoUserControlError,
} from './ego-errors.ts'

const RESPONSE_TIMEOUT_MS = 15000
const SESSION_TTL_MS = 2000
// Upper bound for buffered CDP events. The runtime can be long-lived (installEgoSdk
// inside the browser); without a cap, undrained events grow without bound.
const MAX_BUFFERED_EVENTS = 10000
const SESSION_LOST =
  /Session (?:with given id )?not found|Target closed|No session/i
const FRAME_LIFECYCLE_LOST =
  /Frame with the given frameId is not found|No frame with given id found|No target with given id/i
const BROWSER_LEVEL = method =>
  method.startsWith('Target.') || method.startsWith('Browser.')
const OOPIF_AUTO_ATTACH_PARAMS = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  // Ego Lite can pause an excluded dedicated worker without attaching it,
  // leaving no session through which the harness can resume that worker.
  filter: [
    { type: 'iframe', exclude: false },
    { type: 'worker', exclude: false },
    { exclude: true },
  ],
}
// A modal JavaScript dialog stalls every command the renderer has to answer,
// including Page.getFrameTree, Page.captureScreenshot, DOM.*, Accessibility.*,
// and even Page.enable. Only methods the browser process answers on its own
// keep working, so allow those and fail every other command fast instead of
// letting it run into the transport timeout.
const DIALOG_SAFE_METHOD = method =>
  BROWSER_LEVEL(method) ||
  method === 'Page.handleJavaScriptDialog' ||
  method === 'Page.setDownloadBehavior'
let nextMessageId = 1
const pending = new Map()
const browserEvents = []
const browserEventSubscribers = new Set<(event: any) => void>()
const pageEventSubscribers = new Map<string, Set<(event: any) => void>>()
const targetStates = new Map()
const sessionTargets = new Map()
const childTargets = new Map<string, Set<string>>()
const parentTargets = new Map<string, string>()
let defaultTargetId = null
let userControlProbeState: 'idle' | 'probing' | 'stopped' = 'idle'
let userControlStopError: (Error & { error_code?: string }) | null = null
let userControlProbeGeneration = 0
type EgoCdpCallbackRuntime = {
  onCDPMessage?: (payload: string) => void
  onSendCDPMessageError?: (message: unknown, errorCode?: string) => void
}
let callbackRuntime: EgoCdpCallbackRuntime | undefined

/**
 * A CDP command whose response did not arrive within its deadline. The pending
 * entry is dropped before the error is reported, so a later call of the same
 * method starts a fresh request.
 */
export class CdpRequestTimeoutError extends Error {
  /** Stable error code carried across the native bridge. */
  readonly code = 'EGO_CDP_REQUEST_TIMEOUT'
  /** CDP method whose response timed out. */
  readonly method: string
  /** Deadline applied to the command, in milliseconds. */
  readonly timeoutMs: number
  /** Attached target session the command was addressed to, when known. */
  readonly sessionId?: string

  constructor(method: string, timeoutMs: number, sessionId?: string) {
    super(`CDP request timed out: ${method}`)
    this.name = 'CdpRequestTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
    this.sessionId = sessionId
  }
}

/**
 * Whether a rejection is a CDP deadline failure. The error code is also
 * matched, so errors from another realm or a serialized boundary classify.
 * @param error - the rejection or thrown value to classify.
 * @returns true when the value is a {@link CdpRequestTimeoutError}.
 */
export function isCdpRequestTimeoutError(
  error: unknown,
): error is CdpRequestTimeoutError {
  return (
    error instanceof CdpRequestTimeoutError ||
    (Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'EGO_CDP_REQUEST_TIMEOUT')
  )
}

/** A CDP command error carrying the session it was addressed to. */
export type CdpCommandError = Error & { sessionId?: string }

/**
 * Whether a CDP failure means the session that issued the command no longer
 * exists, for example after the target detached or closed.
 * @param error - the rejection or thrown value to classify.
 * @returns true when the error message matches a lost-session signature.
 */
export function isSessionLostError(error: unknown): error is CdpCommandError {
  return error instanceof Error && SESSION_LOST.test(error.message)
}

/**
 * Whether a CDP failure means a frame or iframe target vanished between
 * enumeration and use.
 * @param error - the rejection or thrown value to classify.
 * @returns true when the error message matches a lost-frame signature.
 */
export function isFrameLifecycleError(
  error: unknown,
): error is CdpCommandError {
  return error instanceof Error && FRAME_LIFECYCLE_LOST.test(error.message)
}

/**
 * A frame or its session disappeared mid-operation. Callers that have not yet
 * dispatched input may rediscover frame sessions and retry.
 * @param error - the rejection or thrown value to classify.
 * @returns true when the failure is a lost session or a lost frame.
 */
export function isRetryableFrameLifecycleError(
  error: unknown,
): error is CdpCommandError {
  return isSessionLostError(error) || isFrameLifecycleError(error)
}

/**
 * Signals that a modal JavaScript dialog prevented a CDP command from
 * completing. The dialog remains open; Page-level code decides whether to
 * expose it in an action receipt or surface this error to the caller.
 */
export class PageDialogOpenedError extends Error {
  /** Stable error code carried across the native bridge. */
  readonly code = 'EGO_PAGE_DIALOG_OPENED'
  /** CDP method the open dialog prevented from completing. */
  readonly method: string
  /** Session whose Page owns the open dialog. */
  readonly sessionId: string
  /** Copy of the `Page.javascriptDialogOpening` params for the open dialog. */
  readonly dialog: Record<string, unknown>

  constructor(
    method: string,
    sessionId: string,
    dialog: Record<string, unknown>,
    { alreadyOpen = false }: { alreadyOpen?: boolean } = {},
  ) {
    const kind =
      typeof dialog.type === 'string' && dialog.type
        ? `JavaScript ${dialog.type} dialog`
        : 'JavaScript dialog'
    const text =
      typeof dialog.message === 'string' && dialog.message
        ? ` (${JSON.stringify(dialog.message)})`
        : ''
    const situation = alreadyOpen
      ? `${method} cannot run while a ${kind}${text} is open`
      : `a ${kind}${text} opened while ${method} was running`
    super(
      `${situation}; handle it with page.acceptDialog() or page.dismissDialog() before continuing`,
    )
    this.name = 'PageDialogOpenedError'
    this.method = method
    this.sessionId = sessionId
    this.dialog = { ...dialog }
  }
}

/**
 * Whether a rejection is an open-dialog failure. The error code is also
 * matched, so errors from another realm or a serialized boundary classify.
 * @param error - the rejection or thrown value to classify.
 * @returns true when the value is a {@link PageDialogOpenedError}.
 */
export function isPageDialogOpenedError(
  error: unknown,
): error is PageDialogOpenedError {
  return (
    error instanceof PageDialogOpenedError ||
    (Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'EGO_PAGE_DIALOG_OPENED')
  )
}

/**
 * Params of one `Page.fileChooserOpened` event, narrowed to the fields the
 * interception needs: the chooser's node and, when reported, its frame and mode.
 */
export type FileChooserOpenedEvent = {
  backendNodeId: number
  frameId?: string
  mode?: 'selectSingle' | 'selectMultiple'
}

/**
 * Handle to one armed file-chooser interception, owned by the caller that
 * prepared it. `ready` resolves once Chromium suppresses the native picker;
 * `event` resolves with the next opened chooser; `dispose` disarms the
 * interception and rejects a still-pending `event` with its reason.
 */
export type FileChooserInterception = {
  ready: Promise<void>
  event: Promise<FileChooserOpenedEvent>
  peek(): FileChooserOpenedEvent | undefined
  dispose(reason?: Error): Promise<void>
}

function targetState(targetId) {
  let target = targetStates.get(targetId)
  if (!target) {
    target = {
      sessionId: null,
      sessionAt: 0,
      sessionInflight: null,
      events: [],
      pageEventsEnabled: false,
      networkDomainEnabled: false,
      networkEnableInflight: null,
      autoAttachEnabled: false,
      autoAttachInflight: null,
      inflightNetworkRequests: new Map<
        string,
        {
          requestId: string
          frameId?: string
          loaderId?: string
          type?: string
        }
      >(),
      ignoredFaviconRequestIds: new Set<string>(),
      lastNetworkActivityAt: state.now(),
      pendingDialog: null,
      fileChooserInterception: null,
    }
    targetStates.set(targetId, target)
  }
  return target
}

function registerSession(targetId, sessionId) {
  const target = targetState(targetId)
  if (target.sessionId === sessionId) {
    target.sessionAt = Date.now()
    sessionTargets.set(sessionId, targetId)
    return
  }
  if (target.sessionId && target.sessionId !== sessionId) {
    sessionTargets.delete(target.sessionId)
  }
  target.sessionId = sessionId
  target.sessionAt = Date.now()
  target.pageEventsEnabled = false
  target.networkDomainEnabled = false
  target.networkEnableInflight = null
  target.autoAttachEnabled = false
  target.autoAttachInflight = null
  target.inflightNetworkRequests.clear()
  target.ignoredFaviconRequestIds.clear()
  target.lastNetworkActivityAt = state.now()
  target.pendingDialog = null
  sessionTargets.set(sessionId, targetId)
}

function registerTargetParent(targetId: string, parentTargetId: string) {
  const previousParent = parentTargets.get(targetId)
  if (previousParent === parentTargetId) {
    // A renderer swap can reattach the same frame target after a new document
    // request has already started in the parent session.
    migrateFrameRequests(targetId, parentTargetId)
    return
  }
  if (previousParent) {
    const previousChildren = childTargets.get(previousParent)
    previousChildren?.delete(targetId)
    if (previousChildren?.size === 0) childTargets.delete(previousParent)
  }
  parentTargets.set(targetId, parentTargetId)
  let children = childTargets.get(parentTargetId)
  if (!children) {
    children = new Set()
    childTargets.set(parentTargetId, children)
  }
  children.add(targetId)
  migrateFrameRequests(targetId, parentTargetId)
}

function migrateFrameRequests(targetId: string, parentTargetId: string): void {
  const destination = targetState(targetId)
  const rootTargetId = pageRootTargetId(parentTargetId)
  for (const sourceTargetId of pageTreeTargetIds(rootTargetId)) {
    if (sourceTargetId === targetId) continue
    const source = targetStates.get(sourceTargetId)
    if (!source) continue
    for (const [requestId, request] of source.inflightNetworkRequests) {
      if (request.frameId !== targetId) continue
      source.inflightNetworkRequests.delete(requestId)
      destination.inflightNetworkRequests.set(requestId, request)
      destination.lastNetworkActivityAt = Math.max(
        destination.lastNetworkActivityAt,
        source.lastNetworkActivityAt,
      )
    }
  }
}

function pageRootTargetId(targetId: string): string {
  let current = targetId
  const visited = new Set<string>()
  while (parentTargets.has(current) && !visited.has(current)) {
    visited.add(current)
    current = parentTargets.get(current)!
  }
  return current
}

function pageTreeTargetIds(rootTargetId: string): string[] {
  const result: string[] = []
  const visit = (targetId: string) => {
    result.push(targetId)
    for (const childTargetId of childTargets.get(targetId) || []) {
      visit(childTargetId)
    }
  }
  visit(rootTargetId)
  return result
}

function unregisterTargetParent(targetId: string) {
  const parentTargetId = parentTargets.get(targetId)
  if (!parentTargetId) return
  parentTargets.delete(targetId)
  const siblings = childTargets.get(parentTargetId)
  siblings?.delete(targetId)
  if (siblings?.size === 0) childTargets.delete(parentTargetId)
}

function clearTargetSession(targetId, { remove = false } = {}) {
  const target = targetStates.get(targetId)
  if (!target) return
  rejectFileChooserInterception(
    target,
    new Error('file chooser session was detached'),
  )
  if (target.sessionId) {
    sessionTargets.delete(target.sessionId)
  }
  if (remove) {
    targetStates.delete(targetId)
    if (defaultTargetId === targetId) defaultTargetId = null
    return
  }
  target.sessionId = null
  target.sessionAt = 0
  target.sessionInflight = null
  target.events.length = 0
  target.pageEventsEnabled = false
  target.networkDomainEnabled = false
  target.networkEnableInflight = null
  target.autoAttachEnabled = false
  target.autoAttachInflight = null
  target.inflightNetworkRequests.clear()
  target.ignoredFaviconRequestIds.clear()
  target.lastNetworkActivityAt = state.now()
  target.pendingDialog = null
  target.fileChooserInterception = null
}

function clearTargetSessionTree(targetId: string, { remove = false } = {}) {
  for (const childTargetId of [...(childTargets.get(targetId) || [])]) {
    clearTargetSessionTree(childTargetId, { remove: true })
  }
  clearTargetSession(targetId, { remove })
  if (remove) {
    childTargets.delete(targetId)
    unregisterTargetParent(targetId)
  }
}

function capEvents(events) {
  if (events.length > MAX_BUFFERED_EVENTS) {
    events.splice(0, events.length - MAX_BUFFERED_EVENTS)
  }
}

/**
 * Whether this module runs where the native bridge exposes
 * `ego.sendCDPMessage`.
 * @returns true when the embedded browser bridge is available.
 */
export function isBrowserRuntime(): boolean {
  return Boolean(
    globalThis.ego && typeof globalThis.ego.sendCDPMessage === 'function',
  )
}

/**
 * The native bridge handle for the current runtime.
 * @returns the `globalThis.ego` object that exposes `sendCDPMessage` and the task-space calls.
 * @throws when no embedded browser runtime is installed.
 */
export function browserEgo(): any {
  if (!globalThis.ego) {
    throw new Error('browser runtime is not available')
  }
  return globalThis.ego
}

/** Keep exceptions from crossing the native-to-JavaScript callback boundary. */
function guardNativeCallback(label: string, callback: () => void): void {
  try {
    callback()
  } catch (error) {
    try {
      console.error(`[ego-browser] ${label} failed:`, error)
    } catch {
      // Error reporting must not re-enter the native callback failure.
    }
  }
}

function dispatchCdpMessage(payload: string): void {
  guardNativeCallback('onCDPMessage', () => handleMessage(payload))
}

function dispatchCdpSendError(message: unknown, errorCode?: string): void {
  guardNativeCallback('onSendCDPMessageError', () =>
    handleSendError(message, errorCode),
  )
}

function bindRuntimeCallbacks(runtime: EgoCdpCallbackRuntime): void {
  if (callbackRuntime && callbackRuntime !== runtime) {
    releaseRuntimeCallbacks(callbackRuntime)
  }
  runtime.onCDPMessage = dispatchCdpMessage
  runtime.onSendCDPMessageError = dispatchCdpSendError
  callbackRuntime = runtime
}

/**
 * Release only the CDP callbacks this runtime installed, leaving callbacks
 * owned by another embedder in place.
 * @param runtime - the runtime to unbind; defaults to the runtime bound by the last CDP request.
 */
export function releaseRuntimeCallbacks(
  runtime: EgoCdpCallbackRuntime | undefined = callbackRuntime,
): void {
  if (!runtime) return
  if (runtime.onCDPMessage === dispatchCdpMessage) {
    runtime.onCDPMessage = undefined
  }
  if (runtime.onSendCDPMessageError === dispatchCdpSendError) {
    runtime.onSendCDPMessageError = undefined
  }
  if (callbackRuntime === runtime) callbackRuntime = undefined
}

/**
 * Stop all runtime work before an embedded Node context is discarded: unbind the
 * callbacks, fail every pending request, and clear subscribers and sessions.
 * @param runtime - the runtime to unbind; defaults to the runtime bound by the last CDP request.
 */
export function disposeBrowserRuntime(
  runtime: EgoCdpCallbackRuntime | undefined = callbackRuntime,
): void {
  releaseRuntimeCallbacks(runtime)
  rejectAllPending(new Error('ego-browser runtime was disposed'))
  browserEventSubscribers.clear()
  pageEventSubscribers.clear()
  invalidateSession()
}

/**
 * Subscribe to Target/Browser events without consuming the legacy event queue.
 * @param listener - called for every browser-level CDP event.
 * @returns a disposer that removes the listener.
 */
export function subscribeBrowserEvents(
  listener: (event: any) => void,
): () => void {
  if (typeof listener !== 'function') {
    throw new TypeError('browser event listener must be a function')
  }
  browserEventSubscribers.add(listener)
  return () => browserEventSubscribers.delete(listener)
}

/**
 * Subscribe to session events for one browser target.
 * @param targetId - target whose session events to observe.
 * @param listener - called for every CDP event routed to that target.
 * @returns a disposer that removes the listener and drops the target's subscriber set once it is empty.
 */
export function subscribePageEvents(
  targetId: string,
  listener: (event: any) => void,
): () => void {
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new TypeError('page event subscription requires a targetId')
  }
  if (typeof listener !== 'function') {
    throw new TypeError('page event listener must be a function')
  }
  let listeners = pageEventSubscribers.get(targetId)
  if (!listeners) {
    listeners = new Set()
    pageEventSubscribers.set(targetId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners?.delete(listener)
    if (listeners?.size === 0) pageEventSubscribers.delete(targetId)
  }
}

function rawCdp(
  method,
  params: any = {},
  sessionId = undefined,
  timeoutMs = RESPONSE_TIMEOUT_MS,
) {
  const runtime = browserEgo()
  bindRuntimeCallbacks(runtime)
  const id = nextMessageId++
  const payload = JSON.stringify({
    id,
    method,
    params,
    ...(sessionId ? { sessionId } : {}),
  })
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      // Commands sent outside browserCdp() skip its dialog check. Name the
      // dialog if one is what stalled this command.
      const dialog =
        sessionId && !DIALOG_SAFE_METHOD(method)
          ? pendingDialog(sessionId)
          : null
      reject(
        dialog
          ? new PageDialogOpenedError(method, sessionId, dialog, {
            alreadyOpen: true,
          })
          : new CdpRequestTimeoutError(method, timeoutMs, sessionId),
      )
    }, timeoutMs)
    pending.set(id, {
      method,
      sessionId,
      resolve: (response) => {
        clearTimeout(timer)
        resolve(response)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    try {
      runtime.sendCDPMessage(payload)
    } catch (error) {
      clearTimeout(timer)
      pending.delete(id)
      reject(buildEgoError(error))
    }
  })
}

/**
 * Send one CDP command, attaching the current Page session unless the caller
 * names one or the browser process answers the method on its own. A lost
 * session is re-established once and the command replayed; a dialog-blocked
 * command fails fast with {@link PageDialogOpenedError} instead of waiting for
 * the transport deadline.
 * @param method - CDP method name, for example `Runtime.evaluate`.
 * @param params - method parameters; defaults to none.
 * @param sessionId - explicit target session; omit to use the current Page.
 * @param timeoutMs - response deadline in milliseconds.
 * @returns the CDP response message.
 */
export async function browserCdp(
  method,
  params: any = {},
  sessionId = undefined,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<any> {
  // Test mock: cdpOverride bypasses everything including session injection.
  // Include the effective timeout so tests can verify timing contracts without
  // waiting for a real CDP deadline.
  if (state.cdpOverride) {
    return state.cdpOverride(method, params, sessionId, timeoutMs)
  }
  const explicit = sessionId !== undefined
  let effective = sessionId
  if (!explicit && !BROWSER_LEVEL(method)) {
    effective = await ensureSession()
  }
  const dialog =
    effective && !DIALOG_SAFE_METHOD(method) ? pendingDialog(effective) : null
  if (dialog) {
    throw new PageDialogOpenedError(method, effective, dialog, {
      alreadyOpen: true,
    })
  }
  try {
    const response = await rawCdp(method, params, effective, timeoutMs)
    recordCommandState(method, params, effective, response)
    return response
  } catch (error) {
    const lost = SESSION_LOST.test(error?.message || '')
    if (lost && !explicit && !BROWSER_LEVEL(method)) {
      const lostTargetId = effective
        ? sessionTargets.get(effective)
        : defaultTargetId
      if (lostTargetId) clearTargetSession(lostTargetId)
      const fresh = await ensureSession(lostTargetId)
      const response = await rawCdp(method, params, fresh, timeoutMs)
      recordCommandState(method, params, fresh, response)
      return response
    }
    throw error
  }
}

function recordCommandState(method, params, sessionId, response) {
  if (method === 'Target.attachToTarget') {
    const attachedSessionId = response.result?.sessionId || response.sessionId
    if (params?.targetId && attachedSessionId) {
      registerSession(params.targetId, attachedSessionId)
    }
    return
  }
  if (method === 'Target.detachFromTarget' && params?.sessionId) {
    const targetId = sessionTargets.get(params.sessionId)
    if (targetId) clearTargetSession(targetId)
    return
  }
  if (!sessionId) return
  const targetId = sessionTargets.get(sessionId)
  if (!targetId) return
  const target = targetStates.get(targetId)
  if (!target) return
  if (method === 'Network.enable') {
    if (!target.networkDomainEnabled) {
      target.lastNetworkActivityAt = state.now()
    }
    target.networkDomainEnabled = true
  }
  if (method === 'Network.disable') {
    target.networkDomainEnabled = false
    target.inflightNetworkRequests.clear()
    target.ignoredFaviconRequestIds.clear()
    target.lastNetworkActivityAt = state.now()
  }
  if (method === 'Target.setAutoAttach') {
    target.autoAttachEnabled = params?.autoAttach === true
  }
}

/**
 * Return the live session for a Page target, attaching one when none is cached
 * or the cached session is older than the reuse window. Page events, network
 * tracking, and OOPIF auto-attach are enabled before the session is returned;
 * concurrent callers for one target share a single attach.
 * @param requestedTargetId - target to attach; defaults to the preferred or last-used target, else the active tab.
 * @param timeoutMs - per-request deadline in milliseconds.
 * @returns the attached session id.
 * @throws when no tab is available to attach.
 */
export async function ensureSession(
  requestedTargetId = undefined,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<any> {
  const cachedTargetId =
    requestedTargetId || state.preferredTargetId || defaultTargetId
  const cached = cachedTargetId ? targetStates.get(cachedTargetId) : undefined
  if (cached?.sessionId && Date.now() - cached.sessionAt < SESSION_TTL_MS) {
    await Promise.all([
      enablePageEvents(cached.sessionId, timeoutMs),
      enableNetworkTrackingForSession(cached.sessionId, false, timeoutMs),
      enableOopifAutoAttach(cached.sessionId, timeoutMs),
    ])
    cached.sessionAt = Date.now()
    return cached.sessionId
  }

  let targetId = requestedTargetId
  if (!targetId) {
    const result: any = await invokeEgo('listTabs', () =>
      browserEgo().listTabs(),
    )
    const tabs = result?.tabs || result?.targetInfos || []
    const preferred = state.preferredTargetId
      ? tabs.find(tab => tab.targetId === state.preferredTargetId)
      : null
    const active =
      preferred || tabs.find(tab => tab.active) || tabs[tabs.length - 1]
    if (!active) {
      throw new Error('no active tab to attach session')
    }
    targetId = active.targetId
  }

  defaultTargetId = targetId
  const target = targetState(targetId)
  if (target.sessionInflight) {
    return target.sessionInflight
  }
  target.sessionInflight = (async () => {
    try {
      if (!target.sessionId) {
        const attached = await rawCdp(
          'Target.attachToTarget',
          { targetId, flatten: true },
          undefined,
          timeoutMs,
        )
        const sessionId = attached.result?.sessionId || attached.sessionId
        if (!sessionId) {
          throw new Error('Target.attachToTarget returned no sessionId')
        }
        registerSession(targetId, sessionId)
      }
      await Promise.all([
        enablePageEvents(target.sessionId, timeoutMs),
        enableNetworkTrackingForSession(target.sessionId, false, timeoutMs),
        enableOopifAutoAttach(target.sessionId, timeoutMs),
      ])
      target.sessionAt = Date.now()
      return target.sessionId
    } finally {
      target.sessionInflight = null
    }
  })()
  return target.sessionInflight
}

/**
 * Attach sessions for every live OOPIF that belongs to one top-level Page.
 * Standard CDP reports an iframe target's parent as a frame id. The frame tree
 * and target metadata together recover the nearest Page/OOPIF target ancestor
 * without admitting unrelated iframe targets.
 * @param pageTargetId - the top-level Page target whose OOPIF frames to attach.
 * @param timeoutMs - deadline shared by the discovery and attach commands, in milliseconds.
 * @returns frame id → session id for the Page and every live OOPIF below it, plus `parentFrameIds` naming each frame's parent.
 */
export async function ensureFrameSessions(
  pageTargetId: string,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<Map<string, string> & { parentFrameIds?: ReadonlyMap<string, string | undefined> }> {
  if (typeof pageTargetId !== 'string' || pageTargetId.length === 0) {
    throw new TypeError('ensureFrameSessions requires a non-empty targetId')
  }
  const deadline = state.now() + Math.max(1, timeoutMs)
  const remaining = () => Math.max(1, deadline - state.now())
  const pageSessionId = await ensureSession(pageTargetId, remaining())
  const [response, frameTreeResponse] = await Promise.all([
    browserCdp('Target.getTargets', {}, undefined, remaining()),
    browserCdp('Page.getFrameTree', {}, pageSessionId, remaining()),
  ])
  const targetInfos =
    response?.result?.targetInfos || response?.targetInfos || []
  const frameTree =
    frameTreeResponse?.result?.frameTree || frameTreeResponse?.frameTree
  const frameParents = new Map<string, string | undefined>()
  const collectFrameGraph = (
    tree: any,
    recursiveParentId: string | undefined,
  ) => {
    const frameId = tree?.frame?.id
    if (typeof frameId !== 'string') return
    const protocolParentId = tree?.frame?.parentId
    frameParents.set(
      frameId,
      typeof protocolParentId === 'string'
        ? protocolParentId
        : recursiveParentId,
    )
    for (const child of tree?.childFrames || []) {
      collectFrameGraph(child, frameId)
    }
  }
  if (frameTree) collectFrameGraph(frameTree, undefined)
  const rootFrameId = frameTree?.frame?.id

  const iframeInfos = targetInfos.filter(
    info => info?.type === 'iframe' && typeof info.targetId === 'string',
  )
  const iframeInfoByTarget = new Map(
    iframeInfos.map(info => [info.targetId as string, info]),
  )
  const reportedParentFrameId = (info: any): string | undefined => {
    const parentFrameId = info?.parentFrameId ?? info?.parentId
    return typeof parentFrameId === 'string' ? parentFrameId : undefined
  }
  const parentFrameIdOf = (frameId: string): string | undefined => {
    if (frameParents.has(frameId)) return frameParents.get(frameId)
    return reportedParentFrameId(iframeInfoByTarget.get(frameId))
  }
  const ancestryToPage = (
    frameId: string,
  ): { belongs: boolean; depth: number } => {
    let current: string | undefined = frameId
    let depth = 0
    const visited = new Set<string>()
    while (current && !visited.has(current)) {
      if (current === pageTargetId || current === rootFrameId) {
        return { belongs: true, depth }
      }
      visited.add(current)
      current = parentFrameIdOf(current)
      depth += 1
    }
    return { belongs: false, depth }
  }

  const descendants = iframeInfos
    .map(info => ({ info, ancestry: ancestryToPage(info.targetId) }))
    .filter(({ ancestry }) => ancestry.belongs)
    .sort((left, right) => left.ancestry.depth - right.ancestry.depth)
    .map(({ info }) => info)
  const liveTargetIds = new Set(
    descendants.map(info => info.targetId as string),
  )
  const allLiveIframeTargetIds = new Set(
    iframeInfos.map(info => info.targetId as string),
  )
  const knownDescendants: string[] = []
  const collectKnownDescendants = (parentTargetId: string) => {
    for (const childTargetId of childTargets.get(parentTargetId) || []) {
      knownDescendants.push(childTargetId)
      collectKnownDescendants(childTargetId)
    }
  }
  collectKnownDescendants(pageTargetId)
  for (const knownTargetId of [...knownDescendants].reverse()) {
    // Target.getTargets and Page.getFrameTree are separate snapshots. A live
    // target can momentarily be absent from the frame tree during a swap, so
    // only target disappearance is authoritative enough to discard a session.
    if (!allLiveIframeTargetIds.has(knownTargetId)) {
      clearTargetSessionTree(knownTargetId, { remove: true })
    }
  }
  for (const knownTargetId of knownDescendants) {
    if (
      allLiveIframeTargetIds.has(knownTargetId) &&
      !liveTargetIds.has(knownTargetId)
    ) {
      const info = iframeInfoByTarget.get(knownTargetId)
      if (info) {
        descendants.push(info)
        liveTargetIds.add(knownTargetId)
      }
    }
  }

  const nearestTargetParent = (info: any): string => {
    const ancestry = ancestryToPage(info.targetId)
    if (!ancestry.belongs) {
      const knownParentTargetId = parentTargets.get(info.targetId)
      if (knownParentTargetId) return knownParentTargetId
    }
    let current = parentFrameIdOf(info.targetId)
    const visited = new Set<string>()
    while (current && !visited.has(current)) {
      if (current === pageTargetId || current === rootFrameId) {
        return pageTargetId
      }
      if (liveTargetIds.has(current)) return current
      visited.add(current)
      current = parentFrameIdOf(current)
    }
    return pageTargetId
  }

  const sessionByTarget = new Map<string, string>([
    [pageTargetId, pageSessionId],
  ])
  const vanishedTargetIds = new Set<string>()
  for (const info of descendants) {
    let sessionId: string
    try {
      sessionId = await ensureSession(info.targetId, remaining())
    } catch (error) {
      // Target.getTargets is a snapshot: an OOPIF can be destroyed between
      // enumeration and attach. Such a frame is no longer part of the page, so
      // drop it rather than fail (or restart) the whole discovery. Errors on
      // the Page target itself are raised by ensureSession above and are not
      // retried here.
      if (!isRetryableFrameLifecycleError(error)) throw error
      vanishedTargetIds.add(info.targetId)
      liveTargetIds.delete(info.targetId)
      clearTargetSessionTree(info.targetId, { remove: true })
      continue
    }
    registerTargetParent(info.targetId, nearestTargetParent(info))
    sessionByTarget.set(info.targetId, sessionId)
  }

  const sessions = new Map<string, string>() as Map<string, string> & {
    parentFrameIds?: ReadonlyMap<string, string | undefined>
  }
  const collectFrameSessions = (
    tree: any,
    inheritedSessionId: string,
    isRoot = false,
  ) => {
    const frameId = tree?.frame?.id
    if (typeof frameId !== 'string' || vanishedTargetIds.has(frameId)) return
    const sessionId = sessionByTarget.get(frameId) || inheritedSessionId
    if (!isRoot) sessions.set(frameId, sessionId)
    for (const child of tree?.childFrames || []) {
      collectFrameSessions(child, sessionId)
    }
  }
  if (frameTree) collectFrameSessions(frameTree, pageSessionId, true)
  for (const info of descendants) {
    if (vanishedTargetIds.has(info.targetId)) continue
    if (!sessions.has(info.targetId)) {
      sessions.set(info.targetId, sessionByTarget.get(info.targetId)!)
    }
  }
  sessions.parentFrameIds = new Map(
    [...sessions.keys()].map(frameId => [frameId, parentFrameIdOf(frameId)]),
  )
  return sessions
}

/**
 * Drop cached sessions, per-target state, and buffered events for one target
 * subtree, or for every known target when no id is given. The next CDP command
 * attaches a fresh session.
 * @param targetId - target subtree to clear; omit to clear all targets.
 */
export function invalidateSession(targetId = undefined): void {
  if (targetId) {
    clearTargetSessionTree(targetId, { remove: true })
    return
  }
  for (const knownTargetId of [...targetStates.keys()]) {
    clearTargetSession(knownTargetId, { remove: true })
  }
  browserEvents.length = 0
  childTargets.clear()
  parentTargets.clear()
  defaultTargetId = null
  resetUserControlProbe()
}

/**
 * Prefer one target for implicit session attachment, for example after the user
 * switches tabs.
 * @param targetId - target to prefer; a falsy value clears the preference.
 */
export function setPreferredTarget(targetId): void {
  state.preferredTargetId = targetId || null
}

/** Clear the preferred target so implicit attachment follows the active tab again. */
export function clearPreferredTarget(): void {
  state.preferredTargetId = null
}

/**
 * Take every buffered event: browser-level events plus the events of the
 * selected or preferred target.
 * @param sessionId - session whose target events to include; omit for the preferred or last-used target.
 * @returns the drained CDP messages in arrival order.
 */
export function drainBrowserEvents(sessionId = undefined): any[] {
  const targetId = sessionId
    ? sessionTargets.get(sessionId)
    : state.preferredTargetId || defaultTargetId
  const target = targetId ? targetStates.get(targetId) : undefined
  const out = browserEvents.splice(0, browserEvents.length)
  if (target) out.push(...target.events.splice(0, target.events.length))
  return out
}

/**
 * Drain only events routed to one Page session.
 * @param sessionId - session whose target events to drain.
 * @returns the drained CDP messages, or an empty array for an unknown session.
 */
export function drainPageEvents(sessionId): any[] {
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined
  const target = targetId ? targetStates.get(targetId) : undefined
  return target ? target.events.splice(0, target.events.length) : []
}

/**
 * Return the JavaScript dialog blocking the Page that owns this session. An
 * OOPIF session reports its top-level Page's dialog: Chromium delivers every
 * dialog event on the Page session, and a dialog opened by any frame stalls
 * that frame's renderer.
 * @param sessionId - session whose Page dialog to report; omit for the preferred or last-used target.
 * @returns a copy of the open dialog's `Page.javascriptDialogOpening` params, or null when no dialog is open.
 */
export function pendingDialog(sessionId): Record<string, unknown> | null {
  const targetId = sessionId
    ? sessionTargets.get(sessionId)
    : state.preferredTargetId || defaultTargetId
  const dialog = targetId
    ? targetStates.get(pageRootTargetId(targetId))?.pendingDialog
    : null
  return dialog ? { ...dialog } : null
}

/**
 * Whether Network events are enabled on the target that owns a session.
 * @param sessionId - session to inspect.
 * @returns true when that session's target has the Network domain enabled.
 */
export function isNetworkDomainEnabled(sessionId): boolean {
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined
  return targetId
    ? Boolean(targetStates.get(targetId)?.networkDomainEnabled)
    : false
}

/**
 * Ensure Network events are available on every selected Page/OOPIF session.
 * @param sessionIds - sessions to enable; duplicates and falsy ids are ignored.
 * @param timeoutMs - per-request deadline in milliseconds.
 * @throws when a listed session is already detached.
 */
export async function ensureNetworkTracking(
  sessionIds: string[],
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<void> {
  const unique = [...new Set(sessionIds.filter(Boolean))]
  await Promise.all(
    unique.map(sessionId =>
      enableNetworkTrackingForSession(sessionId, true, timeoutMs),
    ),
  )
}

/**
 * Read continuous network state without consuming the public Page event queue.
 * @param sessionIds - sessions to aggregate.
 * @returns whether every session is tracked, the combined in-flight request count, and the newest activity timestamp.
 */
export function networkActivity(sessionIds: string[]): {
  tracking: boolean
  inflight: number
  lastActivityAt: number
} {
  let tracking = sessionIds.length > 0
  let inflight = 0
  let lastActivityAt = 0
  for (const sessionId of new Set(sessionIds)) {
    const targetId = sessionTargets.get(sessionId)
    const target = targetId ? targetStates.get(targetId) : undefined
    if (
      !target ||
      target.sessionId !== sessionId ||
      !target.networkDomainEnabled
    ) {
      tracking = false
      continue
    }
    inflight += target.inflightNetworkRequests.size
    lastActivityAt = Math.max(lastActivityAt, target.lastNetworkActivityAt)
  }
  return { tracking, inflight, lastActivityAt }
}

/**
 * Refresh and return the main and known OOPIF sessions for one Page.
 * @param sessionId - any session of the Page whose frame tree to refresh.
 * @param timeoutMs - deadline shared by the refresh commands, in milliseconds.
 * @returns the current main session first, then each known frame session of the Page.
 * @throws when the session is detached, or when the Page re-attached mid-refresh.
 */
export async function pageNetworkSessions(
  sessionId: string,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<string[]> {
  const targetId = sessionTargets.get(sessionId)
  if (!targetId) {
    throw new Error(
      'cannot resolve Page network sessions from a detached session',
    )
  }
  const frameSessions = await ensureFrameSessions(targetId, timeoutMs)
  const currentMainSession = targetStates.get(targetId)?.sessionId
  if (!currentMainSession) {
    throw new Error('Page session was detached while refreshing network state')
  }
  return [...new Set([currentMainSession, ...frameSessions.values()])]
}

/**
 * Suppress the operating-system file picker and observe the next chooser in
 * one Page session. The caller owns the short-lived interception and must
 * dispose it after setting files or completing an input action.
 * @param sessionId - Page session whose file chooser to intercept.
 * @param options - `timeoutMs` bounds the wait for the chooser; `cancel` completes
 *   an intercepted chooser with an empty file list instead of opening the picker.
 * @returns the interception handle; its `event` resolves with the next opened chooser and rejects on timeout or disposal.
 */
export function prepareFileChooser(
  sessionId: string,
  options: { timeoutMs: number; cancel: boolean },
): FileChooserInterception {
  const { timeoutMs, cancel } = options
  const targetId = sessionTargets.get(sessionId)
  const target = targetId ? targetStates.get(targetId) : undefined
  if (!target) {
    throw new Error('cannot intercept a file chooser without a Page session')
  }
  if (target.fileChooserInterception) {
    throw new Error('this Page is already waiting for a file chooser')
  }

  let observed: FileChooserOpenedEvent | undefined
  let resolveEvent!: (event: FileChooserOpenedEvent) => void
  let rejectEvent!: (error: Error) => void
  const event = new Promise<FileChooserOpenedEvent>((resolve, reject) => {
    resolveEvent = resolve
    rejectEvent = reject
  })
  // A safety interceptor normally consumes peek() instead of awaiting event.
  // Attach a rejection observer so disposal never creates an unhandled promise.
  void event.catch(() => {})

  const interception: any = {
    cancelPromise: undefined,
    event,
    reject: rejectEvent,
    resolve(value: FileChooserOpenedEvent) {
      if (observed) return
      observed = value
      clearTimeout(interception.timer)
      resolveEvent(value)
      if (cancel) {
        // An empty file list completes the intercepted chooser without opening
        // the native picker or changing the input's current selection.
        interception.cancelPromise = rawCdp(
          'DOM.setFileInputFiles',
          { files: [], backendNodeId: value.backendNodeId },
          sessionId,
        ).catch(() => {})
      }
    },
    peek() {
      return observed
    },
    async dispose(reason?: Error) {
      if (target.fileChooserInterception !== interception) return
      target.fileChooserInterception = null
      clearTimeout(interception.timer)
      if (!observed && reason) rejectEvent(reason)
      await interception.ready.catch(() => {})
      await interception.cancelPromise
      const disable = rawCdp(
        'Page.setInterceptFileChooserDialog',
        { enabled: false },
        sessionId,
      ).catch(() => {})
      if (target.pendingDialog) {
        // Chromium can hold this housekeeping response until the modal dialog
        // closes. Send it now, but do not keep the triggering action's gate
        // occupied; Page.handleJavaScriptDialog must be able to run next.
        void disable
        return
      }
      await disable
    },
  }
  target.fileChooserInterception = interception
  interception.ready = rawCdp(
    'Page.setInterceptFileChooserDialog',
    { enabled: true },
    sessionId,
  )
    .then(() => {
      interception.timer = setTimeout(() => {
        const error: any = new Error(
          `page.waitForFileChooser timed out after ${timeoutMs}ms`,
        )
        error.code = 'EGO_FILE_CHOOSER_TIMEOUT'
        if (target.fileChooserInterception === interception) {
          target.fileChooserInterception = null
          rejectEvent(error)
          void rawCdp(
            'Page.setInterceptFileChooserDialog',
            { enabled: false },
            sessionId,
          ).catch(() => {})
        }
      }, timeoutMs)
    })
    .catch((error) => {
      if (target.fileChooserInterception === interception) {
        target.fileChooserInterception = null
      }
      rejectEvent(error)
      throw error
    })
  return interception
}

async function enablePageEvents(sessionId, timeoutMs = RESPONSE_TIMEOUT_MS) {
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined
  const target = targetId ? targetStates.get(targetId) : undefined
  if (!target || target.pageEventsEnabled) {
    return
  }
  try {
    await rawCdp('Page.enable', {}, sessionId, timeoutMs)
    target.pageEventsEnabled = true
  } catch {
    // Dialog tracking is best-effort. Do not make all helpers fail on targets
    // that reject Page.enable, such as unusual internal pages.
  }
}

async function enableNetworkTrackingForSession(
  sessionId: string,
  required = false,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<void> {
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined
  const target = targetId ? targetStates.get(targetId) : undefined
  if (!target || target.sessionId !== sessionId) {
    if (required) {
      throw new Error(
        'cannot track network activity for a detached Page session',
      )
    }
    return
  }
  if (target.networkDomainEnabled) return

  let inflight = target.networkEnableInflight
  const reusedInflight = Boolean(inflight)
  if (!inflight) {
    inflight = rawCdp('Network.enable', {}, sessionId, timeoutMs).then(() => {
      // Events and an OOPIF request migration can race ahead of this response.
      // Network.disable and session replacement already clear stale state, so
      // enabling must preserve everything observed for the current session.
      if (target.sessionId === sessionId && !target.networkDomainEnabled) {
        target.lastNetworkActivityAt = state.now()
        target.networkDomainEnabled = true
      }
    })
    target.networkEnableInflight = inflight
    void inflight.then(
      () => {
        if (target.networkEnableInflight === inflight) {
          target.networkEnableInflight = null
        }
      },
      () => {
        if (target.networkEnableInflight === inflight) {
          target.networkEnableInflight = null
        }
      },
    )
  }

  try {
    await (reusedInflight
      ? waitForSharedCdpRequest(
        inflight,
        'Network.enable',
        sessionId,
        timeoutMs,
      )
      : inflight)
  } catch (error) {
    if (required) throw error
  }
  if (required && !target.networkDomainEnabled) {
    throw new Error(
      'network tracking was interrupted by a detached Page session',
    )
  }
}

async function enableOopifAutoAttach(
  sessionId: string,
  timeoutMs = RESPONSE_TIMEOUT_MS,
): Promise<void> {
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined
  const target = targetId ? targetStates.get(targetId) : undefined
  if (!target || target.sessionId !== sessionId || target.autoAttachEnabled) {
    return
  }

  let inflight = target.autoAttachInflight
  const reusedInflight = Boolean(inflight)
  if (!inflight) {
    inflight = rawCdp(
      'Target.setAutoAttach',
      OOPIF_AUTO_ATTACH_PARAMS,
      sessionId,
      timeoutMs,
    ).then(() => {
      if (target.sessionId === sessionId) target.autoAttachEnabled = true
    })
    target.autoAttachInflight = inflight
    void inflight.then(
      () => {
        if (target.autoAttachInflight === inflight) {
          target.autoAttachInflight = null
        }
      },
      () => {
        if (target.autoAttachInflight === inflight) {
          target.autoAttachInflight = null
        }
      },
    )
  }
  try {
    await (reusedInflight
      ? waitForSharedCdpRequest(
        inflight,
        'Target.setAutoAttach',
        sessionId,
        timeoutMs,
      )
      : inflight)
  } catch {
    // Page APIs still work on bridges without auto-attach. Frame discovery can
    // attach explicitly later, but exact network-idle tracking needs support.
  }
}

/** Bound one caller's wait without cancelling the shared CDP request. */
function waitForSharedCdpRequest(
  request: Promise<void>,
  method: string,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const callerTimeoutMs = Math.max(1, timeoutMs)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CdpRequestTimeoutError(method, callerTimeoutMs, sessionId))
    }, callerTimeoutMs)
    request.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function initializeAutoAttachedTarget(
  sessionId: string,
  waitingForDebugger: boolean,
): void {
  // Invoke every initializer before awaiting any result. Chromium can pause an
  // OOPIF at attachment, so waiting for Network.enable before sending resume
  // would deadlock if the protocol response depends on renderer progress.
  const pageEvents = enablePageEvents(sessionId)
  const networkEvents = enableNetworkTrackingForSession(sessionId)
  const nestedFrames = enableOopifAutoAttach(sessionId)
  const resume = waitingForDebugger
    ? rawCdp('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {})
    : Promise.resolve()
  void Promise.allSettled([pageEvents, networkEvents, nestedFrames, resume])
}

function finishNetworkRequest(targetId: string, requestId: string): void {
  const now = state.now()
  const rootTargetId = pageRootTargetId(targetId)
  for (const pageTargetId of pageTreeTargetIds(rootTargetId)) {
    const pageTarget = targetStates.get(pageTargetId)
    if (!pageTarget) continue
    if (pageTarget.inflightNetworkRequests.delete(requestId)) {
      pageTarget.lastNetworkActivityAt = now
    }
  }
}

function isIgnoredFaviconRequest(targetId: string, requestId: string): boolean {
  const rootTargetId = pageRootTargetId(targetId)
  return pageTreeTargetIds(rootTargetId).some(pageTargetId =>
    targetStates.get(pageTargetId)?.ignoredFaviconRequestIds.has(requestId),
  )
}

function clearIgnoredFaviconRequest(
  targetId: string,
  requestId: string,
): boolean {
  const rootTargetId = pageRootTargetId(targetId)
  let deleted = false
  for (const pageTargetId of pageTreeTargetIds(rootTargetId)) {
    deleted =
      Boolean(
        targetStates
          .get(pageTargetId)
          ?.ignoredFaviconRequestIds.delete(requestId),
      ) || deleted
  }
  return deleted
}

function recordNetworkEvent(targetId: string, target, data): void {
  // A response to Network.disable can be followed by a queued terminal event.
  // Ignore it once tracking is off, while still accepting events that race the
  // response to our own Network.enable request.
  if (!target.networkDomainEnabled && !target.networkEnableInflight) return
  const requestId = data?.params?.requestId
  if (typeof requestId !== 'string' || requestId.length === 0) return

  if (data.method === 'Network.requestWillBeSent') {
    const url = data.params?.request?.url
    // Chromium can omit the terminal event for its automatic favicon request.
    // Playwright excludes favicons from network-idle accounting for the same
    // reason, so they must never leave a permanent in-flight entry here.
    if (
      (typeof url === 'string' && url.endsWith('/favicon.ico')) ||
      isIgnoredFaviconRequest(targetId, requestId)
    ) {
      target.ignoredFaviconRequestIds.add(requestId)
      if (target.inflightNetworkRequests.delete(requestId)) {
        target.lastNetworkActivityAt = state.now()
      }
      return
    }
    target.networkDomainEnabled = true
    target.inflightNetworkRequests.set(requestId, {
      requestId,
      ...(typeof data.params?.frameId === 'string'
        ? { frameId: data.params.frameId }
        : {}),
      ...(typeof data.params?.loaderId === 'string'
        ? { loaderId: data.params.loaderId }
        : {}),
      ...(typeof data.params?.type === 'string'
        ? { type: data.params.type }
        : {}),
    })
    target.lastNetworkActivityAt = state.now()
    return
  }
  if (
    data.method === 'Network.loadingFinished' ||
    data.method === 'Network.loadingFailed'
  ) {
    target.networkDomainEnabled = true
    if (clearIgnoredFaviconRequest(targetId, requestId)) return
    finishNetworkRequest(targetId, requestId)
    target.lastNetworkActivityAt = state.now()
  }
}

// Local send failures for ego.sendCDPMessage() arrive here instead of as a CDP
// response. The callback carries no request id, so task-level failures reject
// every pending request. User-control failures first probe the native task state:
// the CDP callback does not carry the permission reason, while ordinary native
// calls may do so on newer Ego Lite builds.
function handleSendError(message, error_code) {
  if (pending.size === 0) return

  if (error_code !== 'EGO_TASK_SPACE_USER_IN_CONTROL') {
    rejectAllPending(buildEgoError({ error: message, error_code }))
    return
  }
  if (userControlProbeState === 'stopped' && userControlStopError) {
    rejectAllPending(userControlStopError)
    return
  }
  if (userControlProbeState === 'probing') return

  userControlProbeState = 'probing'
  const generation = ++userControlProbeGeneration
  void probeUserControlReason(message, error_code, generation)
}

async function probeUserControlReason(
  message: string,
  error_code: string,
  generation: number,
): Promise<void> {
  const fallback = { error: message, error_code }
  const runtime = browserEgo()
  if (typeof runtime.setAgentTaskState !== 'function') {
    stopForUserControl(fallback, generation)
    return
  }

  try {
    const result = await runtime.setAgentTaskState('Waiting for the user')
    if (generation !== userControlProbeGeneration) return
    if (isEgoUserControlError(result)) {
      stopForUserControl(result, generation)
      return
    }
    if (result && typeof result === 'object' && 'error' in result) {
      stopForUserControl(fallback, generation)
      return
    }

    // Control came back between the failed send and the probe. The original
    // command still failed, but it must not create a new global hard stop.
    userControlProbeState = 'idle'
    userControlStopError = null
    rejectAllPending(nativeSendError(message, error_code))
  } catch (error) {
    if (generation !== userControlProbeGeneration) return
    stopForUserControl(
      isEgoUserControlError(error) ? error : fallback,
      generation,
    )
  }
}

function stopForUserControl(errorLike: unknown, generation: number): void {
  if (generation !== userControlProbeGeneration) return
  userControlStopError = buildEgoError(errorLike)
  userControlProbeState = 'stopped'
  rejectAllPending(userControlStopError)
}

function rejectAllPending(error: Error): void {
  const entries = [...pending.values()]
  pending.clear()
  for (const entry of entries) entry.reject(error)
}

function nativeSendError(
  message: string,
  error_code: string,
): Error & { error_code?: string } {
  const error: Error & { error_code?: string } = new Error(
    message || error_code || 'CDP send failed',
  )
  if (error_code) error.error_code = error_code
  return error
}

function resetUserControlProbe(): void {
  userControlProbeGeneration += 1
  userControlProbeState = 'idle'
  userControlStopError = null
}

function handleMessage(message) {
  let data
  try {
    data = JSON.parse(message)
  } catch {
    return
  }
  if (Object.hasOwn(data, 'id')) {
    const entry = pending.get(data.id)
    if (!entry) {
      return
    }
    pending.delete(data.id)
    if (data.error) {
      const error: CdpCommandError = new Error(
        data.error.message || data.error,
      )
      if (entry.sessionId) error.sessionId = entry.sessionId
      entry.reject(error)
      return
    }
    if (userControlProbeState === 'stopped') {
      // A successful command proves control has returned. Re-arm detection so a
      // later, separate takeover can run its own reason probe.
      resetUserControlProbe()
    }
    entry.resolve(data)
    return
  }
  if (
    data.method === 'Target.detachedFromTarget' ||
    data.method === 'Target.targetDestroyed'
  ) {
    const targetId =
      data.params?.targetId ||
      data.params?.targetInfo?.targetId ||
      (data.params?.sessionId
        ? sessionTargets.get(data.params.sessionId)
        : undefined)
    if (targetId) {
      clearTargetSessionTree(targetId, {
        remove: data.method === 'Target.targetDestroyed',
      })
    }
  } else if (data.method === 'Target.attachedToTarget') {
    const sessionId = data.params?.sessionId
    const targetId = data.params?.targetInfo?.targetId
    const targetType = data.params?.targetInfo?.type
    const reportedParentFrameId =
      data.params?.targetInfo?.parentFrameId ||
      data.params?.targetInfo?.parentId
    // Target.attachedToTarget is emitted on the nearest owning target session.
    // Prefer that target edge over parentFrameId, which may name a same-process
    // frame and is not itself a debuggable target.
    const sourceTargetId = data.sessionId
      ? sessionTargets.get(data.sessionId)
      : undefined
    const parentTargetId = sourceTargetId || reportedParentFrameId
    if (sessionId && targetId) registerSession(targetId, sessionId)
    if (targetId && parentTargetId && targetId !== parentTargetId) {
      registerTargetParent(targetId, parentTargetId)
    }
    if (sessionId && targetType === 'iframe') {
      initializeAutoAttachedTarget(
        sessionId,
        data.params?.waitingForDebugger === true,
      )
    } else if (sessionId && data.params?.waitingForDebugger === true) {
      // A foreign auto-attach configuration may still deliver other related
      // target types. Never leave an unrelated worker paused by this runtime.
      void rawCdp('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(
        () => {},
      )
    }
  }
  const sessionId = data.sessionId
  const targetId = sessionId ? sessionTargets.get(sessionId) : undefined
  const target = targetId ? targetStates.get(targetId) : undefined
  if (target && typeof data.method === 'string') {
    recordNetworkEvent(targetId, target, data)
  }
  if (data.method === 'Page.javascriptDialogOpening') {
    if (target) {
      // A Page event proves the domain is enabled even if the Page.enable
      // response is stalled behind this dialog and rejected below.
      target.pageEventsEnabled = true
      const root = targetStates.get(pageRootTargetId(targetId))
      if (root) {
        root.pendingDialog = data.params || {}
        rejectCommandsBlockedByDialog(
          targetId,
          root.pendingDialog as Record<string, unknown>,
        )
      }
    }
  } else if (data.method === 'Page.javascriptDialogClosed') {
    const root = targetId
      ? targetStates.get(pageRootTargetId(targetId))
      : undefined
    if (root) root.pendingDialog = null
  } else if (data.method === 'Page.fileChooserOpened') {
    target?.fileChooserInterception?.resolve(data.params || {})
  }
  if (typeof data.method === 'string' && BROWSER_LEVEL(data.method)) {
    for (const listener of [...browserEventSubscribers]) {
      guardNativeCallback('browser event subscriber', () => listener(data))
    }
  }
  if (targetId && typeof data.method === 'string') {
    for (const listener of [...(pageEventSubscribers.get(targetId) || [])]) {
      guardNativeCallback('page event subscriber', () => listener(data))
    }
  }
  const events = target ? target.events : browserEvents
  events.push(data)
  capEvents(events)
}

function rejectCommandsBlockedByDialog(
  targetId: string,
  dialog: Record<string, unknown>,
) {
  // The dialog stalls whichever renderer opened it, and CDP does not say which
  // frame session that is. Treat the whole Page tree as blocked.
  const sessionIds = new Set(
    pageTreeTargetIds(pageRootTargetId(targetId))
      .map(id => targetStates.get(id)?.sessionId)
      .filter(Boolean),
  )
  for (const [id, entry] of pending) {
    if (!sessionIds.has(entry.sessionId) || DIALOG_SAFE_METHOD(entry.method)) {
      continue
    }
    pending.delete(id)
    entry.reject(
      new PageDialogOpenedError(entry.method, entry.sessionId, dialog),
    )
  }
}

function rejectFileChooserInterception(target, error: Error) {
  const interception = target.fileChooserInterception
  if (!interception) return
  target.fileChooserInterception = null
  clearTimeout(interception.timer)
  interception.reject(error)
}

/**
 * Replace a ref map from snapshot ref entries, keeping each entry's frame id so
 * a ref stays usable only in the frame that produced it. Entries without a
 * backendNodeId are skipped.
 * @param refMap - the ref map to clear and refill.
 * @param refs - snapshot ref entries to load.
 */
export function browserSnapshotRefsToRefMap(refMap, refs = []): void {
  refMap.clear()
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') {
      continue
    }
    if (ref.backendNodeId === undefined || ref.backendNodeId === null) {
      continue
    }
    refMap.addWithFrame(
      String(ref.refId ?? ref.backendNodeId),
      ref.backendNodeId,
      ref.role,
      ref.name,
      undefined,
      ref.frameId,
    )
  }
}
