/**
 * Download path contracts: page.screenshot and page.fetch saveAs demand an
 * absolute path before any browser work, one download waiter per target owns a
 * temporary directory, and disposal restores download behavior and removes the
 * directory. Assertions adapted from upstream ego-lite
 * `sdk-lifecycle.test.mjs`; no live download is started.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createTaskSpaceHandle } from '../src/runtime/page-model.ts'
import {
  disposeDownloadArtifacts,
  preparePageDownload,
  type DownloadInterception,
} from '../src/runtime/driver/downloads.ts'

/** A download lifecycle event as the Page event channel delivers it. */
type DownloadEvent = { method: string; params: Record<string, unknown> }

const liveWaiters: DownloadInterception[] = []

afterEach(async () => {
  await Promise.all(liveWaiters.map(waiter => waiter.dispose()))
  liveWaiters.length = 0
  disposeDownloadArtifacts()
})

describe('download path validation', () => {
  it('rejects relative screenshot and fetch saveAs paths before any page work', async () => {
    const page = createTaskSpaceHandle({ id: 1, name: 'paths' }).page('p1')

    await expect(page.screenshot({ path: 'relative.png' })).rejects.toThrow(
      /page\.screenshot path must be an absolute file path/,
    )
    await expect(
      page.fetch('/image.png', { saveAs: './image.png' }),
    ).rejects.toThrow(/page\.fetch saveAs must be an absolute file path/)
  })

  it('arms one download waiter per target on a fresh temporary directory', async () => {
    const downloadPaths: string[] = []
    const waiter = preparePageDownload(
      {
        cdp: async (_method, params) => {
          if (typeof params?.downloadPath === 'string') {
            downloadPaths.push(params.downloadPath)
          }
          return {}
        },
        subscribePageEvents: () => () => {},
      },
      'target-arm',
      { timeoutMs: 10_000 },
    )
    liveWaiters.push(waiter)

    await waiter.ready('session-arm')
    expect(downloadPaths).toHaveLength(1)
    expect(downloadPaths[0]?.startsWith(tmpdir())).toBe(true)
    expect(existsSync(downloadPaths[0] ?? '')).toBe(true)

    expect(() =>
      preparePageDownload(
        {
          cdp: async () => ({}),
          subscribePageEvents: () => () => {},
        },
        'target-arm',
        { timeoutMs: 10_000 },
      ),
    ).toThrow(/already waiting for a download/)
  })

  it('disposal restores download behavior and removes the temporary directory', async () => {
    const behaviors: string[] = []
    const downloadPaths: string[] = []
    let emit: ((event: DownloadEvent) => void) | undefined
    const waiter = preparePageDownload(
      {
        cdp: async (method, params) => {
          if (
            method === 'Page.setDownloadBehavior' &&
            typeof params?.behavior === 'string'
          ) {
            behaviors.push(params.behavior)
          }
          if (typeof params?.downloadPath === 'string') {
            downloadPaths.push(params.downloadPath)
          }
          return {}
        },
        subscribePageEvents: (_targetId, listener) => {
          emit = listener
          return () => {}
        },
      },
      'target-dispose',
      { timeoutMs: 10_000 },
    )
    liveWaiters.push(waiter)
    await waiter.ready('session-dispose')

    emit?.({
      method: 'Page.downloadWillBegin',
      params: {
        guid: 'download-guid',
        url: 'https://example.com/file.zip',
        suggestedFilename: 'file.zip',
      },
    })
    const artifact = await waiter.event
    await expect(artifact.saveAs('relative.zip')).rejects.toThrow(
      /download\.saveAs requires an absolute file path/,
    )

    await waiter.dispose()
    expect(behaviors).toEqual(['allow', 'default'])
    expect(existsSync(downloadPaths[0] ?? '')).toBe(false)
  })

  it('disposeDownloadArtifacts sweeps every pending waiter and its files', async () => {
    const downloadPaths: string[] = []
    const cdp = async (_method: string, params?: Record<string, unknown>) => {
      if (typeof params?.downloadPath === 'string') {
        downloadPaths.push(params.downloadPath)
      }
      return {}
    }
    const first = preparePageDownload(
      { cdp, subscribePageEvents: () => () => {} },
      'target-sweep-1',
      { timeoutMs: 10_000 },
    )
    const second = preparePageDownload(
      { cdp, subscribePageEvents: () => () => {} },
      'target-sweep-2',
      { timeoutMs: 10_000 },
    )
    liveWaiters.push(first, second)
    await first.ready('session-sweep-1')
    await second.ready('session-sweep-2')

    disposeDownloadArtifacts()

    expect(downloadPaths).toHaveLength(2)
    for (const path of downloadPaths) expect(existsSync(path)).toBe(false)
    await expect(first.event).rejects.toThrow(/download waiter was disposed/)
    await expect(second.event).rejects.toThrow(/download waiter was disposed/)
  })
})
