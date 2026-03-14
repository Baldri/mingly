/**
 * Circuit Breaker — Runaway Agent & Cost Protection.
 *
 * Prevents uncontrolled spending by enforcing cost limits at three levels:
 * - Per-request: Max cost for a single LLM call
 * - Per-session: Max cost within one conversation session
 * - Per-day: Max cost across all conversations in 24h
 *
 * Also enforces:
 * - Max turns per session (prevents infinite agent loops)
 * - Max concurrent agent runs
 * - Cooldown after limit breach
 *
 * State machine: CLOSED (normal) → OPEN (blocked) → HALF_OPEN (probe)
 */

import { getTrackingEngine } from '../tracking/tracking-engine'

// ── Types ──────────────────────────────────────────────────────

export interface CircuitBreakerConfig {
  maxCostPerRequestCents: number     // Default: 50 (CHF 0.50)
  maxCostPerSessionCents: number     // Default: 1000 (CHF 10.00)
  maxCostPerDayCents: number         // Default: 5000 (CHF 50.00)
  maxTurnsPerSession: number         // Default: 50
  maxConcurrentAgentRuns: number     // Default: 3
  maxInputTokensPerRequest: number   // Default: 128000
  maxOutputTokensPerRequest: number  // Default: 8192
  warningThresholdPercent: number    // Default: 80
  cooldownAfterLimitMs: number       // Default: 60000 (1 min)
}

export type CircuitState = 'closed' | 'open' | 'half_open'

export type CircuitEventType =
  | 'cost_warning'
  | 'cost_exceeded'
  | 'circuit_opened'
  | 'circuit_half_open'
  | 'circuit_closed'
  | 'turns_exceeded'
  | 'tokens_exceeded'
  | 'concurrent_limit'
  | 'fallback_triggered'

export interface CircuitEvent {
  type: CircuitEventType
  level: 'warning' | 'error'
  message: string
  details: {
    limit?: number
    current?: number
    percent?: number
    conversationId?: string
    provider?: string
  }
}

export type CircuitEventHandler = (event: CircuitEvent) => void

export interface CircuitCheckResult {
  allowed: boolean
  reason?: string
  warnings: CircuitEvent[]
  state: CircuitState
}

// ── Default Config ─────────────────────────────────────────────

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  maxCostPerRequestCents: 50,       // CHF 0.50
  maxCostPerSessionCents: 1000,     // CHF 10.00
  maxCostPerDayCents: 5000,         // CHF 50.00
  maxTurnsPerSession: 50,
  maxConcurrentAgentRuns: 3,
  maxInputTokensPerRequest: 128_000,  // Most models support 128k context
  maxOutputTokensPerRequest: 8192,    // Safe default for output
  warningThresholdPercent: 80,
  cooldownAfterLimitMs: 60_000
}

// ── Circuit Breaker ────────────────────────────────────────────

export class CircuitBreaker {
  private config: CircuitBreakerConfig
  private state: CircuitState = 'closed'
  private stateChangedAt: number = Date.now()
  private eventHandlers: CircuitEventHandler[] = []

  // Session tracking (in-memory, resets on app restart)
  private sessionTurns: Map<string, number> = new Map()
  private sessionCosts: Map<string, number> = new Map()
  private activeAgentRuns: Set<string> = new Set()

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // ── Configuration ──────────────────────────────────────────

  getConfig(): CircuitBreakerConfig {
    return { ...this.config }
  }

  updateConfig(updates: Partial<CircuitBreakerConfig>): void {
    this.config = { ...this.config, ...updates }
  }

  getState(): CircuitState {
    return this.state
  }

  // ── Event Handling ─────────────────────────────────────────

