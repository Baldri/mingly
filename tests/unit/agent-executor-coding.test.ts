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
  it('hands the tool context to the tool list and to execution of a coding run', async () => {
    storedModes['dir-1'] = 'propose'
    llmResponses = [toolCallStep('tc-1')]
    const coding = { directoryId: 'dir-1', projectPath, mode: 'propose' as const }

    await executor.execute('task', 'anthropic', 'm', [], undefined, coding)

    expect(toolListCtx[0]?.coding).toEqual(coding)
    expect(registryCalls[0].ctx?.coding).toEqual(coding)
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
