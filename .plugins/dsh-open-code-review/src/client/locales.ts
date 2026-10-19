/**
 * Locale-owned copy for the OpenCodeReview findings view. Every user-visible
 * string lives in these dictionaries; the view renders through the bound `t`.
 * @module @dsh-external/dsh-open-code-review/client/locales
 */

/** Dictionary keys for the findings view. */
export type OcrClientKey =
  | 'loading'
  | 'noRun'
  | 'noFindings'
  | 'coverage'
  | 'suggestion'
  | 'unverified'
  | 'error'

const en: Record<OcrClientKey, string> = {
  loading: 'OpenCodeReview: loading last run…',
  noRun: 'OpenCodeReview: no run recorded yet. Call ocr_review or ocr_scan.',
  noFindings: 'No findings.',
  coverage: 'coverage {reviewed}/{total} · rate {rate}',
  suggestion: 'suggestion: {text}',
  unverified: ' [position unverified]',
  error: 'OpenCodeReview: {message}',
}

const zh: Record<OcrClientKey, string> = {
  loading: 'OpenCodeReview：正在加载最近一次运行…',
  noRun: 'OpenCodeReview：尚无运行记录。调用 ocr_review 或 ocr_scan。',
  noFindings: '无 findings。',
  coverage: '覆盖率 {reviewed}/{total} · rate {rate}',
  suggestion: '建议：{text}',
  unverified: ' [位置未核实]',
  error: 'OpenCodeReview：{message}',
}

/** The dictionaries registered under the client namespace. */
export const dictionaries = { en, zh }
