// @ts-nocheck — ported from ego-browser v2.1.0 (strict:false); vendor exemption, not strict-checked.
import {
  browserEgo,
  clearPreferredTarget,
  ensureSession,
  invalidateSession,
  isBrowserRuntime,
  pendingDialog,
  setPreferredTarget,
} from '../browser-runtime.ts'
import { cdp, js } from '../cdp-eval.ts'
import { invokeEgo } from '../ego-errors.ts'
import { state } from '../state.ts'
import { waitForDocumentLoad } from './load.ts'

/**
 * URL prefixes Chrome reserves for its own pages, used to keep internal targets
 * out of tab listings and real-tab checks.
 */
export const INTERNAL_URL_PREFIXES = [
  'chrome://',
  'chrome-untrusted://',
  'devtools://',
  'chrome-extension://',
  'about:',
]

type TabInfo = {
  targetId: string
  title: string
  url: string
  active: boolean
  index?: number
}

type GotoAndWaitOptions = {
  timeout?: number
  settle?: number
  wait?: boolean
}

type ListTabsOptions = {
  includeChrome?: boolean
}

type UrlMatchMode = 'exact' | 'origin' | 'origin+path' | 'includes'

type OpenOrReuseTabOptions = {
  match?: UrlMatchMode
  wait?: boolean
  timeout?: number
  settle?: number
}

type TabTarget = string | { targetId: string }

/** `Page.navigate` payload fields this driver acts on (see driver/page-waits.ts). */
type NavigationResult = {
  errorText?: string
  isDownload?: boolean
}

/**
 * Navigate the current tab to a URL using CDP Page.navigate.
 * @param url - absolute or browser-supported URL to load.
 * @returns the CDP Page.navigate result; a rejected navigation still resolves with `errorText`.
 */
export async function gotoUrl(url): Promise<any> {
  return cdp('Page.navigate', { url })
}

/**
 * Navigate the current tab and wait for load/settle in one call.
 *
 * A rejected navigation (DNS failure, refused connection, blocked scheme) still
 * resolves `Page.navigate` with `errorText` and leaves the tab on Chrome's error
 * page, so reporting the URL as reached would be false. Mirrors the Page.goto
 * contract in driver/page-waits.ts.
 * @param url - absolute or browser-supported URL to load.
 * @param options - timeout budget, settle delay after load, and whether to wait for load at all.
 * @returns the raw `Page.navigate` result and whether the document reached `complete`.
 * @throws {Error} When Chrome reports a navigation error or a started download.
 */
export async function gotoAndWait(
  url: string,
  options: GotoAndWaitOptions = {},
): Promise<{ navigation: NavigationResult; loaded: boolean }> {
  const navigation = (await gotoUrl(url)) as NavigationResult
  if (typeof navigation.errorText === 'string') {
    throw new Error(`gotoAndWait failed for ${url}: ${navigation.errorText}`)
  }
  if (navigation.isDownload === true) {
    throw new Error(`gotoAndWait failed for ${url}: navigation started a download`)
  }
  const loaded =
    options.wait === false
      ? false
      : await waitForDocumentLoad({ timeout: options.timeout ?? 20 })
  const settle = Number(options.settle ?? 0)
  if (settle > 0) {
    await state.sleep(settle * 1000)
  }
  return { navigation, loaded }
}

/**
 * Read basic state for the current page.
 * @returns the page metrics (URL, title, viewport and scroll sizes), or `{dialog}`
 *   when a JavaScript dialog is pending.
 */
export async function pageInfo(): Promise<any> {
  if (isBrowserRuntime()) {
    const sessionId = await ensureSession()
    const dialog = pendingDialog(sessionId)
    if (dialog) {
      return { dialog }
    }
  }
  const expression =
    'JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})'
  return JSON.parse(await js(expression))
}

/**
 * List open page targets known to the browser.
 * @param options - when `includeChrome` is false, internal `chrome://` targets are omitted.
 * @returns the open page targets, normalized to non-null title and URL strings.
 */
export async function listTabs(
  options: ListTabsOptions = {},
): Promise<TabInfo[]> {
  const includeChrome = options.includeChrome ?? true
  const result = await invokeEgo('listTabs', () => browserEgo().listTabs())
  const tabs = result.tabs || []
  return tabs
    .filter(
      tab =>
        includeChrome ||
        !INTERNAL_URL_PREFIXES.some(prefix =>
          (tab.url || '').startsWith(prefix),
        ),
    )
    .map(tab => ({
      targetId: tab.targetId,
      title: tab.title || '',
      url: tab.url || '',
      active: Boolean(tab.active),
      index: tab.index,
    }))
}

/**
 * Return the currently attached tab.
 * @returns the active tab's target id, URL, and title.
 * @throws {Error} When no page tab is open.
 */
export async function currentTab(): Promise<{ targetId: string; url: string; title: string }> {
  const tabs = await listTabs()
  const active = tabs.find(tab => tab.active) || tabs[0]
  if (!active) {
    throw new Error('no active browser tab')
  }
  return { targetId: active.targetId, url: active.url, title: active.title }
}

