/**
 * Regression tests for three bridge defects found against real Chrome:
 * viewport scoping that returned the whole page, navigation failures reported as
 * success, and a task-space shim that dropped every created space.
 *
 * `buildSnapshot` and the shim are exercised in-process; the navigation tests
 * drive the real `gotoAndWait` through the state override that stands in for the
 * browser, so no Chrome is launched here.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { buildSnapshot } from '../src/bridge/snapshot.ts'
import { installEgoBridge } from '../src/bridge/ws-cdp.ts'
import { gotoAndWait } from '../src/runtime/driver/nav.ts'
import { setOverrides } from '../src/runtime/state.ts'

/** Task-space descriptor as the shim returns it. */
interface SpaceDescriptor {
  taskId: number
  id: number
  name: string
  ownership: string
}

/** The task-space subset of the installed bridge this suite drives. */
interface TaskSpaceHost {
  listTaskSpaces(): Promise<{ taskSpaces: SpaceDescriptor[] }>
  createTaskSpace(name: string): Promise<SpaceDescriptor>
  useTaskSpace(id: number): Promise<unknown>
  claimTaskSpace(id?: number, name?: string): Promise<SpaceDescriptor>
  closeTaskSpace(): Promise<unknown>
  handOffTaskSpace(): Promise<unknown>
  takeOverTaskSpace(): Promise<SpaceDescriptor>
}

/** Minimal AX forest: `h1`, a button, and an off-screen button. */
function axTree() {
  return [
    { nodeId: '1', role: { value: 'RootWebArea' }, backendDOMNodeId: 1, childIds: ['2', '3', '4'] },
    { nodeId: '2', role: { value: 'heading' }, name: { value: 'Title' }, backendDOMNodeId: 2 },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Visible' }, backendDOMNodeId: 3 },
    { nodeId: '4', role: { value: 'button' }, name: { value: 'Offscreen' }, backendDOMNodeId: 4 },
  ]
}

describe('viewport-scoped snapshots', () => {
  it('keeps the whole tree when no viewport is given', () => {
    const snapshot = buildSnapshot(axTree())
    expect(snapshot.content).toContain('Visible')
    expect(snapshot.content).toContain('Offscreen')
    expect(snapshot.refs).toHaveLength(4)
  })

  it('drops nodes whose boxes are outside the viewport', () => {
    const snapshot = buildSnapshot(axTree(), new Set([1, 2, 3]))
    expect(snapshot.content).toContain('Title')
    expect(snapshot.content).toContain('Visible')
    expect(snapshot.content).not.toContain('Offscreen')
    // The root keeps the ref it has always carried; only the off-screen button
    // loses its own.
    expect(snapshot.refs.map(r => r.backendNodeId)).toEqual([1, 2, 3])
  })

  it('keeps an unmeasured ancestor as the path to a visible descendant', () => {
    // The wrapper has no layout box of its own, so only its child proves the
    // subtree is on screen. Dropping the wrapper would orphan the child's line.
    const tree = [
      { nodeId: '1', role: { value: 'generic' }, backendDOMNodeId: 1, childIds: ['2'] },
      { nodeId: '2', role: { value: 'button' }, name: { value: 'Deep' }, backendDOMNodeId: 2 },
    ]
    const snapshot = buildSnapshot(tree, new Set([2]))
    expect(snapshot.content).toContain('Deep')
    expect(snapshot.refs.map(r => r.backendNodeId)).toEqual([2])
  })

  it('emits no line and no ref for an entirely off-screen subtree', () => {
    const tree = [
      { nodeId: '1', role: { value: 'RootWebArea' }, backendDOMNodeId: 1, childIds: ['2'] },
      {
        nodeId: '2',
        role: { value: 'generic' },
        backendDOMNodeId: 2,
        childIds: ['3'],
      },
      { nodeId: '3', role: { value: 'button' }, name: { value: 'Gone' }, backendDOMNodeId: 3 },
    ]
    const snapshot = buildSnapshot(tree, new Set([1]))
    expect(snapshot.content).not.toContain('Gone')
    expect(snapshot.refs.map(r => r.backendNodeId)).toEqual([1])
  })
})