  onEvent(handler: CircuitEventHandler): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
    }
  }

  private emit(event: CircuitEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (err) {
        console.warn('[CircuitBreaker] Event handler error:', err)
      }
    }
  }

  // ── State Transitions ──────────────────────────────────────

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return
    const oldState = this.state
    this.state = newState
    this.stateChangedAt = Date.now()
    console.log(`[CircuitBreaker] ${oldState} → ${newState}`)

    const eventType: CircuitEventType =
      newState === 'open' ? 'circuit_opened'
        : newState === 'half_open' ? 'circuit_half_open'
          : 'circuit_closed'

    this.emit({
      type: eventType,
      level: newState === 'open' ? 'error' : 'warning',
      message: `Circuit breaker state: ${newState}`,
      details: {}
    })
  }

  // ── Main Check: Can this request proceed? ──────────────────

  canExecute(params: {
    conversationId: string
    provider: string
    model: string
    estimatedCostCents: number
    estimatedInputTokens?: number
    estimatedOutputTokens?: number
  }): CircuitCheckResult {
    const warnings: CircuitEvent[] = []
    const { conversationId, provider, estimatedCostCents } = params
    const warningPct = this.config.warningThresholdPercent / 100

    // 1. Check circuit state
    if (this.state === 'open') {
      const elapsed = Date.now() - this.stateChangedAt
      if (elapsed < this.config.cooldownAfterLimitMs) {
        return {
          allowed: false,
          reason: `Circuit breaker is open. Cooldown: ${Math.ceil((this.config.cooldownAfterLimitMs - elapsed) / 1000)}s remaining.`,
          warnings,
          state: this.state
        }
      }
      // Cooldown expired → half_open (allow one probe request)
      this.transitionTo('half_open')
    }

    // 2. Check per-request cost estimate
    if (estimatedCostCents > this.config.maxCostPerRequestCents) {
      this.transitionTo('open')
      const event: CircuitEvent = {
        type: 'cost_exceeded',
        level: 'error',
        message: `Estimated request cost (${this.formatCents(estimatedCostCents)}) exceeds per-request limit (${this.formatCents(this.config.maxCostPerRequestCents)}).`,
        details: { limit: this.config.maxCostPerRequestCents, current: estimatedCostCents, provider }
      }
      this.emit(event)
      return { allowed: false, reason: event.message, warnings, state: this.state }
    }

    // 2b. Check token limits
    const { estimatedInputTokens, estimatedOutputTokens } = params
    if (estimatedInputTokens && estimatedInputTokens > this.config.maxInputTokensPerRequest) {
      const event: CircuitEvent = {
        type: 'tokens_exceeded',
        level: 'error',
        message: `Input tokens (${estimatedInputTokens.toLocaleString()}) exceed limit (${this.config.maxInputTokensPerRequest.toLocaleString()}).`,
        details: { limit: this.config.maxInputTokensPerRequest, current: estimatedInputTokens, provider }
      }
      this.emit(event)
      return { allowed: false, reason: event.message, warnings, state: this.state }
    }

    if (estimatedOutputTokens && estimatedOutputTokens > this.config.maxOutputTokensPerRequest) {
      const event: CircuitEvent = {
        type: 'tokens_exceeded',
        level: 'error',
        message: `Output tokens (${estimatedOutputTokens.toLocaleString()}) exceed limit (${this.config.maxOutputTokensPerRequest.toLocaleString()}).`,
        details: { limit: this.config.maxOutputTokensPerRequest, current: estimatedOutputTokens, provider }
      }
      this.emit(event)
      return { allowed: false, reason: event.message, warnings, state: this.state }
    }

    // 3. Check per-session cost
    const sessionCost = this.sessionCosts.get(conversationId) ?? 0
    const projectedSessionCost = sessionCost + estimatedCostCents

    if (projectedSessionCost > this.config.maxCostPerSessionCents) {
      this.transitionTo('open')
      const event: CircuitEvent = {
        type: 'cost_exceeded',
        level: 'error',
        message: `Session cost (${this.formatCents(projectedSessionCost)}) would exceed session limit (${this.formatCents(this.config.maxCostPerSessionCents)}).`,
        details: { limit: this.config.maxCostPerSessionCents, current: projectedSessionCost, conversationId }
      }
      this.emit(event)
      return { allowed: false, reason: event.message, warnings, state: this.state }
    }

    if (projectedSessionCost > this.config.maxCostPerSessionCents * warningPct) {
      const event: CircuitEvent = {
        type: 'cost_warning',
        level: 'warning',
        message: `Session cost approaching limit: ${this.formatCents(projectedSessionCost)} / ${this.formatCents(this.config.maxCostPerSessionCents)}`,
        details: {
          limit: this.config.maxCostPerSessionCents,
          current: projectedSessionCost,
          percent: Math.round((projectedSessionCost / this.config.maxCostPerSessionCents) * 100),
          conversationId
        }
      }
      this.emit(event)
      warnings.push(event)
    }

    // 4. Check per-day cost (from tracking DB)
    const todayCostCents = this.getTodayCostCents()
    const projectedDayCost = todayCostCents + estimatedCostCents

    if (projectedDayCost > this.config.maxCostPerDayCents) {
      this.transitionTo('open')
      const event: CircuitEvent = {
        type: 'cost_exceeded',
        level: 'error',
        message: `Daily cost (${this.formatCents(projectedDayCost)}) would exceed daily limit (${this.formatCents(this.config.maxCostPerDayCents)}).`,
        details: { limit: this.config.maxCostPerDayCents, current: projectedDayCost }
      }
      this.emit(event)
      return { allowed: false, reason: event.message, warnings, state: this.state }
    }

    if (projectedDayCost > this.config.maxCostPerDayCents * warningPct) {
      const event: CircuitEvent = {
        type: 'cost_warning',
        level: 'warning',
        message: `Daily cost approaching limit: ${this.formatCents(projectedDayCost)} / ${this.formatCents(this.config.maxCostPerDayCents)}`,
        details: {
          limit: this.config.maxCostPerDayCents,
          current: projectedDayCost,
          percent: Math.round((projectedDayCost / this.config.maxCostPerDayCents) * 100)
        }
      }
      this.emit(event)
      warnings.push(event)
    }

    // 5. Check session turns
    const turns = this.sessionTurns.get(conversationId) ?? 0
    if (turns >= this.config.maxTurnsPerSession) {
      const event: CircuitEvent = {
        type: 'turns_exceeded',
        level: 'error',
        message: `Session turn limit reached (${turns}/${this.config.maxTurnsPerSession}).`,
        details: { limit: this.config.maxTurnsPerSession, current: turns, conversationId }
      }
      this.emit(event)
      return { allowed: false, reason: event.message, warnings, state: this.state }
    }

    // If we were half_open and this check passed, close the circuit
    if (this.state === 'half_open') {
      this.transitionTo('closed')
    }

    return { allowed: true, warnings, state: this.state }
  }

  // ── Agent Run Concurrency ──────────────────────────────────

  canStartAgentRun(runId: string): CircuitCheckResult {
    const warnings: CircuitEvent[] = []

    if (this.activeAgentRuns.size >= this.config.maxConcurrentAgentRuns) {
      const event: CircuitEvent = {
        type: 'concurrent_limit',
        level: 'error',
        message: `Max concurrent agent runs reached (${this.activeAgentRuns.size}/${this.config.maxConcurrentAgentRuns}).`,
        details: { limit: this.config.maxConcurrentAgentRuns, current: this.activeAgentRuns.size }
      }
      this.emit(event)
      return { allowed: false, reason: event.message, warnings, state: this.state }
    }

    this.activeAgentRuns.add(runId)
    return { allowed: true, warnings, state: this.state }
  }

  endAgentRun(runId: string): void {
    this.activeAgentRuns.delete(runId)
  }

  // ── Recording (call after successful LLM response) ─────────

  recordUsage(conversationId: string, actualCostCents: number): void {
    const current = this.sessionCosts.get(conversationId) ?? 0
    this.sessionCosts.set(conversationId, current + actualCostCents)

    const turns = this.sessionTurns.get(conversationId) ?? 0
    this.sessionTurns.set(conversationId, turns + 1)
  }

  // ── Status / Diagnostics ───────────────────────────────────

  getStatus(): {
    state: CircuitState
    config: CircuitBreakerConfig
    todayCostCents: number
    activeAgentRuns: number
    sessions: Array<{ conversationId: string; costCents: number; turns: number }>
  } {
    const sessions: Array<{ conversationId: string; costCents: number; turns: number }> = []
    for (const [id, cost] of this.sessionCosts) {
      sessions.push({
        conversationId: id,
        costCents: cost,
        turns: this.sessionTurns.get(id) ?? 0
      })
    }

    return {
      state: this.state,
      config: this.config,
      todayCostCents: this.getTodayCostCents(),
      activeAgentRuns: this.activeAgentRuns.size,
      sessions
    }
  }

  // Force reset (for admin/settings)
  reset(): void {
    this.transitionTo('closed')
    this.sessionTurns.clear()
    this.sessionCosts.clear()
    this.activeAgentRuns.clear()
  }

  // ── Private Helpers ────────────────────────────────────────

  private getTodayCostCents(): number {
    const now = new Date()
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const summary = getTrackingEngine().getSummary(dayStart)
    // TrackingEngine stores cost in USD — convert to cents
    return Math.round(summary.totalCost * 100)
  }

  private formatCents(cents: number): string {
    return `CHF ${(cents / 100).toFixed(2)}`
  }
}

// ── Singleton ──────────────────────────────────────────────────

let instance: CircuitBreaker | null = null

export function getCircuitBreaker(): CircuitBreaker {
  if (!instance) instance = new CircuitBreaker()
  return instance
}