/**
 * Activate an existing tab target.
 * @param target - target id or tab-like object.
 * @returns the activated target id, now the preferred target for later calls.
 */
export async function switchTab(target: string | { targetId: string }): Promise<string> {
  const targetId = typeof target === 'object' ? target.targetId : target
  await cdp('Target.activateTarget', { targetId })
  setPreferredTarget(targetId)
  return targetId
}

/**
 * Open a new tab and optionally navigate it.
 * @param url - URL to open; defaults to about:blank.
 * @returns the new target id, now the preferred target for later calls.
 * @throws {Error} When the browser returns no target id.
 */
export async function newTab(url = 'about:blank'): Promise<any> {
  const result = await invokeEgo('newTab', () => browserEgo().createTab(url))
  if (!result.targetId) {
    throw new Error('newTab returned no targetId')
  }
  // Native createTab activates the new tab. Keep the harness route in sync so
  // the next target-less helper cannot remain attached to the previous Page.
  setPreferredTarget(result.targetId)
  return result.targetId
}

/**
 * Reuse an existing matching tab or open a new one.
 * @param url - URL to find or open.
 * @param options - match mode, whether to wait for load, and the timeout/settle budgets.
 * @returns the reused or newly created tab, with `reused` marking which happened.
 */
export async function openOrReuseTab(
  url: string,
  options: OpenOrReuseTabOptions = {},
): Promise<
  | {
    active: boolean
    reused: boolean
    targetId: string
    title: string
    url: string
    index?: number
  }
  | { targetId: any; url: string; title: string; active: boolean; reused: boolean }
> {
  const tabs = await listTabs({ includeChrome: false })
  const match = options.match || 'exact'
  const existing = tabs.find(tab => tabMatchesUrl(tab.url, url, match))
  if (existing) {
    await switchTab(existing.targetId)
    if (options.wait) {
      await waitForDocumentLoad({ timeout: options.timeout ?? 20 })
    }
    const settle = Number(options.settle ?? 0)
    if (settle > 0) {
      await state.sleep(settle * 1000)
    }
    return { ...existing, active: true, reused: true }
  }
  const targetId = await newTab(url)
  if (options.wait !== false) {
    await waitForDocumentLoad({ timeout: options.timeout ?? 20 })
  }
  const settle = Number(options.settle ?? 0)
  if (settle > 0) {
    await state.sleep(settle * 1000)
  }
  return { targetId, url, title: '', active: true, reused: false }
}

/**
 * Close a browser tab by target id, tab object, or the current tab when omitted.
 * @param target - target id or tab-like object; defaults to the current tab.
 * @returns the closed target id, with its session and preferred-target state dropped.
 */
export async function closeTab(target: TabTarget | undefined = undefined): Promise<string> {
  const targetId =
    target === undefined
      ? (await currentTab()).targetId
      : typeof target === 'object'
        ? target.targetId
        : target
  if (!targetId) {
    throw new Error('closeTab requires a targetId')
  }
  await cdp('Target.closeTarget', { targetId })
  invalidateSession(targetId)
  if (state.preferredTargetId === targetId) {
    clearPreferredTarget()
  }
  return targetId
}

/**
 * Ensure the active harness session points at a real, non-internal page tab.
 * @returns the current tab when it is a real page, otherwise the first
 *   non-internal tab; null when the browser has none.
 */
export async function ensureRealTab(): Promise<{ targetId: string; url: string; title: string } | null | undefined> {
  const tabs = await listTabs({ includeChrome: false })
  if (tabs.length === 0) {
    return null
  }
  const current = await currentTab().catch(() => null)
  if (
    current?.url &&
    !INTERNAL_URL_PREFIXES.some(prefix => current.url.startsWith(prefix))
  ) {
    return current
  }
  await switchTab(tabs[0].targetId)
  return tabs[0]
}

/**
 * Find an iframe target whose URL contains a substring.
 * @param urlSubstring - URL substring to match.
 * @returns the matching iframe target id, or null when none matches.
 */
export async function iframeTarget(urlSubstring): Promise<any> {
  const targets = (await cdp('Target.getTargets')).targetInfos || []
  return (
    targets.find(
      target =>
        target.type === 'iframe' && (target.url || '').includes(urlSubstring),
    )?.targetId || null
  )
}

function tabMatchesUrl(tabUrl: string, wantedUrl: string, match: UrlMatchMode) {
  if (!tabUrl) {
    return false
  }
  if (match === 'includes') {
    return tabUrl.includes(wantedUrl)
  }
  let tab
  let wanted
  try {
    tab = new URL(tabUrl)
    wanted = new URL(wantedUrl)
  } catch {
    return tabUrl === wantedUrl
  }
  if (match === 'origin') {
    return tab.origin === wanted.origin
  }
  if (match === 'origin+path') {
    return (
      tab.origin === wanted.origin &&
      trimSlash(tab.pathname) === trimSlash(wanted.pathname)
    )
  }
  return tab.href === wanted.href
}

function trimSlash(pathname: string) {
  return pathname.replace(/\/+$/, '') || '/'
}
