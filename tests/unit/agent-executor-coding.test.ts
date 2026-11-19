/**
 * Wiring of a coding run in AgentExecutor (Task 7).
 *
 * What matters here is NOT that ensureProjectWorkspace or compactToolResult work
 * on their own (their own tests cover that) but that the executor connects them:
 * an externalized tool result of a coding run must land under the project path,
 * and a run without coding options must keep using os.tmpdir().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentExecutor } from '../../src/main/agent/agent-executor'
import type { Message, ToolDefinition, AgentToolCall } from '../../src/shared/types'
import type { ToolUseResponse } from '../../src/main/llm-clients/client-manager'
import type { CodingMode } from '../../src/shared/coding-types'
import type { ToolContext } from '../../src/main/agent/tool-registry'
import { getEditProposalStore } from '../../src/main/coding/edit-proposals'
import { getRunDirectoryRegistry } from '../../src/main/coding/run-directories'

vi.mock('../../src/main/security/request-guard-deps', () => ({
  getGuardDeps: () => ({
    sanitize: () => ({ safe: true, riskScore: 0, warnings: [] }),
    scanSensitive: () => ({ hasSensitiveData: false, matches: [], overallRiskLevel: 'none' }),
    checkUploadPermission: async () => ({ decision: 'allowed', requiresUserConsent: false }),
    checkBudget: () => ({ allowed: true }),
    checkRouting: () => ({ allowed: true }),
    isCloudProvider: () => false,
    scanOutput: () => ({ violations: [] }),
  }),
}))

// What the model sees on each call: a snapshot of the tool messages, taken at call time.
let llmCallCount = 0
let llmResponses: ToolUseResponse[] = []
let seenToolMessages: string[][] = []

vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({
    providerSupportsToolUse: vi.fn().mockReturnValue(true),
    sendMessageWithTools: vi.fn().mockImplementation(async (_p: string, messages: Message[]) => {
      seenToolMessages.push(messages.filter((m) => m.role === 'tool').map((m) => m.content))
      const response = llmResponses[llmCallCount] ?? {
        text: 'Final answer.',
        toolCalls: [],
        done: true,
        stopReason: 'stop' as const,
        tokens: { input: 10, output: 10 },
      }
      llmCallCount++
      return response
    }),
  })),
}))

const BIG = 'x'.repeat(5000)
let registryCalls: Array<{ ctx: ToolContext | undefined }> = []
// Runs inside the mocked executeToolCalls, with the step's context.
let toolCallHook: ((ctx: ToolContext | undefined) => void | Promise<void>) | undefined
let toolListCtx: Array<ToolContext | undefined> = []

vi.mock('../../src/main/agent/tool-registry', () => ({
  getToolRegistry: vi.fn(() => ({
    refreshMCPTools: vi.fn(),
    getAvailableTools: vi.fn((ctx?: ToolContext) => {
      toolListCtx.push(ctx)
      return [
        { name: 'read_file', description: 'r', inputSchema: { type: 'object', properties: {} } },
      ] as ToolDefinition[]
    }),
    executeToolCalls: vi.fn(async (calls: AgentToolCall[], ctx?: ToolContext) => {
      registryCalls.push({ ctx })
      await toolCallHook?.(ctx)
      return calls.map((tc) => ({ toolCallId: tc.id, content: BIG, isError: false }))
    }),
  })),
}))

let storedModes: Record<string, CodingMode> = {}
vi.mock('../../src/main/coding/coding-mode-store', () => ({
  getCodingModeStore: () => ({
    getMode: (id: string): CodingMode => storedModes[id] ?? 'off',
    setMode: vi.fn(),
  }),
}))

const ensureSpy = vi.fn()
vi.mock('../../src/main/coding/project-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/coding/project-workspace')>()
  return {
    ...actual,
    ensureProjectWorkspace: (...args: Parameters<typeof actual.ensureProjectWorkspace>) => {
      ensureSpy(...args)
      return actual.ensureProjectWorkspace(...args)
    },
  }
})

function toolCallStep(id: string): ToolUseResponse {
  return {
    text: 'reading',
    toolCalls: [{ id, name: 'read_file', arguments: { path: 'a.ts' } }],
    done: false,
    stopReason: 'tool_use',
    tokens: { input: 10, output: 10 },
  }
}

/** Extract the externalized path out of the compaction text the model receives. */
function externalizedPaths(messages: string[]): string[] {
  return messages
    .map((m) => /externalized to file: (.+?)\]/.exec(m)?.[1])
    .filter((p): p is string => typeof p === 'string')
}

let projectPath: string
let executor: AgentExecutor

