// @ts-nocheck — ported from ego-browser v2.1.0-beta.2 (strict:false); vendor exemption, not strict-checked.
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { loadEnvFile as loadNodeEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SRC_DIR, '..')

/**
 * Resolve the ego-browser agent workspace: `EGO_BROWSER_AGENT_WORKSPACE` with
 * a leading `~` expanded when set, otherwise the `agent-skills/ego-browser`
 * directory beside this module when present, otherwise `skills/ego-browser` at
 * the repository root.
 * @returns Absolute workspace path; the last fallback is returned without an existence check.
 */
export function agentWorkspace(): string {
  if (process.env.EGO_BROWSER_AGENT_WORKSPACE) {
    return resolvePath(process.env.EGO_BROWSER_AGENT_WORKSPACE)
  }

  const bundledSkill = resolve(SRC_DIR, 'agent-skills', 'ego-browser')
  if (existsSync(bundledSkill)) {
    return bundledSkill
  }

  return resolve(REPO_ROOT, '..', '..', 'skills', 'ego-browser')
}

function resolvePath(path) {
  if (path.startsWith('~')) {
    return resolve(
      process.env.HOME || process.env.USERPROFILE || '.',
      path.slice(1),
    )
  }
  return resolve(path)
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    return
  }
  loadNodeEnvFile(path)
}

/**
 * Load the repository root `.env` and the agent workspace `.env` into
 * `process.env`; absent files are skipped.
 */
export function loadEnv(): void {
  loadEnvFile(resolve(REPO_ROOT, '.env'))
  loadEnvFile(resolve(agentWorkspace(), '.env'))
}
