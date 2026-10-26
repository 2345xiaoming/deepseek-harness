// @ts-nocheck — ported from ego-browser v2.1.0 (strict:false); vendor exemption, not strict-checked.
import { writeFile } from 'node:fs/promises'

import { agentWorkspace, loadEnv } from './env.ts'

loadEnv()

/** Instance name for this process, from `EGO_BROWSER_NAME` (default `'default'`). */
export const NAME = process.env.EGO_BROWSER_NAME || 'default'

/**
 * Mutable process-wide state shared by the ported browser helpers: clock,
 * sleep, platform, agent workspace, file writer, preferred page target, and
 * the observed Network-domain flag. Tests replace fields through
 * {@link setOverrides}.
 */
export const state = {
  cdpOverride: null,
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  platform: process.platform,
  agentWorkspace: () => agentWorkspace(),
  writeFile,
  preferredTargetId: null,
  // Last observed Network domain state on the default session (tracked in cdp()).
  networkDomainEnabled: false,
}

/**
 * Replace fields on the shared {@link state} object.
 * @param overrides - Fields to assign onto `state`, including the `cdpOverride` transport.
 * @returns a restorer that puts back the values held before this call.
 */
export function setOverrides(overrides): () => void {
  const previous = { ...state }
  Object.assign(state, overrides)
  return () => {
    Object.assign(state, previous)
  }
}
