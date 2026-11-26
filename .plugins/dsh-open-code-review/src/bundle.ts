/**
 * File bundling: deterministic clustering of related changed files into review
 * bundles. Files in one bundle travel to one isolated review worker, so
 * cross-file observations stay in one context. Bundles mirror the OpenCodeReview
 * grouping heuristics — resource/i18n variants, basename companions, and
 * same-directory concern clusters — with a hard per-bundle file cap.
 * @module @dsh-external/dsh-open-code-review/bundle
 */

import type { ReviewBundle, ReviewTarget } from './types.ts'

/** Hard cap per bundle (the OpenCodeReview grouping limit). */
const MAX_BUNDLE_FILES = 10

/** Directory cluster threshold: only nearby counts cluster by directory. */
const MAX_DIRECTORY_CLUSTER = 6

/**
 * Trailing locale/region tag before the extension: `en`, `zh_CN`, `pt_BR`,
 * `zh-TW`, … Region is exactly two letters so unrelated suffixes such as
 * `_next` cannot masquerade as one.
 */
const LOCALE_TAG = /[._-][A-Za-z]{2}(?:[._-][A-Za-z]{2})?$/

/** Test-file companion suffixes joined to their subject file. */
const COMPANION_SUFFIX = /\.(test|spec|mock|fixture|config|dao|mapper|impl|service|handler|controller)(?=[.]|$)/i

/**
 * Normalize a path to its variant key: a trailing locale/region tag is
 * stripped from the basename stem, so `messages_en.properties` and
 * `messages_zh_CN.properties` share one key.
 * @param path - Repository-relative file path.
 * @returns The variant-normalized key.
 */
function variantKey(path: string): string {
  const slash = path.lastIndexOf('/')
  const dir = slash === -1 ? '' : path.slice(0, slash + 1)
  const base = slash === -1 ? path : path.slice(slash + 1)
  const dot = base.lastIndexOf('.')
  const stem = dot <= 0 ? base : base.slice(0, dot)
  const ext = dot <= 0 ? '' : base.slice(dot)
  const stripped = stem.replace(LOCALE_TAG, '')
  return dir + (stripped === '' ? stem : stripped) + ext
}

/**
 * The subject stem of a path (directory + name without companion/extension).
 * @param path - Repository-relative file path.
 * @returns The subject key used for companion grouping.
 */
function subjectKey(path: string): string {
  const slash = path.lastIndexOf('/')
  const dir = slash === -1 ? '' : path.slice(0, slash + 1)
  const base = slash === -1 ? path : path.slice(slash + 1)
  const stripped = base.replace(COMPANION_SUFFIX, '').replace(/\.[^.]+$/, '')
  return dir + stripped
}

/**
 * Group review targets into bundles. Order is stable: targets are claimed in
 * input order by their first bundle key, then leftovers cluster by directory
 * when small enough, and any remainder becomes single-file bundles. Every
 * input appears in exactly one bundle.
 * @param targets - Selected review targets.
 * @returns Bundles with generated ids and short labels.
 */
export function bundleTargets(targets: ReviewTarget[]): ReviewBundle[] {
  const bundles: ReviewBundle[] = []
  const claimed = new Set<string>()

  const push = (label: string, files: string[]): void => {
    bundles.push({ id: bundles.length + 1, label, files })
  }

  // Pass 1: resource/i18n variants (same normalized key, differing paths).
  const byVariant = new Map<string, string[]>()
  for (const target of targets) {
    const key = variantKey(target.path)
    const bucket = byVariant.get(key) ?? []
    bucket.push(target.path)
    byVariant.set(key, bucket)
  }
  for (const [key, files] of byVariant) {
    if (files.length < 2) continue
    push(`resource variants of ${shortName(key)}`, files.slice(0, MAX_BUNDLE_FILES))
    for (const file of files.slice(0, MAX_BUNDLE_FILES)) claimed.add(file)
  }

  // Pass 2: basename companions (implementation + test/impl/mapper siblings).
  const bySubject = new Map<string, string[]>()
  for (const target of targets) {
    if (claimed.has(target.path)) continue
    const key = subjectKey(target.path)
    const bucket = bySubject.get(key) ?? []
    bucket.push(target.path)
    bySubject.set(key, bucket)
  }
  for (const [key, files] of bySubject) {
    if (files.length < 2) continue
    push(`companions of ${shortName(key)}`, files.slice(0, MAX_BUNDLE_FILES))
    for (const file of files.slice(0, MAX_BUNDLE_FILES)) claimed.add(file)
  }

  // Pass 3: same-directory clusters up to the cluster threshold.
  const byDirectory = new Map<string, string[]>()
  for (const target of targets) {
    if (claimed.has(target.path)) continue
    const slash = target.path.lastIndexOf('/')
    const dir = slash === -1 ? '.' : target.path.slice(0, slash)
    const bucket = byDirectory.get(dir) ?? []
    bucket.push(target.path)
    byDirectory.set(dir, bucket)
  }
  for (const [dir, files] of byDirectory) {
    if (files.length < 2) continue
    for (let i = 0; i < files.length; i += MAX_DIRECTORY_CLUSTER) {
      const chunk = files.slice(i, i + MAX_DIRECTORY_CLUSTER)
      push(`files in ${dir === '.' ? 'repository root' : dir}`, chunk)
      for (const file of chunk) claimed.add(file)
    }
  }

  // Pass 4: everything remaining travels alone.
  for (const target of targets) {
    if (claimed.has(target.path)) continue
    push(shortName(target.path), [target.path])
    claimed.add(target.path)
  }

  return bundles
}

/** Short display name for a label: the last path segment. */
function shortName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? path : path.slice(slash + 1)
}