beforeEach(() => {
  vi.clearAllMocks()
  llmCallCount = 0
  llmResponses = []
  seenToolMessages = []
  registryCalls = []
  toolCallHook = undefined
  toolListCtx = []
  storedModes = {}
  projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-coding-wiring-')))
  executor = new AgentExecutor({
    maxSteps: 5,
    maxTokensPerRun: 50000,
    toolTimeoutMs: 5000,
    runTimeoutMs: 10000,
  })
})

afterEach(() => {
  fs.chmodSync(projectPath, 0o700)
  fs.rmSync(projectPath, { recursive: true, force: true })
})

describe('coding run workspace wiring', () => {
  it('externalizes a large tool result of a coding run UNDER the project path', async () => {
    storedModes['dir-1'] = 'read-only'
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'read-only',
    })

    expect(run.status).toBe('completed')
    const [paths] = [externalizedPaths(seenToolMessages[1])]
    expect(paths).toHaveLength(1)
    const contextRoot = path.join(projectPath, '.mingly', 'context') + path.sep
    expect(paths[0].startsWith(contextRoot)).toBe(true)
    expect(paths[0].startsWith(path.join(os.tmpdir(), 'mingly-agent'))).toBe(false)
  })

  it('keeps a run WITHOUT coding options on the temp directory', async () => {
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'm')

    expect(run.status).toBe('completed')
    const paths = externalizedPaths(seenToolMessages[1])
    expect(paths).toHaveLength(1)
    expect(paths[0].startsWith(path.join(os.tmpdir(), 'mingly-agent') + path.sep)).toBe(true)
    expect(fs.existsSync(path.join(projectPath, '.mingly'))).toBe(false)
    expect(ensureSpy).not.toHaveBeenCalled()
  })

  it('creates the workspace once per run and reuses it across steps', async () => {
    storedModes['dir-1'] = 'read-only'
    llmResponses = [toolCallStep('tc-1'), toolCallStep('tc-2')]

    await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'read-only',
    })

    expect(ensureSpy).toHaveBeenCalledTimes(1)
    expect(ensureSpy.mock.calls[0][0]).toBe(projectPath)
    const second = externalizedPaths(seenToolMessages[2])
    expect(second).toHaveLength(2)
    expect(path.dirname(second[0])).toBe(path.dirname(second[1]))
  })

  it('ends the run, without calling the model, when the workspace cannot be created', async () => {
    storedModes['dir-1'] = 'read-only'
    const missing = path.join(projectPath, 'does-not-exist')

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath: missing,
      mode: 'read-only',
    })

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
    expect(registryCalls).toHaveLength(0)
  })
})

describe('coding run mode and tool context', () => {
  it('records which directory the run belongs to, in the main process', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'propose' as const
    })
    expect(getRunDirectoryRegistry().get(run.id)).toBe('dir-1')
  })

  it('records nothing for a run that is refused (mode mismatch) or has no coding options', async () => {
    storedModes['dir-1'] = 'read-only'
    const refused = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'propose-run' as const
    })
    expect(getRunDirectoryRegistry().get(refused.id)).toBeUndefined()
    const plain = await executor.execute('task', 'anthropic', 'm')
    expect(getRunDirectoryRegistry().get(plain.id)).toBeUndefined()
  })

  it('hands the tool context to the tool list and to execution of a coding run', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    const coding = { directoryId: 'dir-1', projectPath, mode: 'propose' as const }

    await executor.execute('task', 'anthropic', 'm', [], undefined, coding)

    expect(toolListCtx[0]?.coding).toEqual(coding)
    expect(registryCalls[0].ctx?.coding).toEqual(coding)
  })

  it('gives every step the run id and its own step number (edit proposals are keyed on them)', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1'), toolCallStep('tc-2')]
    const coding = { directoryId: 'dir-1', projectPath, mode: 'propose' as const }

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding)

    expect(registryCalls).toHaveLength(2)
    const [first, second] = registryCalls.map((c) => c.ctx)
    expect(typeof first?.runId).toBe('string')
    expect(first?.runId).toBe(run.id)
    expect(second?.runId).toBe(run.id)
    expect(Number.isInteger(first?.stepNumber)).toBe(true)
    expect(second?.stepNumber).toBe((first?.stepNumber ?? 0) + 1)
  })

  it('passes no context at all for a run without coding options', async () => {
    llmResponses = [toolCallStep('tc-1')]

    await executor.execute('task', 'anthropic', 'm')

    expect(toolListCtx[0]).toBeUndefined()
    expect(registryCalls[0].ctx).toBeUndefined()
  })

  it('ends the run when the stored mode differs from the one the caller claims', async () => {
    storedModes['dir-1'] = 'read-only'

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'propose-run',
    })

    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/mode/i)
    expect(llmCallCount).toBe(0)
    expect(ensureSpy).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(projectPath, '.mingly'))).toBe(false)
  })

  it('treats a directory the store does not know as off, so a claimed mode is refused', async () => {
    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'unknown-dir',
      projectPath,
      mode: 'propose',
    })

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
  })

  it('refuses a claimed mode outside the vocabulary', async () => {
    storedModes['dir-1'] = 'read-only'

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'auto' as unknown as CodingMode,
    })

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
  })
})

