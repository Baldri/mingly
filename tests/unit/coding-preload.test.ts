/**
 * The preload bridge for the coding UI. A channel without a bridge entry is dead
 * (see transcription-preload.test.ts); this asserts the bridges BEHAVE by
 * calling through the object handed to contextBridge.
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
type Fn = (...args: unknown[]) => Promise<unknown>
interface Bridges {
  agent: { execute: Fn }
  codingMode: { get: Fn; set: Fn }
  codingEdits: { pending: Fn; exportAudit: Fn; accept: Fn }
  privacy: unknown
}

describe('coding preload bridges', () => {
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

  it('has a positive control: an existing bridge is present', () => {
    expect(api.privacy).toBeDefined()
    expect(api.codingEdits.accept).toBeTypeOf('function')
  })

  it('forwards the coding argument of agent.execute as the seventh parameter', async () => {
    invocations.length = 0
    await api.agent.execute('t', 'p', 'm', 'c', [], undefined, { directoryId: 'd1' })
    expect(invocations).toEqual([
      [IPC_CHANNELS.AGENT_EXECUTE, 't', 'p', 'm', 'c', [], undefined, { directoryId: 'd1' }]
    ])
  })

  it('bridges mode get and set', async () => {
    invocations.length = 0
    await api.codingMode.get('d1')
    await api.codingMode.set('d1', 'propose')
    expect(invocations).toEqual([
      [IPC_CHANNELS.CODING_GET_MODE, 'd1'],
      [IPC_CHANNELS.CODING_SET_MODE, 'd1', 'propose']
    ])
  })

  it('bridges the pending package by run id only', async () => {
    invocations.length = 0
    await api.codingEdits.pending('run_1')
    expect(invocations).toEqual([[IPC_CHANNELS.CODING_GET_PENDING, 'run_1']])
  })

  it('bridges the audit export on the channel the handler left ungated', async () => {
    invocations.length = 0
    await api.codingEdits.exportAudit('2026-11-01T00:00:00.000Z', 500)
    expect(invocations).toEqual([
      [IPC_CHANNELS.CODING_EXPORT_AUDIT, '2026-11-01T00:00:00.000Z', 500]
    ])
  })
})