describe('gotoAndWait navigation failures', () => {
  const restore: Array<() => void> = []
  afterEach(() => {
    while (restore.length) restore.pop()?.()
  })

  function stubNavigate(result: Record<string, unknown>): void {
    restore.push(
      setOverrides({
        cdpOverride: (method: string) => {
          if (method !== 'Page.navigate') throw new Error(`unexpected CDP ${method}`)
          return Promise.resolve(result)
        },
      }),
    )
  }

  it('throws with the CDP error text instead of reporting the URL as reached', async () => {
    stubNavigate({ frameId: 'F', errorText: 'net::ERR_CONNECTION_CLOSED' })
    await expect(gotoAndWait('https://unreachable.invalid/')).rejects.toThrow(
      /net::ERR_CONNECTION_CLOSED/,
    )
  })

  it('throws when the navigation starts a download', async () => {
    stubNavigate({ frameId: 'F', isDownload: true })
    await expect(gotoAndWait('https://example.com/file.zip')).rejects.toThrow(
      /download/,
    )
  })

  it('does not wait for load when wait is disabled', async () => {
    stubNavigate({ frameId: 'F' })
    const result = await gotoAndWait('https://example.com/', { wait: false })
    expect(result.loaded).toBe(false)
  })
})

describe('task-space shim registry', () => {
  function mount(): { host: TaskSpaceHost; restoreEgo: () => void } {
    const restoreEgo = installEgoBridge({
      snapshot: () => Promise.resolve({ content: '', refs: [] }),
      disposeChrome: () => Promise.resolve(),
    })
    const host = (globalThis as { ego?: TaskSpaceHost }).ego
    if (!host) throw new Error('installEgoBridge did not publish globalThis.ego')
    return { host, restoreEgo }
  }

  it('lists a created space and resolves it by name again', async () => {
    const { host, restoreEgo } = mount()
    try {
      const created = await host.createTaskSpace('probe')
      expect(created.name).toBe('probe')

      const listed = await host.listTaskSpaces()
      expect(listed.taskSpaces.map(s => s.name)).toContain('probe')

      // The id must resolve for selection, and re-creating the same name must
      // return that space rather than adding a duplicate.
      const again = await host.createTaskSpace('probe')
      expect(again.id).toBe(created.id)
      expect((await host.listTaskSpaces()).taskSpaces).toHaveLength(
        listed.taskSpaces.length,
      )
    } finally {
      restoreEgo()
    }
  })

  it('assigns distinct ids and switches the active space', async () => {
    const { host, restoreEgo } = mount()
    try {
      const first = await host.createTaskSpace('one')
      const second = await host.createTaskSpace('two')
      expect(second.id).not.toBe(first.id)

      await host.useTaskSpace(first.id)
      const claimed = await host.claimTaskSpace(first.id, 'one')
      expect(claimed.id).toBe(first.id)
      expect(claimed.ownership).toBe('agent')

      await expect(host.useTaskSpace(9999)).rejects.toThrow(/unknown task space/)
    } finally {
      restoreEgo()
    }
  })

  it('drops a closed space from the listing', async () => {
    const { host, restoreEgo } = mount()
    try {
      await host.createTaskSpace('closer')
      await host.closeTaskSpace()
      const names = (await host.listTaskSpaces()).taskSpaces.map(s => s.name)
      expect(names).not.toContain('closer')
    } finally {
      restoreEgo()
    }
  })

  it('hands a space to the user and takes it back', async () => {
    const { host, restoreEgo } = mount()
    try {
      await host.createTaskSpace('handoff')
      await host.handOffTaskSpace()
      const handed = (await host.listTaskSpaces()).taskSpaces.find(
        s => s.name === 'handoff',
      )
      expect(handed?.ownership).toBe('agentDelegatedToUser')
      const taken = await host.takeOverTaskSpace()
      expect(taken.ownership).toBe('agent')
    } finally {
      restoreEgo()
    }
  })

  it('seeds a default space on a fresh bridge', async () => {
    const { host, restoreEgo } = mount()
    try {
      const listed = await host.listTaskSpaces()
      expect(listed.taskSpaces).toHaveLength(1)
      expect(listed.taskSpaces[0]?.ownership).toBe('agent')
    } finally {
      restoreEgo()
    }
  })
})
