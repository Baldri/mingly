/**
 * Wiring of read_file through the REAL AgentExecutor and the REAL registry
 * (Task 9): the handler receives the workspace instance the executor created,
 * and the loop guard receives the file path, not just the tool name. A test
 * against originForToolCall alone would stay green while the executor ignores it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentExecutor } from '../../src/main/agent/agent-executor'
import { getToolRegistry, type ToolContext } from '../../src/main/agent/tool-registry'
import type { ToolUseResponse } from '../../src/main/llm-clients/client-manager'
import type { CodingMode } from '../../src/shared/coding-types'
import type { Message } from '../../src/shared/types'
import type { ToolResultOrigin } from '../../src/main/agent/loop-guard'

vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn(() => ({ listAllTools: vi.fn().mockReturnValue([]) }))
}))

vi.mock('../../src/main/security/request-guard-deps', () => ({
  getGuardDeps: () => ({
    sanitize: () => ({ safe: true, riskScore: 0, warnings: [] }),
    scanSensitive: () => ({ hasSensitiveData: false, matches: [], overallRiskLevel: 'none' }),
    checkUploadPermission: async () => ({ decision: 'allowed', requiresUserConsent: false }),
    checkBudget: () => ({ allowed: true }),
    checkRouting: () => ({ allowed: true }),
    isCloudProvider: () => false,
    scanOutput: () => ({ violations: [] })
  })
}))

let projectPath: string

// The default grant lookup of read_file loads the FileAccessManager (electron).
vi.mock('../../src/main/file-access/file-access-manager', () => ({
  getFileAccessManager: () => ({
    getAllowedDirectories: () => [
      {
        id: 'dir-1',
        path: projectPath,
        name: 'p',
        location: 'local',
        permissions: ['read'],
        recursive: true,
        grantedAt: 1,
        confirmedAt: 1
      }
    ]
  })
}))

let llmCallCount = 0
let llmResponses: ToolUseResponse[] = []
vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({
    providerSupportsToolUse: vi.fn().mockReturnValue(true),
    sendMessageWithTools: vi.fn().mockImplementation(async (_p: string, _m: Message[]) => {
      const response = llmResponses[llmCallCount] ?? {
        text: 'Final answer.',
        toolCalls: [],
        done: true,
        stopReason: 'stop' as const,
        tokens: { input: 10, output: 10 }
      }
      llmCallCount++
      return response
    })
  }))
}))

let storedModes: Record<string, CodingMode> = {}
vi.mock('../../src/main/coding/coding-mode-store', () => ({
  getCodingModeStore: () => ({
    getMode: (id: string): CodingMode => storedModes[id] ?? 'off',
    setMode: vi.fn()
  })
}))

const ensureSpy = vi.fn()
vi.mock('../../src/main/coding/project-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/coding/project-workspace')>()
  return {
    ...actual,
    ensureProjectWorkspace: (...args: Parameters<typeof actual.ensureProjectWorkspace>) => {
      ensureSpy(...args)
      return actual.ensureProjectWorkspace(...args)
    }
  }
})

let guardOrigins: Array<readonly ToolResultOrigin[]> = []
let guardContents: string[][] = []
vi.mock('../../src/main/agent/loop-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/loop-guard')>()
  return {
    ...actual,
    guardToolResults: (...args: Parameters<typeof actual.guardToolResults>) => {
      guardOrigins.push(args[1])
      guardContents.push(args[0].map((r) => r.content))
      return actual.guardToolResults(...args)
    }
  }
})

function step(name: string, args: Record<string, unknown>): ToolUseResponse {
  return {
    text: 'go',
    toolCalls: [{ id: 'tc-1', name, arguments: args }],
    done: false,
    stopReason: 'tool_use',
    tokens: { input: 10, output: 10 }
  }
}

let executor: AgentExecutor

beforeEach(() => {
  vi.clearAllMocks()
  llmCallCount = 0
  llmResponses = []
  guardOrigins = []
  guardContents = []
  storedModes = { 'dir-1': 'read-only' }
  projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-read-exec-')))
  executor = new AgentExecutor({
    maxSteps: 5,
    maxTokensPerRun: 50000,
    toolTimeoutMs: 5000,
    runTimeoutMs: 10000
  })
})

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
})

async function run(): Promise<void> {
  await executor.execute('task', 'anthropic', 'm', [], undefined, {
    directoryId: 'dir-1',
    projectPath,
    mode: 'read-only'
  })
}

describe('read_file through the real executor', () => {
  it('hands the guard the FILE PATH of a read_file result', async () => {
    fs.mkdirSync(path.join(projectPath, 'src'))
    fs.writeFileSync(path.join(projectPath, 'src', 'a.ts'), 'export const a = 1\n')
    llmResponses = [step('read_file', { path: 'src/a.ts' })]
    await run()
    expect(guardOrigins).toHaveLength(1)
    expect(guardOrigins[0][0]).toEqual({ toolName: 'read_file', filePath: 'src/a.ts' })
    // The guard saw the RAW file content, not a compacted reference.
    expect(guardContents[0][0]).toContain('export const a = 1')
  })

  it('gives the handler the SAME workspace instance the executor created, created once', async () => {
    let seen: ToolContext | undefined
    getToolRegistry().registerBuiltIn(
      {
        name: 'probe_workspace',
        description: 'probe',
        inputSchema: { type: 'object', properties: {} }
      },
      async (_args, ctx) => {
        seen = ctx
        return 'ok'
      },
      (ctx) => ctx?.coding !== undefined
    )
    llmResponses = [step('probe_workspace', {})]
    await run()
    expect(ensureSpy).toHaveBeenCalledTimes(1)
    expect(seen?.workspace).toBeDefined()
    expect(seen!.workspace!.contextDir).toBe(
      path.join(projectPath, '.mingly', 'context', ensureSpy.mock.calls[0][1] as string)
    )
    expect(fs.existsSync(seen!.workspace!.contextDir)).toBe(true)
  })
})
