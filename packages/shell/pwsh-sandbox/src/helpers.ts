/**
 * Shell-result projection over shared sandbox diagnostics. The pwsh consumer
 * and the bash one classify the same runner-failure dialect, so both project
 * it from `@deepseek-ai/dsh-sandbox` instead of carrying their own copy.
 *
 * @module @deepseek-ai/dsh-pwsh-sandbox/helpers
 */
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import { matchesSignature } from '@deepseek-ai/dsh-sandbox'
export { isRunnerSpawnFailure, classifyRunnerFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'

/**
 * Classify a failed run against the selected backend's denial dialect.
 * @param result - settled foreground run.
 * @param signatures - case-insensitive denial substrings from the active wrap.
 * @returns whether the failed run matches that denial dialect.
 */
export function classifyDenial(result: ShellRunResult, signatures: readonly string[]): boolean {
  return matchesSignature(result.exitCode, result.stderr.text, signatures)
}
