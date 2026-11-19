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
import { postflightGuard, preflightGuard } from '../security/request-guard'
import { getGuardDeps } from '../security/request-guard-deps'

import { nanoid } from 'nanoid'
import { guardToolResults, type ToolResultOrigin } from './loop-guard'
import { originForToolCall } from '../coding/read-tools'
import {
  buildConsentRequest,
  getConsentBroker,
  resolveConsentChoice,
  type ConsentBroker,
  type ConsentDecision,
} from '../coding/consent-broker'
import type { CodingRunOptions } from '../../shared/coding-types'
import { getToolRegistry, type ToolContext, type ToolRegistry } from './tool-registry'
import { getCodingModeStore } from '../coding/coding-mode-store'
import { ensureProjectWorkspace } from '../coding/project-workspace'
import { getAgentContextManager } from './agent-context-manager'
import { getClientManager } from '../llm-clients/client-manager'
import type { ToolUseResponse } from '../llm-clients/client-manager'
import { getCircuitBreaker } from '../security/circuit-breaker'
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

/**
 * Collaborators an executor may be built with.
 *
 * Only the consent broker so far: it owns a dialog, and a test that drives the
 * pause must be able to answer — or deliberately not answer — without a
 * renderer on the other end of the IPC.
 */
export interface AgentExecutorDeps {
  consentBroker?: ConsentBroker
}

export class AgentExecutor {
  private config: AgentConfig
  private eventHandlers: AgentEventHandler[] = []
  private activeRuns: Map<string, AbortController> = new Map()
  private readonly consentBroker: ConsentBroker

