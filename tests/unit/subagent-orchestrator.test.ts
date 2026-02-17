/**
 * Tests for SubagentOrchestrator — task decomposition + parallel execution + synthesis.
 *
 * Mocks AgentExecutor and ClientManager to test orchestration logic
 * without actual LLM or tool calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentModelSlot } from '../../src/shared/types'
import type { AgentEvent } from '../../src/main/agent/agent-executor'

// ── Mocks ────────────────────────────────────────────────────

// Mock AgentExecutor for parallel subtask execution
vi.mock('../../src/main/agent/agent-executor', () => {
  class MockAgentExecutor {
    private eventHandlers: Array<(event: AgentEvent) => void> = []

    constructor(_config?: Record<string, unknown>) {}

    onEvent(handler: (event: AgentEvent) => void) {
      this.eventHandlers.push(handler)
      return () => {
        this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
      }
    }

    async execute(
      task: string,
      provider: string,
      model: string
    ) {
      // Fire step event
      for (const handler of this.eventHandlers) {
        handler({
          type: 'step_complete',
          runId: 'mock-run',
          step: {
            stepNumber: 1,
            thinking: 'Working on subtask',
            toolCalls: [],
            toolResults: [],
            isFinal: true,
            response: `Result from ${provider}/${model} for: ${task.substring(0, 50)}`,
            tokens: { input: 100, output: 50 }
          }
        })
      }

      if (provider === 'failing-provider') {
        return {
          id: 'run-fail',
          conversationId: '',
          task,
          steps: [],
          status: 'failed' as const,
          totalTokens: { input: 0, output: 0 },
          totalCost: 0,
          durationMs: 0,
          error: 'Provider failed',
          createdAt: Date.now()
        }
      }

      return {
        id: `run-${provider}`,
        conversationId: '',
        task,
        steps: [
          {
            stepNumber: 1,
            thinking: 'Working on subtask',
            toolCalls: [],
            toolResults: [],
            isFinal: true,
            response: `Result from ${provider}/${model} for: ${task.substring(0, 50)}`,
            tokens: { input: 100, output: 50 }
          }
        ],
        status: 'completed' as const,
        totalTokens: { input: 100, output: 50 },
        totalCost: 0,
        durationMs: 100,
        createdAt: Date.now()
      }
    }
  }

  return {
    AgentExecutor: MockAgentExecutor,
    getAgentExecutor: () => new MockAgentExecutor()
  }
})

// Mock ToolRegistry for decompose phase
vi.mock('../../src/main/agent/tool-registry', () => {
  class MockToolRegistry {
    private tools: Map<string, { definition: unknown; handler: (args: Record<string, unknown>) => Promise<string> }> = new Map()

    registerBuiltIn(definition: { name: string }, handler: (args: Record<string, unknown>) => Promise<string>) {
      this.tools.set(definition.name, { definition, handler })
    }

    getAvailableTools() {
      return Array.from(this.tools.values()).map((t) => t.definition)
    }

    async executeTool(toolCall: { id: string; name: string; arguments: Record<string, unknown> }) {
      const tool = this.tools.get(toolCall.name)
      if (!tool) return { toolCallId: toolCall.id, content: 'Unknown tool', isError: true }

      try {
        const result = await tool.handler(toolCall.arguments)
        return { toolCallId: toolCall.id, content: result, isError: false }
      } catch {
        return { toolCallId: toolCall.id, content: 'Tool error', isError: true }
      }
    }
  }

  return {
    ToolRegistry: MockToolRegistry,
    getToolRegistry: () => new MockToolRegistry()
  }
})

// Mock MCPClientManager
vi.mock('../../src/main/mcp/mcp-client-manager', () => ({
  getMCPClientManager: () => ({
    listAllTools: () => [],
    executeTool: async () => ({ result: 'ok' })
  })
}))

// Mock ClientManager with tool-use support for decompose phase
vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: () => ({
    providerSupportsToolUse: () => true,
    sendMessageWithTools: async (_provider: string, _messages: unknown[], _model: string) => ({
      text: '',
      toolCalls: [
        {
          id: 'tc-decompose',
          name: 'decompose_task',
          arguments: {
            summary: 'Splitting task into parallel subtasks',
            subtasks: [
              { title: 'Research', description: 'Research the topic thoroughly' },
              { title: 'Analysis', description: 'Analyze the findings' },
              { title: 'Synthesis', description: 'Synthesize conclusions' }
            ]
          }
        }
      ],
      stopReason: 'tool_use',
      done: false,
      tokens: { input: 200, output: 100 }
    }),
    sendMessageNonStreaming: async () => 'Final synthesized answer combining all subtask results.'
  })
}))

// ── Import after mocks ─────────────────────────────────────

import { SubagentOrchestrator } from '../../src/main/agent/subagent-orchestrator'

// ── Test data ──────────────────────────────────────────────

const masterSlot: AgentModelSlot = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  label: 'Master'
}

// ── Tests ──────────────────────────────────────────────────

describe('SubagentOrchestrator', () => {
  let orchestrator: SubagentOrchestrator

  beforeEach(() => {
    orchestrator = new SubagentOrchestrator()
  })

  describe('decompose()', () => {
    it('should decompose a task into subtasks', async () => {
      const result = await orchestrator.decompose(
        'Research AI trends and create a summary report',
        masterSlot
      )

      expect(result).toBeDefined()
      expect(result.masterSummary).toBe('Splitting task into parallel subtasks')
      expect(result.subtasks).toHaveLength(3)
      expect(result.subtasks[0].title).toBe('Research')
      expect(result.subtasks[1].title).toBe('Analysis')
      expect(result.subtasks[2].title).toBe('Synthesis')
    })

    it('should assign IDs and order to subtasks', async () => {
      const result = await orchestrator.decompose('Test task', masterSlot)

      for (let i = 0; i < result.subtasks.length; i++) {
        expect(result.subtasks[i].id).toBeTruthy()
        expect(result.subtasks[i].order).toBe(i + 1)
      }
    })

    it('should default subtask slots to master slot', async () => {
      const result = await orchestrator.decompose('Test task', masterSlot)

      for (const subtask of result.subtasks) {
        expect(subtask.slot.provider).toBe(masterSlot.provider)
        expect(subtask.slot.model).toBe(masterSlot.model)
      }
    })
  })

  describe('executeSubtasks()', () => {
    it('should execute subtasks in parallel and return results', async () => {
      const decomposition = await orchestrator.decompose('Test task', masterSlot)
      const events: Array<{ taskId: string; type: string }> = []

      const session = {
        id: 'test-session',
        masterTask: 'Test task',
        masterSlot,
        decomposition,
        subtaskResults: [],
        synthesis: null,
        status: 'running_subtasks' as const,
        totalTokens: { input: 0, output: 0 },
        durationMs: 0,
        createdAt: Date.now()
      }

      const results = await orchestrator.executeSubtasks(
        'test-session',
        decomposition.subtasks,
        'Test task',
        (taskId, event) => events.push({ taskId, type: event.type }),
        () => {},
        session
      )

      expect(results).toHaveLength(3)
      expect(results.every((r) => r.run.status === 'completed')).toBe(true)
      expect(events.length).toBeGreaterThanOrEqual(3) // At least one event per subtask
    })

    it('should handle partial failures gracefully', async () => {
      const subtasks = [
        {
          id: 'task-ok',
          title: 'Good task',
          description: 'This should succeed',
          slot: masterSlot,
          order: 1
        },
        {
          id: 'task-fail',
          title: 'Failing task',
          description: 'This will fail',
          slot: { provider: 'failing-provider', model: 'bad-model' },
          order: 2
        }
      ]

      const session = {
        id: 'test-session-partial',
        masterTask: 'Test partial',
        masterSlot,
        decomposition: null,
        subtaskResults: [],
        synthesis: null,
        status: 'running_subtasks' as const,
        totalTokens: { input: 0, output: 0 },
        durationMs: 0,
        createdAt: Date.now()
      }

      const results = await orchestrator.executeSubtasks(
        'test-session-partial',
        subtasks,
        'Test partial',
        () => {},
        () => {},
        session
      )

      expect(results).toHaveLength(2)
      expect(results[0].run.status).toBe('completed')
      expect(results[1].run.status).toBe('failed')
      expect(results[1].error).toBe('Provider failed')
    })
  })

  describe('synthesize()', () => {
    it('should produce a synthesis from subtask results', async () => {
      const results = [
        {
          taskId: 'task-1',
          run: {
            id: 'run-1',
            conversationId: '',
            task: 'Research',
            steps: [
              {
                stepNumber: 1,
                thinking: '',
                toolCalls: [],
                toolResults: [],
                isFinal: true,
                response: 'Research findings here'
              }
            ],
            status: 'completed' as const,
            totalTokens: { input: 100, output: 50 },
            totalCost: 0,
            durationMs: 500,
            createdAt: Date.now()
          }
        }
      ]

      const synthesis = await orchestrator.synthesize(
        'Original task description',
        masterSlot,
        results
      )

      expect(synthesis).toBe('Final synthesized answer combining all subtask results.')
    })
  })

  describe('cancelSession()', () => {
    it('should return false for non-existent session', () => {
      const result = orchestrator.cancelSession('non-existent')
      expect(result).toBe(false)
    })

    it('should return active sessions', () => {
      // Initially no active sessions
      expect(orchestrator.getActiveSessions()).toEqual([])
    })
  })

  describe('full lifecycle', () => {
    it('should complete decompose → execute → synthesize', async () => {
      // Phase 1: Decompose
      const decomposition = await orchestrator.decompose(
        'Comprehensive AI market analysis',
        masterSlot
      )
      expect(decomposition.subtasks.length).toBeGreaterThanOrEqual(1)
      expect(decomposition.subtasks.length).toBeLessThanOrEqual(3)

      // Phase 2: Execute (user could override slots here)
      const session = {
        id: 'lifecycle-test',
        masterTask: 'Comprehensive AI market analysis',
        masterSlot,
        decomposition,
        subtaskResults: [],
        synthesis: null,
        status: 'running_subtasks' as const,
        totalTokens: { input: 0, output: 0 },
        durationMs: 0,
        createdAt: Date.now()
      }

      const results = await orchestrator.executeSubtasks(
        'lifecycle-test',
        decomposition.subtasks,
        'Comprehensive AI market analysis',
        () => {},
        () => {},
        session
      )

      expect(results.length).toBe(decomposition.subtasks.length)

      // Phase 3: Synthesize
      const synthesis = await orchestrator.synthesize(
        'Comprehensive AI market analysis',
        masterSlot,
        results
      )

      expect(synthesis).toBeTruthy()
      expect(typeof synthesis).toBe('string')
    })
  })
})