describe('coding run with mode off behaves like a plain run', () => {
  const offCoding = () => ({ directoryId: 'dir-1', projectPath, mode: 'off' as const })

  it('leaves no .mingly directory behind and offers no tool context', async () => {
    storedModes['dir-1'] = 'off'
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, offCoding())

    expect(run.status).toBe('completed')
    expect(fs.existsSync(path.join(projectPath, '.mingly'))).toBe(false)
    expect(ensureSpy).not.toHaveBeenCalled()
    expect(toolListCtx[0]).toBeUndefined()
    expect(registryCalls[0].ctx).toBeUndefined()
  })

  it('externalizes to the temp directory, not into the project', async () => {
    storedModes['dir-1'] = 'off'
    llmResponses = [toolCallStep('tc-1')]

    await executor.execute('task', 'anthropic', 'm', [], undefined, offCoding())

    const paths = externalizedPaths(seenToolMessages[1])
    expect(paths).toHaveLength(1)
    expect(paths[0].startsWith(path.join(os.tmpdir(), 'mingly-agent') + path.sep)).toBe(true)
  })

  it('succeeds in a project where the workspace could not be created', async () => {
    storedModes['dir-1'] = 'off'
    fs.chmodSync(projectPath, 0o500)
    llmResponses = [toolCallStep('tc-1')]

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, offCoding())

    expect(run.status).toBe('completed')
  })

  it('control: the same non-writable project DOES fail a read-only run', async () => {
    storedModes['dir-1'] = 'read-only'
    fs.chmodSync(projectPath, 0o500)

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, {
      directoryId: 'dir-1',
      projectPath,
      mode: 'read-only',
    })

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
  })

  it('a mode mismatch still ends the run when the claim is off', async () => {
    storedModes['dir-1'] = 'propose'

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, offCoding())

    expect(run.status).toBe('failed')
    expect(llmCallCount).toBe(0)
  })
})

describe('edit proposals do not outlive their run', () => {
  const coding = () => ({ directoryId: 'dir-1', projectPath, mode: 'propose' as const })

  function seedProposal(ctx: ToolContext | undefined): void {
    const out = getEditProposalStore().propose(
      ctx?.runId ?? '',
      ctx?.stepNumber ?? 0,
      { path: 'a.ts', oldText: 'a', newText: 'b' },
      'a'
    )
    expect(out.kind).toBe('proposed')
  }

  it('KEEPS the proposals of a run that completes: they are the deliverable awaiting review', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    toolCallHook = seedProposal

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    expect(run.status).toBe('completed')
    const store = getEditProposalStore()
    expect(store.pending(run.id)).toHaveLength(1)
    store.resolve(run.id, true)
    expect(store.pending(run.id)).toEqual([])
  })

  it('KEEPS the proposals of a run that ran out of steps (it still did real work)', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = Array.from({ length: 10 }, (_, i) => toolCallStep(`tc-${i}`))
    let seeded = false
    toolCallHook = (ctx) => {
      if (seeded) return
      seeded = true
      seedProposal(ctx)
    }

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    expect(run.status).toBe('max_steps_reached')
    const store = getEditProposalStore()
    expect(store.pending(run.id)).toHaveLength(1)
    store.resolve(run.id, false)
  })

  it('clears the proposals of a CANCELLED run', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1'), toolCallStep('tc-2')]
    toolCallHook = (ctx) => {
      seedProposal(ctx)
      expect(executor.cancelRun(ctx?.runId ?? '')).toBe(true)
    }

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    expect(run.status).toBe('cancelled')
    expect(getEditProposalStore().pending(run.id)).toEqual([])
  })

  it('clears the proposals of a run that THROWS', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    toolCallHook = (ctx) => {
      seedProposal(ctx)
      throw new Error('boom')
    }

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    expect(run.status).toBe('failed')
    expect(getEditProposalStore().pending(run.id)).toEqual([])
  })

  it('records the abandoned package of a failed run for the audit', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    toolCallHook = (ctx) => {
      seedProposal(ctx)
      throw new Error('boom')
    }

    const run = await executor.execute('task', 'anthropic', 'm', [], undefined, coding())

    const { records } = getEditProposalStore().auditRecords(run.id)
    expect(records.some((r) => r.outcome === 'package-abandoned' && r.edits === 1)).toBe(true)
  })
})