  constructor(config?: Partial<AgentConfig>, deps?: AgentExecutorDeps) {
    this.config = { ...DEFAULT_AGENT_CONFIG, ...config }
    this.consentBroker = deps?.consentBroker ?? getConsentBroker()
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
   * @param coding - Coding-run context (optional). Left out by the comparison
   *                 and subagent callers, which therefore get no coding run.
   *                 It selects the coding tool surface (via ToolContext) and the
   *                 project workspace that externalized results go to. The mode
   *                 it claims must equal the one the CodingModeStore holds for
   *                 its directory, otherwise the run ends: the renderer cannot
   *                 hand itself a mode the store does not give.
   */
  async execute(
    task: string,
    provider: string,
    model: string,
    conversationHistory: Message[] = [],
    systemPrompt?: string,
    coding?: CodingRunOptions
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

    // Circuit Breaker: Check concurrent agent run limit
    const circuitBreaker = getCircuitBreaker()
    const concurrencyCheck = circuitBreaker.canStartAgentRun(runId)
    if (!concurrencyCheck.allowed) {
      run.status = 'failed'
      run.error = concurrencyCheck.reason
      run.durationMs = Date.now() - startTime
      this.emit({ type: 'run_complete', runId, run })
      return run
    }

    // Pre-flight security guard — the agent path calls the LLM directly and
    // otherwise bypasses the chat guards. Fail closed: end the run if blocked.
    const preflight = await preflightGuard(
      { texts: [...conversationHistory.map((m) => m.content), task], provider, model, conversationId: run.conversationId },
      getGuardDeps(),
    )
    if (!preflight.ok) {
      run.status = 'failed'
      run.error = preflight.reason ?? 'Blocked by security guard'
      run.durationMs = Date.now() - startTime
      this.emit({ type: 'run_complete', runId, run })
      return run
    }
    provider = preflight.provider

    // Run timeout.
    //
    // Re-armable, because it is SUSPENDED while a consent dialog is open: the
    // run gets `runTimeoutMs` of its own work, not of the user's thinking. A
    // dialog that kills the run would teach the user to click without reading,
    // which is the opposite of what asking is for.
    let runTimeout: ReturnType<typeof setTimeout> | undefined
    /** Total wall time this run spent waiting for a human. */
    let consentWaitMs = 0
    const armRunTimeout = (): void => {
      const spentWorking = Date.now() - startTime - consentWaitMs
      const remaining = this.config.runTimeoutMs - spentWorking
      // A non-positive remainder means the budget really is used up outside the
      // dialog: the timer then fires on the next tick rather than never.
      runTimeout = setTimeout(() => {
        abortController.abort()
      }, Math.max(0, remaining))
    }
    armRunTimeout()

    try {
      // Verify provider supports tool-use
      const clientManager = getClientManager()
      if (!clientManager.providerSupportsToolUse(provider)) {
        throw new Error(
          `Provider "${provider}" does not support tool-use. Use Anthropic or OpenAI.`
        )
      }

      // Coding run: verify the claimed mode against the store, then create the
      // project workspace ONCE. Everything below consumes this single instance.
      // Fail closed: a store that throws, an unknown directory (reads as `off`)
      // or a workspace that cannot be created all end the run before any model
      // call, via the catch below.
      let toolCtx: ToolContext | undefined
      let contextDir: string | undefined
      if (coding) {
        const storedMode = getCodingModeStore().getMode(coding.directoryId)
        if (coding.mode !== storedMode) {
          throw new Error(
            `Coding mode mismatch: run claims "${String(coding.mode)}" but the stored mode is "${storedMode}"`
          )
        }
        // Mode `off` is a plain run: no workspace (creating one could even
        // throw in a project where a plain run works), no tool context. The
        // mismatch check above still applies to it.
        if (storedMode !== 'off') {
          const workspace = await ensureProjectWorkspace(coding.projectPath, runId)
          contextDir = workspace.contextDir
          toolCtx = { coding, workspace, resolvedPaths: new Map<string, string>() }
        }
      }

      // Get available tools
      const toolRegistry = getToolRegistry()
      toolRegistry.refreshMCPTools()
      const tools = toolRegistry.getAvailableTools(toolCtx)

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

        // Post-flight output guardrails — every LLM turn, not just the last:
        // an intermediate turn is what the next tool call is built from.
        // Tokens are counted first, so a blocked turn still shows its cost.
        const postflight = postflightGuard(llmResponse.text, systemPrompt ?? '', getGuardDeps())
        if (!postflight.ok) {
          // `blocking` is the guard's own answer to which severities blocked.
          // Re-deriving it here would be a second answer that can drift from
          // the one that actually ended the run.
          run.status = 'failed'
          run.error =
            'Output blocked by guardrails: ' +
            postflight.blocking.map((v) => `${v.type} (${v.severity})`).join(', ')
          break
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
        const rawToolResults = await toolRegistry.executeToolCalls(llmResponse.toolCalls, toolCtx)

        // The guard inside the loop. Tool results are content the AGENT
        // collected; the pre-flight guard above never saw them, yet every
        // later sendMessageWithTools call ships them to the provider.
        //
        // Runs BEFORE compaction: compaction keeps a raw 200-character preview
        // of the result, and that preview is the part that travels. Checking
        // afterwards would check what no longer goes out and pass what does.
        //
        // Fail closed on `blocked`: the run ends with the reason, like the
        // pre-flight above. The step is deliberately not pushed and no
        // step_complete is emitted — blocked content must not travel onwards to
        // the renderer either. A `consent` finding is the one outcome that does
        // not end the run: it is put to the user below.
        // originForToolCall fills ToolResultOrigin.filePath from the path the tool
        // RESOLVED and read, so the consent dialog and the withheld notice name
        // the file that was read, not the spelling the model wrote.
        const origins = rawToolResults.map((r): ToolResultOrigin => {
          const call = llmResponse.toolCalls.find((tc) => tc.id === r.toolCallId)
          if (!call) return { toolName: 'unknown' }
          // Keyed by call id: the same spelling twice (paging) and other tools
          // with a `path` argument cannot confuse two calls.
          const resolved = toolCtx?.resolvedPaths?.get(call.id)
          toolCtx?.resolvedPaths?.delete(call.id)
          return originForToolCall(call, resolved)
        })
        const guardCtx = { provider, model, conversationId: run.conversationId }

        // A `consent` outcome settles ONE result, then the guard continues over
        // the rest of the step from the next index. The loop is bounded: every
        // round moves `guardFrom` forward by at least one, and the dispatch
        // phase inside the guard always sees the whole, final step content.
        let guardFrom = 0
        let loopGuard = await guardToolResults(
          rawToolResults,
          origins,
          guardCtx,
          getGuardDeps(),
          guardFrom,
        )

        while (loopGuard.kind === 'consent') {
          // Already aborted — the timeout can fire between the tool call and
          // here. Asking now would be a dialog for a dead run, and the abort
          // listener below would never fire for a signal that is already
          // aborted, so the run would wait for an answer forever.
          if (abortController.signal.aborted) {
            run.status = 'cancelled'
            break
          }

          const index = loopGuard.index
          const request = buildConsentRequest({
            runId,
            stepNumber: stepNum,
            origin: loopGuard.origin,
            scan: loopGuard.scanResult,
          })

          // Timeout off for the duration of the question, then re-armed with
          // what is left of the run's OWN time.
          clearTimeout(runTimeout)
          const askedAt = Date.now()
          // An aborted run must not leave the dialog pending: the broker
          // settles it to 'drop-file' rather than let the promise hang.
          const onAbort = (): void => this.consentBroker.cancel(runId)
          abortController.signal.addEventListener('abort', onAbort, { once: true })

          // The fail-closed default, in place before anything can throw.
          let decision: ConsentDecision = { choice: 'drop-file', decidedBy: 'system' }
          try {
            decision = await this.consentBroker.askWithSource(request)
          } finally {
            abortController.signal.removeEventListener('abort', onAbort)
            consentWaitMs += Date.now() - askedAt
            armRunTimeout()
          }

          if (abortController.signal.aborted) {
            run.status = 'cancelled'
            break
          }

          const resolution = await resolveConsentChoice({
            choice: decision.choice,
            decidedBy: decision.decidedBy,
            runId,
            origin: loopGuard.origin,
            content: rawToolResults[index].content,
          })
          rawToolResults[index] = { ...rawToolResults[index], content: resolution.content }

          guardFrom = index + 1
          loopGuard = await guardToolResults(
            rawToolResults,
            origins,
            guardCtx,
            getGuardDeps(),
            guardFrom,
          )
        }

        // The cancellation inside the loop above has to leave the ReAct loop too.
        if (run.status === 'cancelled') break

        if (loopGuard.kind === 'blocked') {
          run.status = 'failed'
          run.error = loopGuard.reason
          break
        }
        // `provider` is deliberately NOT reassigned from the guard: a budget or
        // routing fallback inside the loop is blocked above, for every run type.
        // Adopting one would send content that guardInput only ever checked
        // against the previous provider.

        // Task 4: File-based context — externalize large tool results to files.
        // A coding run externalizes INTO the project workspace (`contextDir`),
        // so project content never reaches os.tmpdir(); every other run keeps
        // the temp directory. `contextDir` stays undefined only for non-coding
        // runs, because a coding run without a workspace has already ended above.
        const contextManager = getAgentContextManager()
        const toolResults = rawToolResults.map((r) =>
          contextManager.compactToolResult(runId, r, contextDir)
        )
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
      circuitBreaker.endAgentRun(runId)
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
