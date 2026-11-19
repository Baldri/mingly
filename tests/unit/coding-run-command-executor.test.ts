/**
 * run_command through the REAL AgentExecutor and the REAL registry (Task 12).
 *
 * run_command is an ordinary tool, so its output reaches the loop guard like
 * any tool result. That is shown here rather than assumed. The detector behind
 * the guard is a stand-in that recognises the literal `API_KEY`: what this
 * file proves is the ROUTING (command output -> guard -> run ends), not the
 * coverage of the production detector, which is narrower (README, section on
 * coding mode).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentExecutor } from '../../src/main/agent/agent-executor'
import type { ToolUseResponse } from '../../src/main/llm-clients/client-manager'
import type { CodingMode } from '../../src/shared/coding-types'
import type { Message } from '../../src/shared/types'
import type { ToolResultOrigin } from '../../src/main/agent/loop-guard'

vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: vi.fn(() => ({ listAllTools: vi.fn().mockReturnValue([]) }))
}))

const CREDENTIAL_SCAN = {
  hasSensitiveData: true,
  matches: [{ type: 'credential', value: 'sk-live-abc123', riskLevel: 'critical' }],
  overallRiskLevel: 'critical'
}
const CLEAN_SCAN = { hasSensitiveData: false, matches: [], overallRiskLevel: 'none' }

vi.mock('../../src/main/security/request-guard-deps', () => ({
  getGuardDeps: () => ({
    sanitize: () => ({ safe: true, riskScore: 0, warnings: [] }),
    scanSensitive: (text: string) => (text.includes('API_KEY') ? CREDENTIAL_SCAN : CLEAN_SCAN),
    checkUploadPermission: async () => ({
      decision: 'denied',
      reason: 'Credential upload to a cloud provider denied.'
    }),
    checkBudget: () => ({ allowed: true }),
    checkRouting: () => ({ allowed: true }),
    isCloudProvider: () => true,
    scanOutput: () => ({ violations: [] })
  })
}))

let projectPath: string
let binDir: string

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

// The interpreter setting: the store behind SimpleStore, as the user confirmed it.
vi.mock('../../src/main/utils/simple-store', () => ({
  SimpleStore: {
    create: () => ({
      get: (key: string, fallback?: unknown) =>
        key === 'paths' ? { npm: path.join(binDir, 'npm') } : fallback,
      set: vi.fn()
    })
  }
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

function commandStep(command: string): ToolUseResponse {
  return {
    text: 'go',
    toolCalls: [{ id: 'tc-1', name: 'run_command', arguments: { command } }],
    done: false,
    stopReason: 'tool_use',
    tokens: { input: 10, output: 10 }
  }
}

function fakeNpm(body: string): void {
  fs.writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

let executor: AgentExecutor

beforeEach(() => {
  vi.clearAllMocks()
  llmCallCount = 0
  llmResponses = []
  guardOrigins = []
  guardContents = []
  storedModes = { 'dir-1': 'propose-run' }
  projectPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-run-exec-')))
  binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-run-exec-bin-')))
  executor = new AgentExecutor({
    maxSteps: 5,
    maxTokensPerRun: 50000,
    toolTimeoutMs: 5000,
    runTimeoutMs: 10000
  })
})

afterEach(() => {
  fs.rmSync(projectPath, { recursive: true, force: true })
  fs.rmSync(binDir, { recursive: true, force: true })
})

function runIn(mode: CodingMode) {
  return executor.execute('task', 'anthropic', 'm', [], undefined, {
    directoryId: 'dir-1',
    projectPath,
    mode
  })
}

describe('run_command through the real executor', () => {
  it('positive control: harmless output lets the run continue to the next model call', async () => {
    fakeNpm('echo all green')
    llmResponses = [commandStep('npm test')]
    const run = await runIn('propose-run')
    expect(run.status).toBe('completed')
    expect(llmCallCount).toBe(2)
  })

  it('hands the guard the RAW command output, attributed to run_command and without a file path', async () => {
    fakeNpm('echo all green')
    llmResponses = [commandStep('npm test')]
    await runIn('propose-run')
    expect(guardOrigins).toHaveLength(1)
    expect(guardOrigins[0][0]).toEqual({ toolName: 'run_command' })
    expect(guardContents[0][0]).toContain('exit code 0')
    expect(guardContents[0][0]).toContain('all green')
  })

  it('a credential printed by the command ends the run before the next model call', async () => {
    fakeNpm('echo "API_KEY=sk-live-abc123"')
    llmResponses = [commandStep('npm test')]
    const run = await runIn('propose-run')
    expect(run.status).toBe('failed')
    expect(run.error).toContain('Credential upload to a cloud provider denied.')
    expect(run.error).toContain('run_command')
    expect(llmCallCount).toBe(1)
  })

  it('a model that names run_command below propose-run gets no execution', async () => {
    const marker = path.join(binDir, 'ran.marker')
    fakeNpm(`touch "${marker}"\necho ok`)
    storedModes['dir-1'] = 'propose'
    llmResponses = [commandStep('npm test')]
    await runIn('propose')
    expect(fs.existsSync(marker)).toBe(false)
    expect(guardContents[0][0]).toMatch(/Unknown tool/)
  })

  it('positive control for the marker: in propose-run the same script does run', async () => {
    const marker = path.join(binDir, 'ran.marker')
    fakeNpm(`touch "${marker}"\necho ok`)
    llmResponses = [commandStep('npm test')]
    await runIn('propose-run')
    expect(fs.existsSync(marker)).toBe(true)
  })
})
