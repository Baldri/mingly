/**
 * R35 at the IPC boundary: AGENT_EXECUTE derives the coding context from the
 * grant. A renderer-supplied projectPath that is not the grant's path is
 * rejected before any run starts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  execute: vi.fn(),
  grants: [] as unknown[]
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn() } }))
vi.mock('nanoid', () => ({ nanoid: () => 'id' }))
vi.mock('../../src/main/ipc/ipc-utils', () => ({
  wrapHandler: (channel: string, fn: (...args: unknown[]) => unknown) => {
    h.handlers.set(channel, fn)
  },
  requireFeature: () => undefined
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
vi.mock('../../src/main/coding/consent-broker', () => ({ getConsentBroker: () => ({}) }))
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
