/**
 * SubagentOrchestrator — Master → N Subtasks → N ReAct Loops → Merge.
 *
 * Lifecycle:
 * 1. decompose(): Master LLM uses decompose_task tool to split task into 1-3 subtasks
 * 2. executeSubtasks(): N AgentExecutor instances run in parallel (each with full tool access)
 * 3. synthesize(): Master LLM merges subtask results into final answer
 *
 * Each phase can be cancelled. The user can override provider/model per subtask
 * between decompose() and executeSubtasks() (local vs cloud choice).
 */

import { nanoid } from 'nanoid'
import { AgentExecutor, type AgentEvent } from './agent-executor'
import { ToolRegistry } from './tool-registry'
import { getMCPClientManager } from '../mcp/mcp-client-manager'
import { getClientManager } from '../llm-clients/client-manager'
import type {
  AgentModelSlot,
  SubagentTask,
  TaskDecomposition,
  SubagentResult,
  SubagentSession,
  Message,
  ToolDefinition
} from '../../shared/types'

export type SubagentEventHandler = (taskId: string, event: AgentEvent) => void
export type SubagentStatusHandler = (session: SubagentSession) => void

export class SubagentOrchestrator {
  private activeSessions: Map<string, AbortController[]> = new Map()
  private static readonly MAX_CONCURRENT_SESSIONS = 2
  private static readonly MAX_TITLE_LENGTH = 200
  private static readonly MAX_DESCRIPTION_LENGTH = 2000

