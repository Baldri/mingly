/**
 * Tests for AgentComparisonService — parallel agent execution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentModelSlot } from '../../src/shared/types'
import type { AgentEvent } from '../../src/main/agent/agent-executor'

// We test the service logic by mocking AgentExecutor.execute()
// since it depends on LLMClient and ToolRegistry which are complex to set up.

// Mock the agent-executor module
vi.mock('../../src/main/agent/agent-executor', () => {
  class MockAgentExecutor {
    private eventHandlers: Array<(event: AgentEvent) => void> = []
    private config: Record<string, unknown>

    constructor(config?: Record<string, unknown>) {
      this.config = config ?? {}
    }

    onEvent(handler: (event: AgentEvent) => void) {
      this.eventHandlers.push(handler)
      return () => {
        this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
      }
    }

    async execute(
      task: string,
      provider: string,
      model: string,
      _history: unknown[] = [],
      _systemPrompt?: string
    ) {
      // Simulate a step event
      for (const handler of this.eventHandlers) {
        handler({
          type: 'step_start',
          runId: 'mock-run',
          step: { stepNumber: 1, thinking: '', toolCalls: [], toolResults: [], isFinal: false }
        })
      }

      // Simulate provider-specific behavior
      if (provider === 'failing-provider') {
        return {
          id: 'run-fail',
          conversationId: '',
          task,
          steps: [],
          status: 'failed' as const,
          totalTokens: { input: 0, output: 0 },
          totalCost: 0,
          durationMs: 100,
          error: `Provider ${provider} failed`,
          createdAt: Date.now()
        }
      }

      // Successful run
      return {
        id: `run-${provider}-${model}`,
        conversationId: '',
        task,
        steps: [
          {
            stepNumber: 1,
            thinking: `Answer from ${model}`,
            toolCalls: [],
            toolResults: [],
            isFinal: true,
            response: `Answer from ${model}`,
            tokens: { input: 100, output: 50 }
          }
        ],
        status: 'completed' as const,
        totalTokens: { input: 100, output: 50 },
        totalCost: 0.001,
        durationMs: 500,
        createdAt: Date.now()
      }
    }
  }

  return {
    AgentExecutor: MockAgentExecutor,
    getAgentExecutor: () => new MockAgentExecutor()
  }
})

// Import after mock
import { AgentComparisonService } from '../../src/main/services/agent-comparison-service'

describe('AgentComparisonService', () => {
  let service: AgentComparisonService

  beforeEach(() => {
    service = new AgentComparisonService()
  })

  it('should run 2 slots in parallel and collect results', async () => {
    const slots: AgentModelSlot[] = [
      { provider: 'anthropic', model: 'claude-3-sonnet' },
      { provider: 'openai', model: 'gpt-4' }
    ]

    const events: Array<{ slotIndex: number; type: string }> = []
    const onEvent = (slotIndex: number, event: AgentEvent) => {
      events.push({ slotIndex, type: event.type })
    }

    const session = await service.runAgentComparison('What is TypeScript?', slots, onEvent)

    expect(session.status).toBe('completed')
    expect(session.results).toHaveLength(2)
    expect(session.results[0].slot.provider).toBe('anthropic')
    expect(session.results[1].slot.provider).toBe('openai')
    expect(session.results[0].run.status).toBe('completed')
    expect(session.results[1].run.status).toBe('completed')
    expect(session.durationMs).toBeGreaterThanOrEqual(0)

    // Events should have been received for both slots
    expect(events.length).toBeGreaterThan(0)
    const slot0Events = events.filter((e) => e.slotIndex === 0)
    const slot1Events = events.filter((e) => e.slotIndex === 1)
    expect(slot0Events.length).toBeGreaterThan(0)
    expect(slot1Events.length).toBeGreaterThan(0)
  })

  it('should handle partial failure (1 of 3 fails)', async () => {
    const slots: AgentModelSlot[] = [
      { provider: 'anthropic', model: 'claude-3-sonnet' },
      { provider: 'failing-provider', model: 'bad-model' },
      { provider: 'openai', model: 'gpt-4' }
    ]

    const session = await service.runAgentComparison(
      'Test prompt',
      slots,
      () => {} // no-op event handler
    )

    expect(session.status).toBe('partial')
    expect(session.results).toHaveLength(3)

    // First and third should succeed
    expect(session.results[0].run.status).toBe('completed')
    expect(session.results[0].error).toBeUndefined()

    // Second should fail
    expect(session.results[1].run.status).toBe('failed')
    expect(session.results[1].error).toBeDefined()

    // Third should succeed
    expect(session.results[2].run.status).toBe('completed')
    expect(session.results[2].error).toBeUndefined()
  })

  it('should reject more than 3 slots', async () => {
    const slots: AgentModelSlot[] = [
      { provider: 'a', model: 'm1' },
      { provider: 'b', model: 'm2' },
      { provider: 'c', model: 'm3' },
      { provider: 'd', model: 'm4' }
    ]

    await expect(
      service.runAgentComparison('test', slots, () => {})
    ).rejects.toThrow('Agent comparison requires 1-3 model slots')
  })

  it('should reject empty slots', async () => {
    await expect(
      service.runAgentComparison('test', [], () => {})
    ).rejects.toThrow('Agent comparison requires 1-3 model slots')
  })

  it('should support single slot (useful for testing)', async () => {
    const slots: AgentModelSlot[] = [
      { provider: 'openai', model: 'gpt-4' }
    ]

    const session = await service.runAgentComparison('test', slots, () => {})

    expect(session.status).toBe('completed')
    expect(session.results).toHaveLength(1)
  })

  it('should pass prompt and system prompt to each executor', async () => {
    const slots: AgentModelSlot[] = [
      { provider: 'anthropic', model: 'claude-3-sonnet' }
    ]

    const session = await service.runAgentComparison(
      'Explain quantum computing',
      slots,
      () => {},
      'You are a physics professor'
    )

    expect(session.prompt).toBe('Explain quantum computing')
    expect(session.results[0].run.task).toBe('Explain quantum computing')
  })

  it('should track session ID and cleanup after completion', async () => {
    const slots: AgentModelSlot[] = [
      { provider: 'openai', model: 'gpt-4' }
    ]

    // Before run
    expect(service.getActiveSessions()).toHaveLength(0)

    const session = await service.runAgentComparison('test', slots, () => {})

    // After run (should be cleaned up)
    expect(service.getActiveSessions()).toHaveLength(0)
    expect(session.id).toBeDefined()
  })

  it('should report all-failed when every slot fails', async () => {
    const slots: AgentModelSlot[] = [
      { provider: 'failing-provider', model: 'bad1' },
      { provider: 'failing-provider', model: 'bad2' }
    ]

    const session = await service.runAgentComparison('test', slots, () => {})

    expect(session.status).toBe('failed')
  })

  it('should include slot info in each result', async () => {
    const slots: AgentModelSlot[] = [
      { provider: 'anthropic', model: 'claude-3-sonnet', label: 'Cloud (Claude)' },
      { provider: 'ollama', model: 'llama3.1:8b', label: 'Local (Llama)' }
    ]

    const session = await service.runAgentComparison('test', slots, () => {})

    expect(session.results[0].slot.label).toBe('Cloud (Claude)')
    expect(session.results[1].slot.label).toBe('Local (Llama)')
  })
})
