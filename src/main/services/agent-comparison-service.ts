/**
 * AgentComparisonService — run N agent executions in parallel.
 *
 * Each model slot gets its own AgentExecutor instance (NOT the singleton)
 * so events, active runs, and cancellation are fully isolated.
 *
 * Uses Promise.allSettled with 100ms stagger for same-provider calls
 * (same pattern as ComparisonService).
 */

import { nanoid } from 'nanoid'
import { AgentExecutor, type AgentEvent } from '../agent/agent-executor'
import type {
  AgentModelSlot,
  AgentComparisonResult,
  AgentComparisonSession,
  Message
} from '../../shared/types'

/** Callback for per-slot agent events */
export type SlotEventHandler = (slotIndex: number, event: AgentEvent) => void

export class AgentComparisonService {
  /** Active sessions with their per-slot abort controllers */
  private activeSessions: Map<string, AbortController[]> = new Map()
  private static readonly MAX_CONCURRENT_SESSIONS = 2

  /**
   * Run N agent executions in parallel, each with their own ReAct loop.
   *
   * @param prompt - User task/question
   * @param slots - Model slots to run (max 3)
   * @param onEvent - Callback for per-slot step events
   * @param systemPrompt - Optional system prompt
   * @param conversationHistory - Optional conversation context
   */
  async runAgentComparison(
    prompt: string,
    slots: AgentModelSlot[],
    onEvent: SlotEventHandler,
    systemPrompt?: string,
    conversationHistory?: Message[]
  ): Promise<AgentComparisonSession> {
    if (slots.length === 0 || slots.length > 3) {
      throw new Error('Agent comparison requires 1-3 model slots')
    }

    // Guard: limit concurrent sessions
    if (this.activeSessions.size >= AgentComparisonService.MAX_CONCURRENT_SESSIONS) {
      throw new Error(
        `Maximum ${AgentComparisonService.MAX_CONCURRENT_SESSIONS} concurrent comparison sessions. ` +
        'Cancel an existing session first.'
      )
    }

    const sessionId = nanoid()
    const startTime = Date.now()

    const session: AgentComparisonSession = {
      id: sessionId,
      prompt,
      slots,
      results: [],
      status: 'running',
      createdAt: startTime,
      durationMs: 0
    }

    // Track abort controllers for cancellation
    const abortControllers: AbortController[] = []
    this.activeSessions.set(sessionId, abortControllers)

    // Calculate stagger delays for same-provider requests
    const providerCounts = new Map<string, number>()
    const delays = slots.map((slot) => {
      const count = providerCounts.get(slot.provider) ?? 0
      providerCounts.set(slot.provider, count + 1)
      return count * 100 // 100ms stagger per same-provider
    })

    // Create an AbortController per slot and run all in parallel
    const promises = slots.map((slot, index) => {
      const ac = new AbortController()
      abortControllers.push(ac)
      return this.runSingleSlot(
        slot,
        index,
        prompt,
        onEvent,
        delays[index],
        ac.signal,
        systemPrompt,
        conversationHistory
      )
    })

    const settled = await Promise.allSettled(promises)

    // Collect results
    const results: AgentComparisonResult[] = []
    let hasFailures = false

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]
      const slot = slots[i]

      if (outcome.status === 'fulfilled') {
        results.push(outcome.value)
        if (outcome.value.error) hasFailures = true
      } else {
        hasFailures = true
        results.push({
          slot,
          run: {
            id: nanoid(),
            conversationId: '',
            task: prompt,
            steps: [],
            status: 'failed',
            totalTokens: { input: 0, output: 0 },
            totalCost: 0,
            durationMs: 0,
            error: outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
            createdAt: startTime
          },
          error: outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason)
        })
      }
    }

    // Determine session status
    const allFailed = results.every((r) => r.error || r.run.status === 'failed')
    const someFailed = hasFailures

    session.results = results
    session.status = allFailed ? 'failed' : someFailed ? 'partial' : 'completed'
    session.durationMs = Date.now() - startTime

    // Cleanup
    this.activeSessions.delete(sessionId)

    return session
  }

  /**
   * Cancel all running agents for a session.
   */
  cancelComparison(sessionId: string): boolean {
    const controllers = this.activeSessions.get(sessionId)
    if (!controllers) return false

    for (const controller of controllers) {
      controller.abort()
    }
    this.activeSessions.delete(sessionId)
    return true
  }

  /**
   * Get active session IDs.
   */
  getActiveSessions(): string[] {
    return Array.from(this.activeSessions.keys())
  }

  /**
   * Run a single slot's agent execution.
   */
  private async runSingleSlot(
    slot: AgentModelSlot,
    slotIndex: number,
    prompt: string,
    onEvent: SlotEventHandler,
    delayMs: number,
    abortSignal: AbortSignal,
    systemPrompt?: string,
    conversationHistory?: Message[]
  ): Promise<AgentComparisonResult> {
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

    // Create isolated AgentExecutor instance
    const executor = new AgentExecutor({
      maxSteps: 5,
      maxTokensPerRun: 50000,
      toolTimeoutMs: 15000,
      runTimeoutMs: 120000
    })

    // Forward events with slot index
    executor.onEvent((event) => {
      onEvent(slotIndex, event)
    })

    // Execute the agent run
    const run = await executor.execute(
      prompt,
      slot.provider,
      slot.model,
      conversationHistory ?? [],
      systemPrompt
    )

    return {
      slot,
      run,
      error: run.status === 'failed' ? run.error : undefined
    }
  }
}

// Singleton
let agentComparisonServiceInstance: AgentComparisonService | null = null

export function getAgentComparisonService(): AgentComparisonService {
  if (!agentComparisonServiceInstance) {
    agentComparisonServiceInstance = new AgentComparisonService()
  }
  return agentComparisonServiceInstance
}
