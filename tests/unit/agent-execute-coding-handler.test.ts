/**
 * R35 at the IPC boundary: AGENT_EXECUTE derives the coding context from the
 * grant. A renderer-supplied projectPath that is not the grant's path is
 * rejected before any run starts.
 *
 * Plus the feature gate on the coding channels, pinned as an EXACT set: which
 * channels require `agentic_mode` and which deliberately do not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  execute: vi.fn(),
  grants: [] as unknown[],
  // A spy, not a stub: with `() => undefined` no assertion could ever fail at
  // a gate, which is how the gate ended up untested.
  requireFeature: vi.fn()
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn() } }))
vi.mock('nanoid', () => ({ nanoid: () => 'id' }))
vi.mock('../../src/main/ipc/ipc-utils', () => ({
  wrapHandler: (channel: string, fn: (...args: unknown[]) => unknown) => {
    h.handlers.set(channel, fn)
  },
  requireFeature: (feature: string) => h.requireFeature(feature)
}))
vi.mock('../../src/main/agent/agent-executor', () => ({
  getAgentExecutor: () => ({
    onEvent: () => () => undefined,
    execute: h.execute,
    cancelRun: () => false,
    getConfig: () => ({}),
    updateConfig: () => undefined
  })
}))
vi.mock('../../src/main/services/agent-comparison-service', () => ({ getAgentComparisonService: () => ({}) }))
vi.mock('../../src/main/agent/subagent-orchestrator', () => ({ getSubagentOrchestrator: () => ({}) }))
vi.mock('../../src/main/coding/consent-broker', () => ({
  // `respond` is present so that a THROW from the consent channel can only be
  // the feature gate, never a missing double.
  getConsentBroker: () => ({ respond: () => false })
}))
vi.mock('../../src/main/coding/coding-audit', () => ({ exportCodingAudit: () => '' }))
vi.mock('../../src/main/coding/apply-edits', () => ({
  acceptEditsForRun: vi.fn(),
  rejectEditsForRun: vi.fn(),
  undoRunForDirectory: vi.fn()
}))
vi.mock('../../src/main/file-access/file-access-manager', () => ({
  getFileAccessManager: () => ({ getAllowedDirectories: () => h.grants })
}))
vi.mock('../../src/main/coding/coding-mode-store', () => ({
  getCodingModeStore: () => ({ getMode: () => 'propose', setMode: vi.fn() })
}))
vi.mock('../../src/main/coding/edit-proposals', async (orig) => ({
  ...(await orig<typeof import('../../src/main/coding/edit-proposals')>()),
  getEditProposalStore: () => ({ pending: () => [] })
}))

import { IPC_CHANNELS } from '../../src/shared/types'
import { registerAgentHandlers } from '../../src/main/ipc/agent-handlers'
import {
  acceptEditsForRun,
  rejectEditsForRun,
  undoRunForDirectory
} from '../../src/main/coding/apply-edits'

const GRANT = {
  id: 'd1',
  path: '/Users/x/proj',
  name: 'proj',
  location: 'local',
  permissions: ['read', 'create', 'edit'],
  recursive: true,
  grantedAt: 1,
  confirmedAt: 1,
  accessCount: 0
}

async function execute(codingArg?: unknown): Promise<unknown> {
  const fn = h.handlers.get(IPC_CHANNELS.AGENT_EXECUTE)
  if (!fn) throw new Error('AGENT_EXECUTE not registered')
  return fn('task', 'anthropic', 'm', 'c1', [], undefined, codingArg)
}

describe('AGENT_EXECUTE coding context (R35)', () => {
  beforeEach(() => {
    h.handlers.clear()
    h.requireFeature.mockReset()
    h.execute.mockReset()
    h.execute.mockResolvedValue({ id: 'run1', status: 'completed' })
    h.grants = [GRANT]
    registerAgentHandlers()
  })

  it('starts the run with the path derived from the grant', async () => {
    const out = await execute({ directoryId: 'd1' })
    expect(out).toMatchObject({ success: true })
    expect(h.execute).toHaveBeenCalledTimes(1)
    expect(h.execute.mock.calls[0][5]).toEqual({
      directoryId: 'd1',
      projectPath: '/Users/x/proj',
      mode: 'propose'
    })
  })

  it('REJECTS a projectPath that does not belong to the grant: no run starts', async () => {
    const out = await execute({ directoryId: 'd1', projectPath: '/Users/x/.ssh' })
    expect(out).toMatchObject({ success: false })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('REJECTS an unknown directory id: no run starts', async () => {
    const out = await execute({ directoryId: 'ghost' })
    expect(out).toMatchObject({ success: false })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('REJECTS a coding argument that is not an object: no run starts', async () => {
    const out = await execute('d1')
    expect(out).toMatchObject({ success: false })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('a plain run (no coding argument) is unchanged: no coding context', async () => {
    const out = await execute(undefined)
    expect(out).toMatchObject({ success: true })
    expect(h.execute.mock.calls[0][5]).toBeUndefined()
  })
})

describe('the feature gate on the coding IPC channels', () => {
  /** Channels that may not work without `agentic_mode`: they trigger coding. */
  const GATED = [
    IPC_CHANNELS.CODING_ACCEPT_EDITS,
    IPC_CHANNELS.CODING_REJECT_EDITS,
    IPC_CHANNELS.CODING_GET_PENDING,
    IPC_CHANNELS.CODING_SET_MODE,
    IPC_CHANNELS.CODING_CONSENT_RESPOND
  ]

  /**
   * Channels that deliberately work WITHOUT the entitlement:
   *  - GET_MODE: reading a level is not a capability.
   *  - EXPORT_AUDIT: reading back records of actions already taken is access
   *    to one's own data, and an audit trail that disappears with the
   *    subscription is not an audit trail.
   *  - UNDO_RUN: undo is the safety net. apply-edits says in so many words
   *    that undo must not depend on the coding mode, because someone switches
   *    coding off BECAUSE something went wrong; a gate on the SUBSCRIPTION is
   *    the same lock-out one level up. Restoring one's own files belongs in
   *    the category of TRANSCRIPTION_DELETE (ungated on purpose), not of an
   *    export. The grant with read+edit is still required — apply-edits
   *    checks that itself.
   */
  const UNGATED = [
    IPC_CHANNELS.CODING_GET_MODE,
    IPC_CHANNELS.CODING_EXPORT_AUDIT,
    IPC_CHANNELS.CODING_UNDO_RUN
  ]

  /** Thrown by the gate double, so a gate refusal cannot be confused with a bug. */
  const GATE_ERROR = 'feature-gate:agentic_mode'

  beforeEach(() => {
    h.handlers.clear()
    h.requireFeature.mockReset()
    h.requireFeature.mockImplementation((feature: string) => {
      throw new Error(`feature-gate:${feature}`)
    })
    h.grants = [GRANT]
    // The ungated handlers must be able to run to the end, so a THROW from
    // them is unambiguously the gate and not a missing double.
    vi.mocked(acceptEditsForRun).mockResolvedValue({ kind: 'refused', reason: 'no' } as never)
    vi.mocked(rejectEditsForRun).mockReturnValue({ kind: 'refused', reason: 'no' } as never)
    vi.mocked(undoRunForDirectory).mockResolvedValue({ kind: 'refused', reason: 'no' } as never)
    registerAgentHandlers()
  })

  function callChannel(channel: string): Promise<unknown> {
    const fn = h.handlers.get(channel)
    if (!fn) throw new Error(`${channel} not registered`)
    // Arguments are deliberately absent: every handler treats them as
    // untrusted input, and the gate is reached before any of them is read.
    return Promise.resolve().then(() => fn())
  }

  it('registers exactly these coding channels, and no others', () => {
    const registered = [...h.handlers.keys()].filter((c) => c.startsWith('coding:')).sort()
    expect(registered).toEqual([...GATED, ...UNGATED].sort())
  })

  it.each(GATED)('%s is refused without the feature', async (channel) => {
    await expect(callChannel(channel)).rejects.toThrow(GATE_ERROR)
    expect(h.requireFeature).toHaveBeenCalledWith('agentic_mode')
  })

  it.each(UNGATED)('%s answers without the feature', async (channel) => {
    await expect(callChannel(channel)).resolves.toBeDefined()
    expect(h.requireFeature).not.toHaveBeenCalled()
  })

  it('positive control: with the feature granted, the gated channels answer too', async () => {
    h.requireFeature.mockImplementation(() => undefined)
    for (const channel of GATED) {
      await expect(callChannel(channel)).resolves.toBeDefined()
    }
    expect(h.requireFeature).toHaveBeenCalledTimes(GATED.length)
  })
})
