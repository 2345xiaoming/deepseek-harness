/**
 * Lazily-launched headless Chrome instance for the ego-browser bridge.
 *
 * The harness's whole browser dependency collapses onto `globalThis.ego`, so
 * this module owns the one real browser lifecycle that the rest of the bridge
 * forwards CDP traffic to: spawn a headless Chrome with a fresh temporary
 * profile and an HTTP+WS DevTools endpoint, wait (bounded) for `DevToolsActivePort`,
 * expose `jsonVersion()`/`pageTargets()`, and `dispose()` to tear it down.
 *
 * Everything is tiered: the instance is created on first access, cached until
 * dispose, and tears itself down on dispose (SIGTERM then SIGKILL fallback,
 * removing the temp profile). A stale/dead instance is detected on the next
 * control-plane call and replaced on demand.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface PageTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

const CHROME_BIN_CANDIDATES = [
  process.env.DSH_EGO_BROWSER_CHROME,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
].filter(Boolean) as string[]

export interface ChromeLaunchOptions {
  /** Override the browser binary; falls back to PATH + common names otherwise. */
  chromeBin?: string
  /** Fixed debugging port (default: 0 → DevToolsActivePort picks a random one). */
  port?: number
  /** Optional extra argument list appended to the headless command. */
  extraArgs?: string[]
}

interface ChromeInstance {
  process: ChildProcess
  profileDir: string
  port: number
  wsUrl: string | null
  dead: boolean
}

let current: ChromeInstance | null = null
let launching: Promise<ChromeInstance> | null = null

function resolveChromeBin(preferred?: string): string {
  if (preferred) return preferred
  for (const candidate of CHROME_BIN_CANDIDATES) {
    if (candidate && (candidate.includes('/') ? existsSync(candidate) : true)) {
      if (!candidate.includes('/')) {
        // Look in PATH via spawn and immediately fail; Python-style shutil.which lite:
        // existsSync on each path segment is enough here because spawn will surface ENOENT.
        const check = ['/usr/bin', '/usr/local/bin', '/bin']
        for (const dir of check) {
          if (existsSync(join(dir, candidate))) return join(dir, candidate)
        }
      }
      return candidate
    }
  }
  throw new Error('dsh-ego-browser: no Chrome binary found (set DSH_EGO_BROWSER_CHROME)')
}

async function waitForDevToolsPort(profileDir: string, timeoutMs = 6000): Promise<number | null> {
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (existsSync(portFile)) {
        const lines = readFileSync(portFile, 'utf8').trim().split(/\r?\n/)
        const port = Number(lines[0])
        if (Number.isInteger(port) && port > 0) return port
      }
    } catch {
      // File not ready yet; poll.
    }
    await new Promise(r => setTimeout(r, 50))
  }
  return null
}

/**
 * Spawn a fresh headless Chrome with a throwaway profile and return its DevTools port.
 * The caller owns teardown via {@link disposeChrome}. Bounded by {timeoutMs}.
 */
export async function launchChrome(options: ChromeLaunchOptions = {}): Promise<ChromeInstance> {
  const bin = resolveChromeBin(options.chromeBin)
  const profileDir = await mkdtemp(join(tmpdir(), 'dsh-ego-browser-'))
  const port = options.port ?? 0
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(options.extraArgs ?? []),
    'about:blank',
  ]
  const proc = spawn(bin, args, { stdio: 'ignore' })
  proc.on('error', () => {
    // Surface as dead on next control-plane call.
    if (current) current.dead = true
  })
  proc.on('exit', () => {
    if (current) current.dead = true
  })
  const resolvedPort = port !== 0 ? port : await waitForDevToolsPort(profileDir)
  if (resolvedPort === null) {
    proc.kill('SIGKILL')
    rmSync(profileDir, { recursive: true, force: true })
    throw new Error('dsh-ego-browser: Chrome started but DevToolsActivePort never appeared')
  }
  return { process: proc, profileDir, port: resolvedPort, wsUrl: null, dead: false }
}

/** Control-plane endpoint helper: GET /json/version (used to find the browser WS URL). */
export async function jsonVersion(instance: ChromeInstance): Promise<{ webSocketDebuggerUrl?: string }> {
  const res = await fetch(`http://127.0.0.1:${instance.port}/json/version`)
  if (!res.ok) throw new Error(`dsh-ego-browser: /json/version HTTP ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

/** Control-plane endpoint helper: GET /json/list → page targets (used by ego.listTabs). */
export async function pageTargets(instance: ChromeInstance): Promise<PageTarget[]> {
  const res = await fetch(`http://127.0.0.1:${instance.port}/json/list`)
  if (!res.ok) throw new Error(`dsh-ego-browser: /json/list HTTP ${res.status}`)
  const list = (await res.json()) as PageTarget[]
  return list
}

/** Lazily obtain (or restart) the current Chrome instance. */
export async function getChrome(): Promise<ChromeInstance> {
  if (current && !current.dead) return current
  if (current) {
    // Dead instance: reclaim before relaunching.
    disposeChrome().catch(() => {})
  }
  if (!launching) {
    launching = launchChrome().finally(() => {
      launching = null
    })
  }
  const instance = await launching
  current = instance
  return instance
}

/**
 * Adopt an externally started instance as the shared one (test seam: a test that
 * launched Chrome itself can hand it to the ws-cdp transport so `sendRaw` talks
 * to the same browser). Any previous shared instance is torn down first.
 */
export function adoptChrome(instance: ChromeInstance): void {
  const previous = current
  current = instance
  if (previous && previous !== instance) {
    void (async () => {
      const { process: proc, profileDir } = previous
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      } catch {
        // already gone
      }
      rmSync(profileDir, { recursive: true, force: true })
    })()
  }
}

/**
 * Tear down the current Chrome instance: SIGTERM → SIGKILL, then remove the
 * temp profile. Idempotent and safe to call multiple times.
 */
export async function disposeChrome(): Promise<void> {
  const instance = current
  current = null
  if (!instance) return
  instance.dead = true
  const { process: proc, profileDir } = instance
  try {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM')
      await Promise.race([
        new Promise<void>(resolve => proc.once('exit', () => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, 1500)),
      ])
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL')
      }
    }
  } catch {
    // Process already gone.
  }
  await new Promise(r => setTimeout(r, 50))
  rmSync(profileDir, { recursive: true, force: true })
}
