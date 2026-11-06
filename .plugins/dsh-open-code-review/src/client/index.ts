/**
 * @dsh-external/dsh-open-code-review — client findings view.
 * Registers one `conversation.view` list entry that fetches the host's
 * last-run record from `GET /@dsh-external/dsh-open-code-review/api/last-run`
 * and renders review findings grouped by severity. The component is a plain
 * React function component (the slot renderer's contract); `register` takes
 * the options object and the component as two separate arguments.
 * @module @dsh-external/dsh-open-code-review/client
 */

import { createElement, useEffect, useState } from 'react'
import type { FC } from 'react'
import type { SlotsService, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { dictionaries } from './locales.ts'
import { SEVERITIES } from '../vocabulary.ts'
import { FINDINGS_LAST_RUN_PATH, findingLine } from '../findings.ts'

/** Last-run record shape served by the host API: the read-side wire fields. */
interface RunRecord {
  kind?: 'review' | 'scan' | null
  at?: string
  payload?: {
    mode?: string
    findings?: Array<{
      path: string
      startLine?: number
      endLine?: number
      severity?: string
      category?: string
      content: string
      suggestion?: string
      positionVerified?: boolean
    }>
    coverage?: { total: number; reviewed: number; rate: number }
  }
}

const styles = {
  root: { padding: '12px', fontFamily: 'ui-monospace, monospace', fontSize: '12px', lineHeight: '1.5' },
  heading: { margin: '0 0 8px' },
  meta: { opacity: 0.7, marginBottom: '12px' },
  section: { margin: '12px 0 4px', fontWeight: 'bold' },
  finding: { margin: '6px 0', paddingLeft: '8px', borderLeft: '2px solid #8884' },
  suggestion: { opacity: 0.8, paddingLeft: '8px' },
  error: { color: '#b00020' },
} as const

/** The findings view: fetch the last run once on mount and render it. */
const OcrFindingsView: FC<{ t: Translate }> = ({ t }) => {
  const [record, setRecord] = useState<RunRecord | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(FINDINGS_LAST_RUN_PATH)
      .then(response => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data: RunRecord) => {
        if (!cancelled) setRecord(data)
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(String(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return createElement('div', { style: styles.root }, renderBody(record, failure, t))
}

/** Render the fetched record, its failure, or the empty state. */
function renderBody(record: RunRecord | null, failure: string | null, t: Translate): Array<ReturnType<typeof createElement>> {
  if (failure !== null) {
    return [createElement('div', { key: 'err', style: styles.error }, t('error', { message: failure }))]
  }
  if (record === null) {
    return [createElement('div', { key: 'loading' }, t('loading'))]
  }
  if (record.kind === undefined || record.kind === null) {
    return [createElement('div', { key: 'empty' }, t('noRun'))]
  }
  const payload = record.payload
  const nodes: Array<ReturnType<typeof createElement>> = [
    createElement('div', { key: 'head', style: styles.heading }, `OpenCodeReview — ${record.kind}${payload?.mode !== undefined ? ` (${payload.mode})` : ''}`),
  ]
  if (record.at !== undefined) {
    nodes.push(createElement('div', { key: 'at', style: styles.meta }, record.at))
  }
  const findings = payload?.findings ?? []
  const coverage = payload?.coverage
  if (coverage !== undefined) {
    nodes.push(createElement('div', { key: 'cov', style: styles.meta },
      t('coverage', { reviewed: coverage.reviewed, total: coverage.total, rate: coverage.rate })))
  }
  if (findings.length === 0) {
    nodes.push(createElement('div', { key: 'none' }, t('noFindings')))
    return nodes
  }
  for (const severity of SEVERITIES) {
    const bucket = findings.filter(finding => finding.severity === severity)
    if (bucket.length === 0) continue
    nodes.push(createElement('div', { key: `sec-${severity}`, style: styles.section }, `${severity} (${bucket.length})`))
    for (const [index, finding] of bucket.entries()) {
      nodes.push(createElement('div', { key: `${severity}-${index}`, style: styles.finding },
        findingLine(finding, t('unverified'))))
      if (finding.suggestion !== undefined) {
        nodes.push(createElement('div', { key: `${severity}-${index}-s`, style: styles.suggestion },
          t('suggestion', { text: finding.suggestion })))
      }
    }
  }
  return nodes
}

export const inject = ['slots', 'locale']

/** Locale namespace owning the findings view copy. */
const NS = 'ocrFindings'

/**
 * Mount the findings view into the conversation view list.
 * @param ctx - Client context carrying `ctx.slots` and `ctx.locale`.
 */
export function apply(ctx: { slots: SlotsService; locale: LocaleRuntime }): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), '@dsh-external/dsh-open-code-review: dictionaries')
  const t = ctx.locale.bind(NS)
  const view: FC = () => createElement(OcrFindingsView, { t })
  ctx.effect(() => ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: '@dsh-external/dsh-open-code-review-findings',
      order: 10,
      locale: NS,
      label: () => 'OpenCodeReview',
    }, view),
  ), '@dsh-external/dsh-open-code-review: findings view')
}
