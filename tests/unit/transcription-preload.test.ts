/**
 * The preload bridge for the transcript export.
 *
 * A channel without an entry in src/preload/index.ts is dead: the renderer
 * cannot reach `ipcRenderer` on its own, so `ipcMain.handle` alone registers a
 * handler nobody can call. Measured before this test was written: `grep -c
 * transcription src/preload/index.ts` found 0 while the positive control
 * `privacy` found 14 - four transcription channels existed and none of them
 * was reachable.
 *
 * This asserts the bridge BEHAVES, rather than that the file mentions the
 * channel name: it takes the object the preload hands to `contextBridge` and
 * calls through it, so a bridge wired to the wrong channel fails here.
 *
 * Only the export is covered, because only the export has a bridge. The other
 * four channels are still unreachable from the renderer - a separate decision,
 * not an oversight of this test.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

const { invocations, exposed } = vi.hoisted(() => ({
  invocations: [] as unknown[][],
  exposed: new Map<string, Record<string, unknown>>()
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>): void => {
      exposed.set(key, api)
    }
  },
  ipcRenderer: {
    invoke: (...args: unknown[]): Promise<unknown> => {
      invocations.push(args)
      return Promise.resolve({ success: true })
    },
    on: (): void => undefined,
    removeListener: (): void => undefined
  }
}))

import { IPC_CHANNELS } from '../../src/shared/types'

interface ContextIsolationFlag {
  contextIsolated?: boolean
}

interface TranscriptionBridge {
  export: (jobId: string, format: 'txt' | 'srt') => Promise<unknown>
}

describe('Preload-Bruecke fuer den Transkript-Export', () => {
  let previousIsolation: boolean | undefined

  beforeAll(async () => {
    const flag = process as unknown as ContextIsolationFlag
    previousIsolation = flag.contextIsolated
    // The preload refuses to expose anything without context isolation, and
    // a Node test process has none. Setting it is what makes the module run
    // its exposure path at all.
    flag.contextIsolated = true
    await import('../../src/preload/index')
  })

  afterAll(() => {
    ;(process as unknown as ContextIsolationFlag).contextIsolated = previousIsolation
  })

  it('reicht den Export an den Kanal transcription:export weiter', async () => {
    const api = exposed.get('electronAPI')
    expect(api).toBeDefined()
    // Positivkontrolle im selben Lauf: eine bestehende Bruecke ist da, die
    // Pruefung unten laeuft also nicht an einem leeren Objekt vorbei.
    expect(api?.privacy).toBeDefined()

    const transcription = api?.transcription as TranscriptionBridge | undefined
    expect(transcription).toBeDefined()

    invocations.length = 0
    await transcription?.export('job-1', 'srt')

    expect(invocations).toEqual([[IPC_CHANNELS.TRANSCRIPTION_EXPORT, 'job-1', 'srt']])
  })
})
