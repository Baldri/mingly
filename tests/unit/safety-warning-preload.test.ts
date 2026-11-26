/**
 * The preload bridge for `message:safety-warning`.
 *
 * The main process has been sending on this channel from four places
 * (ipc-handlers.ts:190, :222, :337, :349) — a routing fallback, the circuit
 * breaker's warnings, output-guardrail violations and a canary-token leak. The
 * preload exposed `message:chunk`, `message:complete`, `message:error` and
 * `message:permission-required` and nothing else, so every one of those was a
 * dead letter: a channel with no bridge entry cannot reach the renderer at all
 * (same failure mode as transcription-preload.test.ts).
 *
 * Asserted by CALLING the object handed to contextBridge, not by reading the
 * source: a bridge that exists but subscribes to the wrong channel, or returns
 * no unsubscribe, looks identical in a grep.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

const { listeners, removed, exposed } = vi.hoisted(() => ({
  listeners: [] as { channel: string; listener: (...args: unknown[]) => void }[],
  removed: [] as { channel: string; listener: (...args: unknown[]) => void }[],
  exposed: new Map<string, Record<string, unknown>>()
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>): void => {
      exposed.set(key, api)
    }
  },
  ipcRenderer: {
    invoke: (): Promise<unknown> => Promise.resolve({ success: true }),
    on: (channel: string, listener: (...args: unknown[]) => void): void => {
      listeners.push({ channel, listener })
    },
    removeListener: (channel: string, listener: (...args: unknown[]) => void): void => {
      removed.push({ channel, listener })
    }
  }
}))

interface ContextIsolationFlag {
  contextIsolated?: boolean
}

type Unsubscribe = () => void
interface Bridges {
  onMessageChunk: (cb: (chunk: string) => void) => Unsubscribe
  onMessageSafetyWarning: (cb: (warning: unknown) => void) => Unsubscribe
}

describe('preload bridge for message:safety-warning', () => {
  let previous: boolean | undefined
  let api: Bridges

  beforeAll(async () => {
    const flag = process as unknown as ContextIsolationFlag
    previous = flag.contextIsolated
    flag.contextIsolated = true
    await import('../../src/preload/index')
    api = exposed.get('electronAPI') as unknown as Bridges
  })

  afterAll(() => {
    ;(process as unknown as ContextIsolationFlag).contextIsolated = previous
  })

  it('positive control: the neighbouring stream bridge is present and behaves', () => {
    expect(api.onMessageChunk).toBeTypeOf('function')
    const unsubscribe = api.onMessageChunk(() => undefined)
    expect(listeners.some((l) => l.channel === 'message:chunk')).toBe(true)
    expect(unsubscribe).toBeTypeOf('function')
    unsubscribe()
  })

  it('exposes onMessageSafetyWarning', () => {
    expect(api.onMessageSafetyWarning).toBeTypeOf('function')
  })

  it('subscribes to the channel the main process actually sends on', () => {
    api.onMessageSafetyWarning(() => undefined)

    expect(listeners.some((l) => l.channel === 'message:safety-warning')).toBe(true)
  })

  it('forwards the payload the main process sends, dropping the IpcRendererEvent', () => {
    const seen: unknown[] = []
    api.onMessageSafetyWarning((warning) => seen.push(warning))
    const entry = listeners.filter((l) => l.channel === 'message:safety-warning').pop()
    expect(entry).toBeDefined()

    const payload = {
      type: 'fallback_triggered',
      level: 'warning',
      message: 'ollama -> anthropic',
      details: { provider: 'anthropic', reasons: ['residency'] }
    }
    entry?.listener({ sender: null }, payload)

    expect(seen).toEqual([payload])
  })

  it('returns an unsubscribe that removes the same listener it registered', () => {
    const unsubscribe = api.onMessageSafetyWarning(() => undefined)
    const entry = listeners.filter((l) => l.channel === 'message:safety-warning').pop()

    unsubscribe()

    expect(
      removed.some((r) => r.channel === 'message:safety-warning' && r.listener === entry?.listener)
    ).toBe(true)
  })
})
