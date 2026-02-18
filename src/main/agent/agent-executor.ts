/**
 * AgentExecutor — ReAct-Loop with Safety Rails.
 *
 * Orchestrates the Reason-Act cycle:
 * 1. Send messages + tools to LLM → get response
 * 2. If response has tool_calls → execute via ToolRegistry
 * 3. Inject tool results into conversation → next iteration
 * 4. Repeat until: final answer, max steps, token budget, timeout, or cancellation
 *
 * Safety Rails:
 * - Max steps per run (default: 5)
 * - Max tokens per run (default: 50000)
 * - Per-tool timeout (handled by ToolRegistry)
 * - Total run timeout (default: 120s)
 * - Cancellation via AbortController
 * - Step-by-step event emission for UI tracking
 */

import { nanoid } from 'nanoid'
import { getToolRegistry, type ToolRegistry } from './tool-registry'
import { getAgentContextManager } from './agent-context-manager'
import { getClientManager } from '../llm-clients/client-manager'
import type { ToolUseResponse } from '../llm-clients/client-manager'
import type {
  Message,
  AgentConfig,
  AgentRun,
  AgentStep,
  AgentToolCall,
  AgentToolResult,
  ToolDefinition
} from '../../shared/types'

// ── Default configuration ──────────────────────────────────────

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  maxSteps: 5,
  maxTokensPerRun: 50000,
  toolTimeoutMs: 15000,
  runTimeoutMs: 120000,
  enableProgressRecitation: true,
  enableErrorPreservation: true
}

// ── Event types for step tracking ──────────────────────────────

export type AgentEventType = 'step_start' | 'step_complete' | 'run_complete'

export interface AgentEvent {
  type: AgentEventType
  runId: string
  step?: AgentStep
  run?: AgentRun
}

export type AgentEventHandler = (event: AgentEvent) => void

// ── AgentExecutor ──────────────────────────────────────────────

export class AgentExecutor {
  private config: AgentConfig
  private eventHandlers: AgentEventHandler[] = []
  private activeRuns: Map<string, AbortController> = new Map()

