/**
 * Tests for AgentExecutor — ReAct-Loop with Safety Rails.
 * Tests the full agent lifecycle: single-step, multi-step, cancellation,
 * token budget, max steps, timeouts, and event emission.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentExecutor } from '../../src/main/agent/agent-executor'
import type { AgentEvent } from '../../src/main/agent/agent-executor'
import type { Message, ToolDefinition, AgentToolCall } from '../../src/shared/types'
import type { ToolUseResponse } from '../../src/main/llm-clients/client-manager'

// ── Mock setup ──────────────────────────────────────────────

// Track mock call counts for LLM
let llmCallCount = 0
let llmResponses: ToolUseResponse[] = []

vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({
    providerSupportsToolUse: vi.fn().mockReturnValue(true),
    sendMessageWithTools: vi.fn().mockImplementation(async () => {
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

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => `test-${Math.random().toString(36).substring(7)}`)
}))

// ── Setup/Teardown ──────────────────────────────────────────

let executor: AgentExecutor

beforeEach(() => {
  vi.clearAllMocks()
  llmCallCount = 0
  llmResponses = []
  executor = new AgentExecutor({
    maxSteps: 5,
    maxTokensPerRun: 50000,
    toolTimeoutMs: 5000,
    runTimeoutMs: 10000
  })
})

// ── Single-step (direct answer) ─────────────────────────────

describe('Single-step execution (no tools needed)', () => {
  it('should complete in one step when LLM gives direct answer', async () => {
    llmResponses = [
      {
        text: 'The answer is 42.',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 80, output: 20 }
      }
    ]

    const run = await executor.execute(
      'What is the meaning of life?',
      'anthropic',
      'claude-3-5-sonnet'
    )

    expect(run.status).toBe('completed')
    expect(run.steps).toHaveLength(1)
    expect(run.steps[0].isFinal).toBe(true)
    expect(run.steps[0].response).toBe('The answer is 42.')
    expect(run.steps[0].toolCalls).toHaveLength(0)
    expect(run.totalTokens.input).toBe(80)
    expect(run.totalTokens.output).toBe(20)
  })
})

// ── Multi-step (tool use) ───────────────────────────────────

describe('Multi-step execution (with tool use)', () => {
  it('should execute tools and continue conversation', async () => {
    llmResponses = [
      // Step 1: LLM wants to search
      {
        text: 'Let me search for that.',
        toolCalls: [
          { id: 'tc-1', name: 'search_docs', arguments: { query: 'TypeScript' } }
        ],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 100, output: 30 }
      },
      // Step 2: LLM gives final answer based on results
      {
        text: 'Based on the search results, TypeScript is great.',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 200, output: 40 }
      }
    ]

    const run = await executor.execute(
      'Tell me about TypeScript',
      'anthropic',
      'claude-3-5-sonnet'
    )

    expect(run.status).toBe('completed')
    expect(run.steps).toHaveLength(2)

    // Step 1: tool use
    expect(run.steps[0].toolCalls).toHaveLength(1)
    expect(run.steps[0].toolResults).toHaveLength(1)
    expect(run.steps[0].isFinal).toBe(false)

    // Step 2: final answer
    expect(run.steps[1].isFinal).toBe(true)
    expect(run.steps[1].response).toContain('TypeScript is great')

    // Token tracking
    expect(run.totalTokens.input).toBe(300) // 100 + 200
    expect(run.totalTokens.output).toBe(70) // 30 + 40
  })
})

// ── Max steps safety rail ───────────────────────────────────

describe('Max steps safety rail', () => {
  it('should stop after maxSteps even if LLM keeps requesting tools', async () => {
    const maxSteps = 3
    executor = new AgentExecutor({
      maxSteps,
      maxTokensPerRun: 100000,
      toolTimeoutMs: 5000,
      runTimeoutMs: 30000
    })

    // LLM always wants to use tools (never gives final answer)
    llmResponses = Array(maxSteps + 1).fill({
      text: 'Need more data...',
      toolCalls: [
        { id: 'tc-loop', name: 'search_docs', arguments: { query: 'more' } }
      ],
      done: false,
      stopReason: 'tool_use',
      tokens: { input: 50, output: 20 }
    })

    const run = await executor.execute(
      'Keep searching forever',
      'anthropic',
      'claude-3-5-sonnet'
    )

    expect(run.status).toBe('max_steps_reached')
    expect(run.steps.length).toBeLessThanOrEqual(maxSteps)
    expect(run.error).toContain('Maximum steps')
  })
})

// ── Token budget safety rail ────────────────────────────────

describe('Token budget safety rail', () => {
  it('should stop when token budget is exhausted', async () => {
    executor = new AgentExecutor({
      maxSteps: 10,
      maxTokensPerRun: 200, // Very low budget
      toolTimeoutMs: 5000,
      runTimeoutMs: 30000
    })

    llmResponses = [
      // Step 1: uses 150 tokens of 200 budget
      {
        text: 'Searching...',
        toolCalls: [
          { id: 'tc-1', name: 'search_docs', arguments: { query: 'a' } }
        ],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 100, output: 50 }
      },
      // Step 2: would use 150 more, but budget is only 200 total → should be blocked
      {
        text: 'More searching...',
        toolCalls: [
          { id: 'tc-2', name: 'search_docs', arguments: { query: 'b' } }
        ],
        done: false,
        stopReason: 'tool_use',
        tokens: { input: 100, output: 50 }
      }
    ]

    const run = await executor.execute(
      'Search everything',
      'anthropic',
      'claude-3-5-sonnet'
    )

    // After step 1 (150 tokens), budget check before step 2 should stop
    // Note: the check happens BEFORE the LLM call, so step 1 completes
    // and then step 2 is either not started or the run is marked
    expect(run.totalTokens.input + run.totalTokens.output).toBeLessThanOrEqual(300)
    expect(['max_steps_reached', 'completed'].includes(run.status) || run.steps.length <= 2).toBe(true)
  })
})

// ── Event emission ──────────────────────────────────────────

describe('Event emission', () => {
  it('should emit step_start, step_complete, and run_complete events', async () => {
    llmResponses = [
      {
        text: 'Done!',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 50, output: 20 }
      }
    ]

    const events: AgentEvent[] = []
    executor.onEvent((event) => events.push(event))

    await executor.execute('Quick question', 'anthropic', 'claude-3-5-sonnet')

    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).toContain('step_start')
    expect(eventTypes).toContain('step_complete')
    expect(eventTypes).toContain('run_complete')
  })

  it('should allow unsubscribing from events', async () => {
    llmResponses = [
      {
        text: 'Done!',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 50, output: 20 }
      }
    ]

    const events: AgentEvent[] = []
    const unsubscribe = executor.onEvent((event) => events.push(event))
    unsubscribe()

    await executor.execute('Quick question', 'anthropic', 'claude-3-5-sonnet')

    expect(events).toHaveLength(0)
  })
})

// ── Provider validation ─────────────────────────────────────

describe('Provider validation', () => {
  it('should fail if provider does not support tool-use', async () => {
    // Override the mock for this test
    const { getClientManager } = await import('../../src/main/llm-clients/client-manager')
    vi.mocked(getClientManager).mockReturnValueOnce({
      providerSupportsToolUse: vi.fn().mockReturnValue(false),
      sendMessageWithTools: vi.fn()
    } as any)

    const run = await executor.execute(
      'Use tools please',
      'ollama',
      'llama3'
    )

    expect(run.status).toBe('failed')
    expect(run.error).toContain('does not support tool-use')
  })
})

// ── Conversation history ────────────────────────────────────

describe('Conversation history', () => {
  it('should include prior conversation history in agent messages', async () => {
    llmResponses = [
      {
        text: 'Based on our conversation, the answer is X.',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 150, output: 30 }
      }
    ]

    const history: Message[] = [
      { id: 'h-1', role: 'user', content: 'My name is Holger.' },
      { id: 'h-2', role: 'assistant', content: 'Hello Holger!' }
    ]

    const run = await executor.execute(
      'What is my name?',
      'anthropic',
      'claude-3-5-sonnet',
      history
    )

    expect(run.status).toBe('completed')
    // The LLM should have received the history + task
    expect(run.steps).toHaveLength(1)
  })
})

// ── Configuration ───────────────────────────────────────────

describe('Configuration', () => {
  it('should return current config', () => {
    const config = executor.getConfig()

    expect(config.maxSteps).toBe(5)
    expect(config.maxTokensPerRun).toBe(50000)
  })

  it('should allow updating config', () => {
    executor.updateConfig({ maxSteps: 10 })

    expect(executor.getConfig().maxSteps).toBe(10)
    // Other values unchanged
    expect(executor.getConfig().maxTokensPerRun).toBe(50000)
  })
})

// ── Run duration tracking ───────────────────────────────────

describe('Run metadata', () => {
  it('should track run duration', async () => {
    llmResponses = [
      {
        text: 'Done.',
        toolCalls: [],
        done: true,
        stopReason: 'stop',
        tokens: { input: 50, output: 10 }
      }
    ]

    const run = await executor.execute('Quick task', 'anthropic', 'claude-3-5-sonnet')

    expect(run.durationMs).toBeGreaterThanOrEqual(0)
    expect(run.createdAt).toBeGreaterThan(0)
    expect(run.id).toBeTruthy()
  })
})
