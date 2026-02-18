/**
 * Tests for Phase 3: Context Engineering features.
 *
 * Task 1: Progress Recitation — step summary injection
 * Task 2: Error Preservation — full error context in tool results
 * Task 3: KV-Cache optimization — deterministic tool ordering, stable system prompt
 * Task 4: File-based context — externalization of large tool results
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentExecutor } from '../../src/main/agent/agent-executor'
import type { AgentEvent } from '../../src/main/agent/agent-executor'
import { AgentContextManager } from '../../src/main/agent/agent-context-manager'
import type { Message, ToolDefinition, AgentToolCall, AgentToolResult } from '../../src/shared/types'
import type { ToolUseResponse } from '../../src/main/llm-clients/client-manager'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ── Mock setup ──────────────────────────────────────────────

let llmCallCount = 0
let llmResponses: ToolUseResponse[] = []
let capturedMessages: Message[][] = []

vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({
    providerSupportsToolUse: vi.fn().mockReturnValue(true),
    sendMessageWithTools: vi.fn().mockImplementation(async (provider: string, messages: Message[]) => {
      capturedMessages.push([...messages])
      const response = llmResponses[llmCallCount] ?? {
        text: 'Final answer.',
        toolCalls: [],
        done: true,
        stopReason: 'stop' as const,
        tokens: { input: 100, output: 50 }
      }
      llmCallCount++
      return response
    })
  }))
}))

vi.mock('../../src/main/agent/tool-registry', () => ({
  getToolRegistry: vi.fn(() => ({
    refreshMCPTools: vi.fn(),
    getAvailableTools: vi.fn().mockReturnValue([
      {
        name: 'search_docs',
        description: 'Search documents',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      },
      {
        name: 'read_file',
        description: 'Read a file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }
    ] as ToolDefinition[]),
    executeToolCalls: vi.fn().mockImplementation(async (calls: AgentToolCall[]) =>
      calls.map((tc) => ({
        toolCallId: tc.id,
        content: `Result for ${tc.name}: mock data`,
        isError: false
      }))
    )
  }))
}))

vi.mock('../../src/main/agent/agent-context-manager', async () => {
  const actual = await vi.importActual('../../src/main/agent/agent-context-manager')
  return {
    ...actual,
    getAgentContextManager: vi.fn(() => ({
      compactToolResult: vi.fn((runId: string, result: AgentToolResult) => result),
      cleanup: vi.fn()
    }))
  }
})

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => `test-${Math.random().toString(36).substring(7)}`)
}))

// ── Setup/Teardown ──────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  llmCallCount = 0
  llmResponses = []
  capturedMessages = []
})

// ══════════════════════════════════════════════════════════════
// Task 1: Progress Recitation
// ══════════════════════════════════════════════════════════════

describe('Task 1: Progress Recitation', () => {
  it('should inject progress recitation after 2+ steps', async () => {
    const executor = new AgentExecutor({
      maxSteps: 5,
      maxTokensPerRun: 100000,
      toolTimeoutMs: 5000,
      runTimeoutMs: 30000,
      enableProgressRecitation: true
    })

    llmResponses = [
      // Step 1: tool call
      {
        text: 'Searching...',
        toolCalls: [{ id: 'tc-1', name: 'search_docs', arguments: { query: 'test' } }],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 100, output: 30 }
      },
      // Step 2: another tool call
      {
        text: 'Reading file...',
        toolCalls: [{ id: 'tc-2', name: 'read_file', arguments: { path: '/tmp/data.txt' } }],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 200, output: 40 }
      },
      // Step 3: final answer
      {
        text: 'Done!',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 300, output: 50 }
      }
    ]

    await executor.execute('Complex task', 'anthropic', 'claude-3-5-sonnet')

    // After step 2, the messages should include a progress recitation
    // capturedMessages[2] = messages sent to LLM for step 3
    expect(capturedMessages.length).toBe(3)
    const step3Messages = capturedMessages[2]
    const progressMsg = step3Messages.find(
      (m) => m.role === 'user' && m.content.includes('[Progress:')
    )
    expect(progressMsg).toBeDefined()
    expect(progressMsg!.content).toContain('Step 2/5')
    expect(progressMsg!.content).toContain('search_docs')
    expect(progressMsg!.content).toContain('read_file')
    expect(progressMsg!.content).toContain('Steps remaining:')
    expect(progressMsg!.content).toContain('Do not repeat completed steps')
  })

  it('should NOT inject progress recitation when disabled', async () => {
    const executor = new AgentExecutor({
      maxSteps: 5,
      maxTokensPerRun: 100000,
      toolTimeoutMs: 5000,
      runTimeoutMs: 30000,
      enableProgressRecitation: false
    })

    llmResponses = [
      {
        text: 'Searching...',
        toolCalls: [{ id: 'tc-1', name: 'search_docs', arguments: { query: 'test' } }],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 100, output: 30 }
      },
      {
        text: 'More searching...',
        toolCalls: [{ id: 'tc-2', name: 'search_docs', arguments: { query: 'test2' } }],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 200, output: 40 }
      },
      {
        text: 'Done!',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 300, output: 50 }
      }
    ]

    await executor.execute('Task', 'anthropic', 'claude-3-5-sonnet')

    // No progress message should be injected
    for (const msgs of capturedMessages) {
      const progressMsg = msgs.find(
        (m) => m.role === 'user' && m.content.includes('[Progress:')
      )
      expect(progressMsg).toBeUndefined()
    }
  })

  it('should NOT inject progress recitation for first step', async () => {
    const executor = new AgentExecutor({
      maxSteps: 5,
      maxTokensPerRun: 100000,
      toolTimeoutMs: 5000,
      runTimeoutMs: 30000,
      enableProgressRecitation: true
    })

    llmResponses = [
      {
        text: 'Searching...',
        toolCalls: [{ id: 'tc-1', name: 'search_docs', arguments: { query: 'test' } }],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 100, output: 30 }
      },
      {
        text: 'Done!',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 200, output: 40 }
      }
    ]

    await executor.execute('Task', 'anthropic', 'claude-3-5-sonnet')

    // After step 1, recitation should NOT be injected (only >= 2 steps)
    const step2Messages = capturedMessages[1]
    const progressMsg = step2Messages?.find(
      (m) => m.role === 'user' && m.content.includes('[Progress:')
    )
    expect(progressMsg).toBeUndefined()
  })

  it('should mark error steps in progress recitation', async () => {
    const { getToolRegistry } = await import('../../src/main/agent/tool-registry')
    vi.mocked(getToolRegistry).mockReturnValue({
      refreshMCPTools: vi.fn(),
      getAvailableTools: vi.fn().mockReturnValue([
        { name: 'search_docs', description: 'Search', inputSchema: { type: 'object', properties: {}, required: [] } }
      ]),
      executeToolCalls: vi.fn()
        .mockResolvedValueOnce([{ toolCallId: 'tc-1', content: 'Result', isError: false }])
        .mockResolvedValueOnce([{ toolCallId: 'tc-2', content: 'Error: not found', isError: true }])
    } as any)

    const executor = new AgentExecutor({
      maxSteps: 5,
      maxTokensPerRun: 100000,
      toolTimeoutMs: 5000,
      runTimeoutMs: 30000,
      enableProgressRecitation: true
    })

    llmResponses = [
      {
        text: 'Step 1...',
        toolCalls: [{ id: 'tc-1', name: 'search_docs', arguments: { query: 'a' } }],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 100, output: 30 }
      },
      {
        text: 'Step 2...',
        toolCalls: [{ id: 'tc-2', name: 'search_docs', arguments: { query: 'b' } }],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 200, output: 40 }
      },
      {
        text: 'Final.',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 300, output: 50 }
      }
    ]

    await executor.execute('Task', 'anthropic', 'claude-3-5-sonnet')

    const step3Messages = capturedMessages[2]
    const progressMsg = step3Messages?.find(
      (m) => m.role === 'user' && m.content.includes('[Progress:')
    )
    expect(progressMsg).toBeDefined()
    // Step 2 should show error indicator
    expect(progressMsg!.content).toContain('(error)')
  })
})

// ══════════════════════════════════════════════════════════════
// Task 2: Error Preservation
// ══════════════════════════════════════════════════════════════

describe('Task 2: Error Preservation', () => {
  it('should keep full error content when enableErrorPreservation is true', async () => {
    const { getToolRegistry } = await import('../../src/main/agent/tool-registry')
    vi.mocked(getToolRegistry).mockReturnValue({
      refreshMCPTools: vi.fn(),
      getAvailableTools: vi.fn().mockReturnValue([
        { name: 'search_docs', description: 'Search', inputSchema: { type: 'object', properties: {}, required: [] } }
      ]),
      executeToolCalls: vi.fn().mockResolvedValue([{
        toolCallId: 'tc-1',
        content: 'Error executing tool "search_docs": [TypeError] Cannot read properties of undefined\nStack: at search (/src/tools.ts:42)\nat execute (/src/runner.ts:100)',
        isError: true
      }])
    } as any)

    const executor = new AgentExecutor({
      maxSteps: 5,
      maxTokensPerRun: 100000,
      toolTimeoutMs: 5000,
      runTimeoutMs: 30000,
      enableErrorPreservation: true
    })

    llmResponses = [
      {
        text: 'Searching...',
        toolCalls: [{ id: 'tc-1', name: 'search_docs', arguments: { query: 'test' } }],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 100, output: 30 }
      },
      {
        text: 'Done.',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 200, output: 40 }
      }
    ]

    await executor.execute('Task', 'anthropic', 'claude-3-5-sonnet')

    // The tool result in the messages should contain the full error
    const step2Messages = capturedMessages[1]
    const toolMsg = step2Messages?.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.content).toContain('TypeError')
    expect(toolMsg!.content).toContain('Stack:')
  })

  it('should truncate error content when enableErrorPreservation is false', async () => {
    const { getToolRegistry } = await import('../../src/main/agent/tool-registry')
    vi.mocked(getToolRegistry).mockReturnValue({
      refreshMCPTools: vi.fn(),
      getAvailableTools: vi.fn().mockReturnValue([
        { name: 'search_docs', description: 'Search', inputSchema: { type: 'object', properties: {}, required: [] } }
      ]),
      executeToolCalls: vi.fn().mockResolvedValue([{
        toolCallId: 'tc-1',
        content: 'A'.repeat(1000),
        isError: true
      }])
    } as any)

    const executor = new AgentExecutor({
      maxSteps: 5,
      maxTokensPerRun: 100000,
      toolTimeoutMs: 5000,
      runTimeoutMs: 30000,
      enableErrorPreservation: false
    })

    llmResponses = [
      {
        text: 'Searching...',
        toolCalls: [{ id: 'tc-1', name: 'search_docs', arguments: { query: 'test' } }],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 100, output: 30 }
      },
      {
        text: 'Done.',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 200, output: 40 }
      }
    ]

    await executor.execute('Task', 'anthropic', 'claude-3-5-sonnet')

    const step2Messages = capturedMessages[1]
    const toolMsg = step2Messages?.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    // Should be truncated to "Error: " + 500 chars max
    expect(toolMsg!.content.startsWith('Error:')).toBe(true)
    expect(toolMsg!.content.length).toBeLessThanOrEqual(510)
  })
})

// ══════════════════════════════════════════════════════════════
// Task 3: KV-Cache Optimization
// ══════════════════════════════════════════════════════════════

describe('Task 3: KV-Cache Optimization', () => {
  it('should use stable system prompt ID for cache consistency', async () => {
    const executor = new AgentExecutor({
      maxSteps: 5,
      maxTokensPerRun: 100000,
      toolTimeoutMs: 5000,
      runTimeoutMs: 30000
    })

    llmResponses = [
      {
        text: 'Done!',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 50, output: 20 }
      }
    ]

    await executor.execute(
      'Test',
      'anthropic',
      'claude-3-5-sonnet',
      [],
      'You are a helpful assistant.'
    )

    const sentMessages = capturedMessages[0]
    const systemMsg = sentMessages.find((m) => m.role === 'system')
    expect(systemMsg).toBeDefined()
    expect(systemMsg!.id).toBe('sys-prompt') // Stable ID, not random
  })

  it('should position system prompt as first message', async () => {
    const executor = new AgentExecutor({
      maxSteps: 5,
      maxTokensPerRun: 100000,
      toolTimeoutMs: 5000,
      runTimeoutMs: 30000
    })

    llmResponses = [
      {
        text: 'Done!',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 50, output: 20 }
      }
    ]

    const history: Message[] = [
      { id: 'h-1', role: 'user', content: 'Hi' },
      { id: 'h-2', role: 'assistant', content: 'Hello!' }
    ]

    await executor.execute(
      'Test',
      'anthropic',
      'claude-3-5-sonnet',
      history,
      'You are a helpful assistant.'
    )

    const sentMessages = capturedMessages[0]
    expect(sentMessages[0].role).toBe('system')
    expect(sentMessages[0].content).toBe('You are a helpful assistant.')
  })
})

// ══════════════════════════════════════════════════════════════
// Task 4: File-based Context (AgentContextManager)
// ══════════════════════════════════════════════════════════════

describe('Task 4: AgentContextManager', () => {
  let tempDir: string
  let manager: AgentContextManager

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `mingly-test-${Date.now()}`)
    manager = new AgentContextManager({
      compactionThreshold: 100,
      autoCleanup: true,
      tempDir
    })
  })

  afterEach(() => {
    manager.cleanupAll()
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true })
      }
    } catch {
      // Ignore cleanup errors in tests
    }
  })

  it('should pass through small tool results unchanged', () => {
    const result: AgentToolResult = {
      toolCallId: 'tc-1',
      content: 'Small result',
      isError: false
    }

    const compacted = manager.compactToolResult('run-1', result)
    expect(compacted.content).toBe('Small result')
  })

  it('should externalize large tool results to file', () => {
    const largeContent = 'X'.repeat(200) // Exceeds threshold of 100
    const result: AgentToolResult = {
      toolCallId: 'tc-1',
      content: largeContent,
      isError: false
    }

    const compacted = manager.compactToolResult('run-1', result)
    expect(compacted.content).toContain('[Large result externalized to file:')
    expect(compacted.content).toContain('200 chars')
    expect(compacted.content).toContain('read_file')
  })

  it('should NOT externalize error results even if large', () => {
    const result: AgentToolResult = {
      toolCallId: 'tc-1',
      content: 'E'.repeat(200),
      isError: true
    }

    const compacted = manager.compactToolResult('run-1', result)
    expect(compacted.content).toBe('E'.repeat(200))
  })

  it('should write externalized content to a readable temp file', () => {
    const largeContent = 'Data line 1\nData line 2\nData line 3\n' + 'X'.repeat(200)
    const result: AgentToolResult = {
      toolCallId: 'tc-1',
      content: largeContent,
      isError: false
    }

    const compacted = manager.compactToolResult('run-1', result)

    // Extract filepath from the compacted content
    const match = compacted.content.match(/file: (.+?)\]/)
    expect(match).toBeTruthy()
    const filepath = match![1]

    // Verify the file exists and has correct content
    expect(fs.existsSync(filepath)).toBe(true)
    const fileContent = fs.readFileSync(filepath, 'utf-8')
    expect(fileContent).toBe(largeContent)
  })

  it('should clean up temp files after run completion', () => {
    const largeContent = 'X'.repeat(200)
    const result: AgentToolResult = {
      toolCallId: 'tc-1',
      content: largeContent,
      isError: false
    }

    const compacted = manager.compactToolResult('run-1', result)
    const match = compacted.content.match(/file: (.+?)\]/)
    const filepath = match![1]

    expect(fs.existsSync(filepath)).toBe(true)

    manager.cleanup('run-1')

    expect(fs.existsSync(filepath)).toBe(false)
  })

  it('should track externalized data size', () => {
    const largeContent = 'X'.repeat(200)
    manager.compactToolResult('run-1', {
      toolCallId: 'tc-1',
      content: largeContent,
      isError: false
    })

    const size = manager.getExternalizedSize('run-1')
    expect(size).toBe(200)
  })

  it('should compact messages array by externalizing large tool results', () => {
    const messages: Message[] = [
      { id: 'm-1', role: 'user', content: 'Find data' },
      { id: 'm-2', role: 'tool', content: 'Y'.repeat(200), toolCallId: 'tc-1' },
      { id: 'm-3', role: 'tool', content: 'Small', toolCallId: 'tc-2' }
    ]

    const compacted = manager.compactMessages('run-1', messages)

    // First tool message should be compacted (200 > threshold 100)
    expect(compacted[1].content).toContain('[Result externalized to:')
    // Second tool message should be unchanged (5 < threshold 100)
    expect(compacted[2].content).toBe('Small')
  })
})