  /**
   * Phase 1: Decompose a task into subtasks.
   *
   * Creates a temporary AgentExecutor with ONLY the decompose_task tool.
   * The master LLM is forced to use it, producing structured output.
   */
  async decompose(
    task: string,
    masterSlot: AgentModelSlot,
    conversationHistory?: Message[],
    systemPrompt?: string
  ): Promise<TaskDecomposition> {
    // Create a special ToolRegistry with ONLY decompose_task
    const decomposeRegistry = new ToolRegistry()
    decomposeRegistry.registerBuiltIn(
      {
        name: 'decompose_task',
        description:
          'Decompose the given task into 1-3 independent subtasks that can be executed in parallel. ' +
          'Each subtask should be self-contained and produce a clear result.',
        inputSchema: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'Brief summary of the overall task and decomposition strategy'
            },
            subtasks: {
              type: 'array',
              description: 'Array of 1-3 independent subtasks',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Short title for the subtask' },
                  description: {
                    type: 'string',
                    description: 'Detailed description of what this subtask should accomplish'
                  }
                },
                required: ['title', 'description']
              }
            }
          },
          required: ['summary', 'subtasks']
        }
      },
      async (args) => {
        const subtasks = args.subtasks as Array<{ title: string; description: string }> | undefined
        if (!subtasks || subtasks.length === 0) {
          return JSON.stringify({ error: 'At least 1 subtask required' })
        }
        return JSON.stringify({
          summary: String(args.summary ?? ''),
          subtasks: subtasks.slice(0, 3).map((st, idx) => ({
            title: st.title,
            description: st.description,
            order: idx + 1
          }))
        })
      }
    )

    // Build the decomposition prompt
    const decomposePrompt =
      (systemPrompt ? systemPrompt + '\n\n' : '') +
      'You are a task decomposition expert. Analyze the following task and use the decompose_task tool ' +
      'to break it into 1-3 independent subtasks that can be executed in parallel.\n\n' +
      'Rules:\n' +
      '- Each subtask must be self-contained and independently executable\n' +
      '- Maximum 3 subtasks\n' +
      '- Subtasks should cover different aspects of the main task\n' +
      '- You MUST call the decompose_task tool with your decomposition\n\n' +
      `Task: ${task}`

    // Use the LLM with only decompose_task available
    const clientManager = getClientManager()

    if (!clientManager.providerSupportsToolUse(masterSlot.provider)) {
      throw new Error(
        `Provider "${masterSlot.provider}" does not support tool-use. ` +
        'Choose a provider with tool-use support (Anthropic, OpenAI, Ollama) for the master agent.'
      )
    }

    const tools = decomposeRegistry.getAvailableTools()
    const messages: Message[] = [
      ...(conversationHistory ?? []).filter((m) => m.role !== 'system'),
      { id: nanoid(), role: 'user', content: decomposePrompt }
    ]

    const response = await clientManager.sendMessageWithTools(
      masterSlot.provider,
      messages,
      masterSlot.model,
      tools
    )

    // Parse the tool call result
    if (response.toolCalls.length === 0) {
      throw new Error(
        'Master agent did not use decompose_task tool. ' +
        'If using a local model (Ollama), ensure it supports function calling ' +
        '(e.g. llama3.1, qwen2.5, mistral). ' +
        `Response: ${response.text.substring(0, 200)}`
      )
    }

    const decomposeCall = response.toolCalls.find((tc) => tc.name === 'decompose_task')
    if (!decomposeCall) {
      throw new Error('Master agent called an unexpected tool instead of decompose_task')
    }

    // Execute the tool to get validated result
    const toolResult = await decomposeRegistry.executeTool(decomposeCall)
    if (toolResult.isError) {
      throw new Error(`Decomposition failed: ${toolResult.content}`)
    }

    let parsed: {
      summary: string
      subtasks: Array<{ title: string; description: string; order: number }>
      error?: string
    }
    try {
      parsed = JSON.parse(toolResult.content)
    } catch {
      throw new Error(
        'Decomposition returned invalid JSON. This may happen with some local models. ' +
        `Raw response: ${toolResult.content.substring(0, 200)}`
      )
    }

    if (parsed.error) {
      throw new Error(`Decomposition error: ${parsed.error}`)
    }

    // Convert to SubagentTask format (default: same provider/model as master)
    const subtasks: SubagentTask[] = parsed.subtasks.map((st, idx) => ({
      id: nanoid(),
      title: st.title,
      description: st.description,
      slot: { ...masterSlot }, // Default to master slot, user can override
      order: st.order ?? idx + 1
    }))

    return {
      masterSummary: parsed.summary,
      subtasks
    }
  }

  /**
   * Phase 2: Execute subtasks in parallel.
   *
   * Each subtask gets its own AgentExecutor with full tool access
   * (all MCP tools + built-ins EXCEPT decompose_task).
   */
  async executeSubtasks(
    sessionId: string,
    tasks: SubagentTask[],
    originalTask: string,
    onSubtaskEvent: SubagentEventHandler,
    onStatusChange: SubagentStatusHandler,
    session: SubagentSession
  ): Promise<SubagentResult[]> {
    // Guard: limit concurrent sessions
    if (this.activeSessions.size >= SubagentOrchestrator.MAX_CONCURRENT_SESSIONS) {
      throw new Error(
        `Maximum ${SubagentOrchestrator.MAX_CONCURRENT_SESSIONS} concurrent subagent sessions. ` +
        'Cancel an existing session first.'
      )
    }

    const abortControllers: AbortController[] = []
    this.activeSessions.set(sessionId, abortControllers)

    session.status = 'running_subtasks'
    onStatusChange(session)

    // Calculate stagger delays for same-provider
    const providerCounts = new Map<string, number>()
    const delays = tasks.map((task) => {
      const count = providerCounts.get(task.slot.provider) ?? 0
      providerCounts.set(task.slot.provider, count + 1)
      return count * 100
    })

    // Create an AbortController per task and pass signal to runSubtask
    const promises = tasks.map((task, index) => {
      const ac = new AbortController()
      abortControllers.push(ac)
      return this.runSubtask(task, originalTask, onSubtaskEvent, delays[index], ac.signal)
    })

    const settled = await Promise.allSettled(promises)

    const results: SubagentResult[] = settled.map((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        return outcome.value
      }
      return {
        taskId: tasks[index].id,
        run: {
          id: nanoid(),
          conversationId: '',
          task: tasks[index].description,
          steps: [],
          status: 'failed' as const,
          totalTokens: { input: 0, output: 0 },
          totalCost: 0,
          durationMs: 0,
          error: outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
          createdAt: Date.now()
        },
        error: outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason)
      }
    })

    this.activeSessions.delete(sessionId)
    return results
  }

  /**
   * Phase 3: Synthesize results into final answer.
   *
   * Single non-streaming LLM call to master model with subtask results as context.
   */
  async synthesize(
    originalTask: string,
    masterSlot: AgentModelSlot,
    subtaskResults: SubagentResult[]
  ): Promise<string> {
    const clientManager = getClientManager()

    // Build synthesis context
    const resultsContext = subtaskResults
      .map((result, idx) => {
        const taskTitle = result.taskId
        const status = result.run.status
        const finalStep = result.run.steps.find((s) => s.isFinal)
        const answer = finalStep?.response ?? result.run.error ?? 'No result'

        return `=== Subtask ${idx + 1} (${status}) ===\n${answer}`
      })
      .join('\n\n')

    const synthesisPrompt =
      'You are synthesizing results from parallel subtask executions.\n\n' +
      `Original Task: ${originalTask}\n\n` +
      `Subtask Results:\n${resultsContext}\n\n` +
      'Please provide a comprehensive, well-structured final answer that integrates all subtask results. ' +
      'If any subtask failed, note what was unavailable and work with what you have.'

    const messages: Message[] = [
      { id: nanoid(), role: 'user', content: synthesisPrompt }
    ]

    const response = await clientManager.sendMessageNonStreaming(
      masterSlot.provider,
      messages,
      masterSlot.model
    )

    return response
  }

  /**
   * Cancel all running subtasks for a session.
   */
  cancelSession(sessionId: string): boolean {
    const controllers = this.activeSessions.get(sessionId)
    if (!controllers) return false

    for (const controller of controllers) {
      controller.abort()
    }
    this.activeSessions.delete(sessionId)
    return true
  }

  getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys())
  }

  // ── Private ────────────────────────────────────────────────────

  /**
   * Run a single subtask with its own AgentExecutor.
   */
  private async runSubtask(
    task: SubagentTask,
    originalTaskContext: string,
    onEvent: SubagentEventHandler,
    delayMs: number,
    abortSignal: AbortSignal
  ): Promise<SubagentResult> {
    // Abortable stagger delay
    if (delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        if (abortSignal.aborted) return reject(new Error('Cancelled'))
        const timer = setTimeout(resolve, delayMs)
        abortSignal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('Cancelled'))
        }, { once: true })
      })
    }

    // Check abort before starting execution
    if (abortSignal.aborted) {
      throw new Error('Cancelled')
    }

    // Create isolated executor with progress recitation + error preservation
    const executor = new AgentExecutor({
      maxSteps: 5,
      maxTokensPerRun: 50000,
      toolTimeoutMs: 15000,
      runTimeoutMs: 120000,
      enableProgressRecitation: true,
      enableErrorPreservation: true
    })

    // Forward events with taskId
    executor.onEvent((event) => {
      onEvent(task.id, event)
    })

    // Sanitize subtask fields to limit injection surface
    const safeTitle = task.title.substring(0, SubagentOrchestrator.MAX_TITLE_LENGTH)
    const safeDescription = task.description.substring(0, SubagentOrchestrator.MAX_DESCRIPTION_LENGTH)

    // Build subtask prompt with context
    const subtaskPrompt =
      `You are working on a subtask as part of a larger task.\n\n` +
      `Original Task: ${originalTaskContext}\n\n` +
      `Your Subtask: ${safeTitle}\n` +
      `Description: ${safeDescription}\n\n` +
      `Complete this subtask thoroughly and provide a clear result.`

    const run = await executor.execute(
      subtaskPrompt,
      task.slot.provider,
      task.slot.model
    )

    return {
      taskId: task.id,
      run,
      error: run.status === 'failed' ? run.error : undefined
    }
  }
}

// Singleton
let orchestratorInstance: SubagentOrchestrator | null = null

export function getSubagentOrchestrator(): SubagentOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new SubagentOrchestrator()
  }
  return orchestratorInstance
}
