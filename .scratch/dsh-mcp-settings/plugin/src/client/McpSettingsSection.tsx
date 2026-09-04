import { useEffect, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { McpLocaleKey } from './locales.ts'
import { SERVER_NAME_PATTERN, type McpConfigRowStatusWire, type McpServerEntryWire, type McpServersSectionWire, type McpServerStatusWire, type McpTransport } from '../wire.ts'

/** Host status view consumed by the section. */
export interface McpStatusView {
  servers: Record<string, McpServerStatusWire>
  configRows: McpConfigRowStatusWire[]
}

/** Registration-side face: mirror reads plus granular, path-addressed writes. */
export interface McpSettingsSectionInjected {
  /** Current sync snapshot of the `mcp-servers` namespace. */
  getSnapshot: () => SettingsScopeSnapshot<McpServersSectionWire>
  /** Observe snapshot replacements; returns the disposer. */
  subscribe: (listener: () => void) => () => void
  /** Add one server (entry fields only; absent secret fields stay absent). */
  addServer: (name: string, entry: McpServerEntryWire) => Promise<void>
  /** Patch selected fields of one server; absent fields stay stored. */
  patchServer: (name: string, changed: Partial<McpServerEntryWire>) => Promise<void>
  /** Write one server's enabled flag. */
  toggleServer: (name: string, enabled: boolean) => Promise<void>
  /** Remove one server entirely. */
  removeServer: (name: string) => Promise<void>
  /** Read the Host status projection (badges + config rows). */
  fetchStatus: () => Promise<McpStatusView>
  /** Toggle one patch-configured (loader) mcp-client row. */
  toggleConfigRow: (serverName: string, enabled: boolean) => Promise<void>
}

/** Full component props assembled by the Settings slot renderer. */
export type McpSettingsSectionProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<'settings.mcp'>
  & McpSettingsSectionInjected

type FormError = { readonly kind: 'locale'; readonly key: McpLocaleKey; readonly args?: Record<string, string> }
  | { readonly kind: 'host'; readonly message: string }

/** One-line summary of a server's transport target for the list row. */
function describeEntry(entry: McpServerEntryWire): string {
  if (entry.transport === 'stdio') {
    return [entry.command ?? '', ...(entry.args ?? [])].join(' ').trim()
  }
  return entry.url ?? ''
}

/** A malformed KEY=VALUE line: carries the 1-based line number for the form error. */
class ParseKvError extends Error {
  constructor(readonly line: number) {
    super(`parseKvError at line ${line}`)
  }
}

/** Parse KEY=VALUE lines; returns absent when the text is blank. @throws {ParseKvError} on malformed lines. */
function parseKvLines(text: string): Record<string, string> | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const out: Record<string, string> = {}
  for (const [index, line] of trimmed.split('\n').map(l => l.trim()).entries()) {
    if (line === '') continue
    const at = line.indexOf('=')
    if (at <= 0) throw new ParseKvError(index + 1)
    out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

/** Poll cadence for the Host status projection. */
const STATUS_POLL_MS = 3000

const inputStyle: CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 6,
  border: '1px solid var(--color-border, #444)', background: 'var(--color-bg-input, transparent)',
  color: 'inherit', fontFamily: 'var(--font-mono, monospace)', fontSize: 13, boxSizing: 'border-box',
}
const labelStyle: CSSProperties = { display: 'block', fontSize: 12, opacity: 0.75, margin: '10px 0 4px' }
const hintStyle: CSSProperties = { fontSize: 12, opacity: 0.6, marginTop: 2 }
const rowStyle: CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--color-border, #333)' }
const primaryButtonStyle: CSSProperties = { padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--color-accent, #2f6feb)', color: '#fff', cursor: 'pointer' }
const ghostButtonStyle: CSSProperties = { padding: '4px 10px', borderRadius: 6, border: '1px solid var(--color-border, #444)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 }
const errorStyle: CSSProperties = { color: 'var(--color-danger, #e5534b)', fontSize: 12, marginTop: 8, whiteSpace: 'pre-wrap' }

interface DraftState {
  transport: McpTransport
  command: string
  args: string
  cwd: string
  url: string
  env: string
  headers: string
}

const emptyDraft: DraftState = { transport: 'stdio', command: '', args: '', cwd: '', url: '', env: '', headers: '' }

/** Field order for zeroing state when the form closes. */
function blankDraft(): DraftState { return { ...emptyDraft } }

export function McpSettingsSection({
  getSnapshot, subscribe, addServer, patchServer, toggleServer, removeServer, fetchStatus, toggleConfigRow, t,
}: McpSettingsSectionProps): ReactNode {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  const [statuses, setStatuses] = useState<McpStatusView>({ servers: {}, configRows: [] })
  const [open, setOpen] = useState(false)
  const [editName, setEditName] = useState<string | undefined>(undefined)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<FormError | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<DraftState>(blankDraft)

  const servers = snapshot.value?.servers ?? {}

  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void fetchStatus().then(next => { if (alive) setStatuses(next) }).catch(() => { /* transient poll failure */ })
    }
    tick()
    const timer = setInterval(tick, STATUS_POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [fetchStatus])

  function openAdd(): void {
    setEditName(undefined)
    setName('')
    setDraft(blankDraft())
    setError(undefined)
    setOpen(true)
  }

  function openEdit(target: string): void {
    const current = servers[target]
    if (current === undefined) return
    setEditName(target)
    setName(target)
    setDraft({
      transport: current.transport,
      command: current.command ?? '',
      args: (current.args ?? []).join('\n'),
      cwd: current.cwd ?? '',
      url: current.url ?? '',
      // Secret values are redacted on the wire: show blank, keep-on-blank.
      env: '',
      headers: '',
    })
    setError(undefined)
    setOpen(true)
  }

  async function run(op: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError(undefined)
    try {
      await op()
      setOpen(false)
      setConfirmDelete(undefined)
    } catch (reason) {
      setError({ kind: 'host', message: String(reason instanceof Error ? reason.message : reason) })
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (editName === undefined) {
      if (!SERVER_NAME_PATTERN.test(name)) return setError({ kind: 'locale', key: 'invalidName' })
      if (name in servers) return setError({ kind: 'locale', key: 'nameTaken' })
      if (draft.transport === 'stdio' && !draft.command.trim()) return setError({ kind: 'locale', key: 'missingCommand' })
      if (draft.transport === 'streamable-http' && !draft.url.trim()) return setError({ kind: 'locale', key: 'missingUrl' })
    }
    let env: Record<string, string> | undefined
    let headers: Record<string, string> | undefined
    try {
      env = parseKvLines(draft.env)
      headers = parseKvLines(draft.headers)
    } catch (reason) {
      if (reason instanceof ParseKvError) {
        return setError({ kind: 'locale', key: 'parseKvError', args: { line: String(reason.line) } })
      }
      throw reason
    }
    if (editName === undefined) {
      await run(() => addServer(name, {
        transport: draft.transport,
        ...draft.transport === 'stdio'
          ? { command: draft.command.trim(), args: draft.args.split('\n').map(l => l.trim()).filter(Boolean), cwd: draft.cwd.trim() }
          : { url: draft.url.trim() },
        ...env === undefined ? {} : { env },
        ...headers === undefined ? {} : { headers },
      }))
      return
    }
    await run(() => patchServer(editName, entryPatch(draft, env, headers)))
  }

  return <div style={{ padding: '4px 2px' }}>
    <h2 style={{ fontSize: 15, margin: '8px 0 2px' }}>{t('title')}</h2>
    <p style={hintStyle}>{t('subtitle')}</p>

    {Object.keys(servers).length === 0
      ? <p style={{ opacity: 0.7, fontSize: 13 }}>{t('empty')}</p>
      : <div>{Object.entries(servers).map(([serverName, value]) => (
        <div key={serverName} style={rowStyle}>
          <span style={{ fontWeight: 600 }}>{serverName}</span>
          <span style={{
            flex: 1, opacity: 0.75, fontFamily: 'var(--font-mono, monospace)', fontSize: 12,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{describeEntry(value)}</span>
          <StatusBadge status={statuses.servers[serverName]} enabled={value.enabled !== false} t={t} />
          {value.enabled === false
            ? <span style={{ fontSize: 12, opacity: 0.6 }}>{t('disabledTag')}</span>
            : <span style={{ fontSize: 12, opacity: 0.6 }}>{value.transport === 'stdio' ? 'stdio' : 'http'}</span>}
          <button type="button" style={ghostButtonStyle} onClick={() => {
            void run(() => toggleServer(serverName, value.enabled === false))
          }}>{value.enabled === false ? t('enabled') : t('disabledTag')}</button>
          <button type="button" style={ghostButtonStyle} onClick={() => openEdit(serverName)}>{t('edit')}</button>
          {confirmDelete === serverName
            ? <>
              <span style={{ fontSize: 12 }}>{t('confirmDelete')}</span>
              <button type="button" style={ghostButtonStyle} onClick={() => { void run(() => removeServer(serverName)) }}>{t('confirmYes')}</button>
              <button type="button" style={ghostButtonStyle} onClick={() => setConfirmDelete(undefined)}>{t('confirmNo')}</button>
            </>
            : <button type="button" style={ghostButtonStyle} onClick={() => setConfirmDelete(serverName)}>{t('delete')}</button>}
        </div>
      ))}</div>}

    {statuses.configRows.length > 0 && <div style={{ marginTop: 10 }}>
      <p style={{ fontSize: 12, opacity: 0.6, margin: '6px 0' }}>{t('configRowsTitle')}</p>
      {statuses.configRows.map(row => (
        <div key={row.serverName} style={rowStyle}>
          <span style={{ fontWeight: 600 }}>{row.serverName}</span>
          <span style={{ fontSize: 12, opacity: 0.6 }}>{t('configSourceTag')}</span>
          <span style={{ flex: 1 }} />
          <StatusBadge
            status={row.enabled ? { enabled: true, toolCount: row.toolCount } : { enabled: false, toolCount: 0 }}
            enabled={row.enabled}
            t={t} />
          <button type="button" style={ghostButtonStyle} onClick={() => {
            void run(() => toggleConfigRow(row.serverName, !row.enabled))
          }}>{row.enabled ? t('disabledTag') : t('enabled')}</button>
        </div>
      ))}
    </div>}

    {open
      ? <form style={{ marginTop: 14, border: '1px solid var(--color-border, #444)', borderRadius: 8, padding: 12 }} onSubmit={event => void submit(event)}>
        <strong style={{ fontSize: 13 }}>{editName === undefined ? t('formAddTitle') : t('formEditTitle')}</strong>
        <label style={labelStyle} htmlFor="mcp-form-name">{t('nameLabel')}</label>
        <input id="mcp-form-name" style={inputStyle} value={name} disabled={editName !== undefined}
          onChange={e => setName(e.target.value)} />
        {editName !== undefined && <p style={hintStyle}>{t('nameHint')}</p>}
        <label style={labelStyle} htmlFor="mcp-form-transport">{t('transportLabel')}</label>
        <select id="mcp-form-transport" style={inputStyle} value={draft.transport}
          onChange={e => setDraft(d => ({ ...d, transport: e.target.value as McpTransport }))}>
          <option value="stdio">{t('transportStdio')}</option>
          <option value="streamable-http">{t('transportHttp')}</option>
        </select>
        {draft.transport === 'stdio' ? <>
          <label style={labelStyle} htmlFor="mcp-form-command">{t('commandLabel')}</label>
          <input id="mcp-form-command" style={inputStyle} placeholder={t('commandPlaceholder')}
            value={draft.command} onChange={e => setDraft(d => ({ ...d, command: e.target.value }))} />
          <label style={labelStyle} htmlFor="mcp-form-args">{t('argsLabel')}</label>
          <textarea id="mcp-form-args" style={{ ...inputStyle, minHeight: 48 }}
            value={draft.args} onChange={e => setDraft(d => ({ ...d, args: e.target.value }))} />
          <label style={labelStyle} htmlFor="mcp-form-cwd">{t('cwdLabel')}</label>
          <input id="mcp-form-cwd" style={inputStyle} value={draft.cwd}
            onChange={e => setDraft(d => ({ ...d, cwd: e.target.value }))} />
        </> : <>
          <label style={labelStyle} htmlFor="mcp-form-url">{t('urlLabel')}</label>
          <input id="mcp-form-url" style={inputStyle} placeholder={t('urlPlaceholder')}
            value={draft.url} onChange={e => setDraft(d => ({ ...d, url: e.target.value }))} />
        </>}
        {draft.transport === 'stdio' && <>
          <label style={labelStyle} htmlFor="mcp-form-env">{t('envLabel')}</label>
          <textarea id="mcp-form-env" style={{ ...inputStyle, minHeight: 48 }} value={draft.env}
            onChange={e => setDraft(d => ({ ...d, env: e.target.value }))} />
          <p style={hintStyle}>{t('envHint')}</p>
        </>}
        {draft.transport === 'streamable-http' && <>
          <label style={labelStyle} htmlFor="mcp-form-headers">{t('headersLabel')}</label>
          <textarea id="mcp-form-headers" style={{ ...inputStyle, minHeight: 48 }} value={draft.headers}
            onChange={e => setDraft(d => ({ ...d, headers: e.target.value }))} />
          <p style={hintStyle}>{t('headersHint')}</p>
        </>}
        {error !== undefined && <p style={errorStyle}>{error.kind === 'locale'
          ? (error.args === undefined ? t(error.key) : t(error.key, error.args))
          : error.message}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="submit" style={primaryButtonStyle} disabled={busy}>{busy ? t('saving') : t('save')}</button>
          <button type="button" style={ghostButtonStyle} onClick={() => { setOpen(false); setError(undefined) }}>{t('cancel')}</button>
        </div>
      </form>
      : <button type="button" style={{ ...primaryButtonStyle, marginTop: 12 }} onClick={openAdd}>{t('addButton')}</button>}
  </div>
}

/** Badge for one server row: 🟢 connected + tool count, 🔴 last error, ⚪ disabled, 🟡 starting. */
function StatusBadge({ status, enabled, t }: {
  status: McpServerStatusWire | undefined
  enabled: boolean
  t: (key: McpLocaleKey, args?: Record<string, string>) => string
}): ReactNode {
  if (!enabled) return <span style={{ fontSize: 12, opacity: 0.6 }} title={t('statusDisabled')}>⚪ {t('statusDisabled')}</span>
  if (status === undefined) return <span style={{ fontSize: 12, opacity: 0.6 }}>🟡 {t('statusStarting')}</span>
  if (status.error !== undefined) {
    return <span style={{ fontSize: 12, color: 'var(--color-danger, #e5534b)' }} title={status.error}>🔴 {t('statusError')}</span>
  }
  return <span style={{ fontSize: 12 }} title={t('statusConnected')}>🟢 {status.toolCount} {t('statusTools')}</span>
}

/**
 * Build the edit patch: only fields whose storage keys the form can rewrite,
 * leaving secret-bearing maps absent so stored values survive. Whole-map
 * writes for env/headers happen only when the user typed KEY=VALUE lines
 * (already parsed by the caller).
 * @param draft - the draft form state.
 * @param env - parsed environment lines; absent when the field stayed blank.
 * @param headers - parsed header lines; absent when the field stayed blank.
 */
function entryPatch(draft: DraftState, env: Record<string, string> | undefined, headers: Record<string, string> | undefined): Partial<McpServerEntryWire> {
  if (draft.transport === 'stdio') {
    return {
      transport: 'stdio',
      ...draft.command.trim() === '' ? {} : { command: draft.command.trim() },
      ...draft.args.trim() === '' ? {} : { args: draft.args.split('\n').map(l => l.trim()).filter(Boolean) },
      ...draft.cwd.trim() === '' ? {} : { cwd: draft.cwd.trim() },
      ...env === undefined ? {} : { env },
    }
  }
  return {
    transport: 'streamable-http',
    ...draft.url.trim() === '' ? {} : { url: draft.url.trim() },
    ...headers === undefined ? {} : { headers },
  }
}