  constructor(config?: Partial<AgentConfig>) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config }
  }

  // ── Configuration ────────────────────────────────────────────

  getConfig(): AgentConfig {
    return { ...this.config }
  }

  updateConfig(updates: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...updates }
  }

  // ── Event handling ───────────────────────────────────────────

  onEvent(handler: AgentEventHandler): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
    }
  }

  private emit(event: AgentEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (err) {
        console.warn('Agent event handler error:', err)
      }
    }
  }

  // ── Cancellation ─────────────────────────────────────────────

  cancelRun(runId: string): boolean {
    const controller = this.activeRuns.get(runId)
    if (controller) {
      controller.abort()
      return true
    }
    return false
  }

  getActiveRunIds(): string[] {
    return Array.from(this.activeRuns.keys())
  }

  // ── Main execution loop ──────────────────────────────────────

  /**
   * Execute an agent run: ReAct loop until completion.
   *
   * @param task - User task/question (becomes the last user message)
   * @param provider - LLM provider to use (must support tool-use)
   * @param model - Model name
   * @param conversationHistory - Previous messages (optional context)
   * @param systemPrompt - System prompt (optional)
   */
  async execute(
    task: string,
    provider: string,
    model: string,
    conversationHistory: Message[] = [],
    systemPrompt?: string
  ): Promise<AgentRun> {
    const runId = nanoid()
    const startTime = Date.now()
    const abortController = new AbortController()
    this.activeRuns.set(runId, abortController)

    // Initialize run state
    const run: AgentRun = {
      id: runId,
      conversationId: conversationHistory[0]?.conversationId ?? '',
      task,
      steps: [],
      status: 'running',
      totalTokens: { input: 0, output: 0 },
      totalCost: 0,
      durationMs: 0,
      createdAt: startTime
    }

    // Run timeout
    const runTimeout = setTimeout(() => {
      abortController.abort()
    }, this.config.runTimeoutMs)

    try {
      // Verify provider supports tool-use
      const clientManager = getClientManager()
      if (!clientManager.providerSupportsToolUse(provider)) {
        throw new Error(
          `Provider "${provider}" does not support tool-use. Use Anthropic or OpenAI.`
        )
      }

      // Get available tools
      const toolRegistry = getToolRegistry()
      toolRegistry.refreshMCPTools()
      const tools = toolRegistry.getAvailableTools()

      if (tools.length === 0) {
        throw new Error(
          'No tools available. Connect at least one MCP server or ensure built-in tools are registered.'
        )
      }

      // Build initial conversation messages
      const messages = this.buildInitialMessages(
        conversationHistory,
        task,
        systemPrompt
      )

      // ── ReAct Loop ─────────────────────────────────────────

      for (let stepNum = 1; stepNum <= this.config.maxSteps; stepNum++) {
        // Check cancellation
        if (abortController.signal.aborted) {
          run.status = 'cancelled'
          break
        }

        // Check token budget
        if (this.isTokenBudgetExhausted(run)) {
          run.status = 'max_steps_reached'
          run.error = `Token budget exhausted (${run.totalTokens.input + run.totalTokens.output}/${this.config.maxTokensPerRun})`
          break
        }

        // Emit step_start event
        this.emit({ type: 'step_start', runId, step: { stepNumber: stepNum, thinking: '', toolCalls: [], toolResults: [], isFinal: false } })

        // Call LLM with tools
        const llmResponse = await clientManager.sendMessageWithTools(
          provider,
          messages,
          model,
          tools
        )

        // Update token tracking
        if (llmResponse.tokens) {
          run.totalTokens.input += llmResponse.tokens.input
          run.totalTokens.output += llmResponse.tokens.output
        }

        // Build step
        const step: AgentStep = {
          stepNumber: stepNum,
          thinking: llmResponse.text,
          toolCalls: llmResponse.toolCalls,
          toolResults: [],
          isFinal: llmResponse.stopReason === 'stop',
          tokens: llmResponse.tokens
        }

        // If this is a final answer (no tool calls), we're done
        if (step.isFinal || llmResponse.toolCalls.length === 0) {
          step.isFinal = true
          step.response = llmResponse.text
          run.steps.push(step)
          run.status = 'completed'
          this.emit({ type: 'step_complete', runId, step })
          break
        }

        // Execute tool calls
        const rawToolResults = await toolRegistry.executeToolCalls(llmResponse.toolCalls)

        // Task 4: File-based context — externalize large tool results to temp files
        const contextManager = getAgentContextManager()
        const toolResults = rawToolResults.map((r) => contextManager.compactToolResult(runId, r))
        step.toolResults = toolResults

        run.steps.push(step)
        this.emit({ type: 'step_complete', runId, step })

        // Add assistant message (with tool calls) to conversation
        messages.push({
          id: nanoid(),
          role: 'assistant',
          content: llmResponse.text,
          toolCalls: llmResponse.toolCalls
        })

        // Add tool result messages to conversation
        for (const result of toolResults) {
          messages.push({
            id: nanoid(),
            role: 'tool',
            content: this.config.enableErrorPreservation
              ? result.content  // Keep full error content (Task 2: Error Preservation)
              : result.isError
                ? `Error: ${result.content.substring(0, 500)}`
                : result.content,
            toolCallId: result.toolCallId
          })
        }

        // Task 1: Progress Recitation — inject step summary to keep agent on track
        if (this.config.enableProgressRecitation && run.steps.length >= 2) {
          const recitation = this.buildProgressRecitation(run, this.config.maxSteps)
          messages.push({
            id: nanoid(),
            role: 'user',
            content: recitation
          })
        }

        // Check if this was the last allowed step
        if (stepNum === this.config.maxSteps) {
          run.status = 'max_steps_reached'
          run.error = `Maximum steps reached (${this.config.maxSteps})`
        }
      }

      // If still running after loop (shouldn't happen), mark as completed
      if (run.status === 'running') {
        run.status = 'completed'
      }
    } catch (error) {
      run.status = abortController.signal.aborted ? 'cancelled' : 'failed'
      run.error = (error as Error).message
    } finally {
      clearTimeout(runTimeout)
      this.activeRuns.delete(runId)
      run.durationMs = Date.now() - startTime

      // Task 4: Clean up externalized temp files after run completion
      try {
        getAgentContextManager().cleanup(runId)
      } catch {
        // Ignore cleanup errors
      }

      this.emit({ type: 'run_complete', runId, run })
    }

    return run
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * Build the initial message array for the agent run.
   *
   * KV-Cache optimization: the message structure is designed so that the
   * stable prefix (system prompt) is always first and never changes between
   * turns. Tool definitions are sorted alphabetically by ToolRegistry.
   * Only new messages are appended — the prefix stays cacheable.
   */
  private buildInitialMessages(
    history: Message[],
    task: string,
    systemPrompt?: string
  ): Message[] {
    const messages: Message[] = []

    // Stable prefix: system prompt always first (cacheable across turns)
    if (systemPrompt) {
      messages.push({
        id: 'sys-prompt', // Stable ID for cache consistency
        role: 'system',
        content: systemPrompt
      })
    }

    // Conversation history (filter out system messages to avoid duplicates)
    // Append-only: never reorder existing messages
    for (const msg of history) {
      if (msg.role !== 'system') {
        messages.push({ ...msg })
      }
    }

    // Task as the latest user message
    messages.push({
      id: nanoid(),
      role: 'user',
      content: task
    })

    return messages
  }

  /**
   * Check if the token budget for this run is exhausted.
   */
  private isTokenBudgetExhausted(run: AgentRun): boolean {
    const totalUsed = run.totalTokens.input + run.totalTokens.output
    return totalUsed >= this.config.maxTokensPerRun
  }

  /**
   * Build a compact progress recitation for the agent.
   * Injected as a user message after tool results to keep the agent
   * focused on what was done and what remains (prevents Lost-in-the-Middle).
   *
   * Format:
   *   [Progress: Step 2/5]
   *   ✅ Step 1: search_docs → found 3 results
   *   ✅ Step 2: read_file → read 200 lines
   *   ⏳ Steps remaining: 3
   */
  private buildProgressRecitation(run: AgentRun, maxSteps: number): string {
    const completedSteps = run.steps.map((step) => {
      const toolNames = step.toolCalls.map((tc) => tc.name).join(', ')
      const hasError = step.toolResults.some((r) => r.isError)
      const icon = hasError ? '⚠️' : '✅'
      const summary = toolNames
        ? `${toolNames}${hasError ? ' (error)' : ''}`
        : 'reasoning'
      return `${icon} Step ${step.stepNumber}: ${summary}`
    })

    const remaining = maxSteps - run.steps.length
    const lines = [
      `[Progress: Step ${run.steps.length}/${maxSteps}]`,
      ...completedSteps,
      `⏳ Steps remaining: ${remaining}`,
      'Continue working on the original task. Do not repeat completed steps.'
    ]

    return lines.join('\n')
  }
}

// ── Singleton ──────────────────────────────────────────────────

let executorInstance: AgentExecutor | null = null

export function getAgentExecutor(): AgentExecutor {
  if (!executorInstance) {
    executorInstance = new AgentExecutor()
  }
  return executorInstance
}
