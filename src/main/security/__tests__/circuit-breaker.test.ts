import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CircuitBreaker } from '../circuit-breaker'
import type { CircuitEvent, CircuitBreakerConfig } from '../circuit-breaker'

// Mock the tracking engine
vi.mock('../../tracking/tracking-engine', () => ({
  getTrackingEngine: () => ({
    getSummary: vi.fn().mockReturnValue({ totalCost: 0 }),
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
    calculateCost: (_model: string, input: number, output: number) => ({
      inputCost: input * 0.000003,
      outputCost: output * 0.000015,
      totalCost: input * 0.000003 + output * 0.000015
    })
  })
}))

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker

  beforeEach(() => {
    cb = new CircuitBreaker({
      maxCostPerRequestCents: 50,      // CHF 0.50
      maxCostPerSessionCents: 200,     // CHF 2.00
      maxCostPerDayCents: 500,         // CHF 5.00
      maxTurnsPerSession: 10,
      maxConcurrentAgentRuns: 2,
      warningThresholdPercent: 80,
      cooldownAfterLimitMs: 1000       // 1s for tests
    })
  })

  describe('canExecute', () => {
    it('allows requests within all limits', () => {
      const result = cb.canExecute({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 10
      })
      expect(result.allowed).toBe(true)
      expect(result.state).toBe('closed')
      expect(result.warnings).toHaveLength(0)
    })

    it('blocks requests exceeding per-request limit', () => {
      const result = cb.canExecute({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 60 // > 50 limit
      })
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('per-request limit')
      expect(result.state).toBe('open')
    })

    it('blocks requests exceeding per-session limit', () => {
      // Record 180 cents of usage
      cb.recordUsage('conv-1', 180)

      const result = cb.canExecute({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 30 // 180 + 30 = 210 > 200 limit
      })
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('session limit')
    })

    it('allows requests for different sessions independently', () => {
      cb.recordUsage('conv-1', 180)

      const result = cb.canExecute({
        conversationId: 'conv-2', // different session
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 30
      })
      expect(result.allowed).toBe(true)
    })

    it('emits warning when approaching session limit', () => {
      const events: CircuitEvent[] = []
      cb.onEvent((e) => events.push(e))

      cb.recordUsage('conv-1', 170) // 85% of 200

      const result = cb.canExecute({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 5
      })

      expect(result.allowed).toBe(true)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0].type).toBe('cost_warning')
      expect(events.some((e) => e.type === 'cost_warning')).toBe(true)
    })

    it('blocks after max turns per session', () => {
      // Simulate 10 turns
      for (let i = 0; i < 10; i++) {
        cb.recordUsage('conv-1', 1)
      }

      const result = cb.canExecute({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 1
      })
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('turn limit')
    })
  })

  describe('circuit state transitions', () => {
    it('transitions to open when limit is exceeded', () => {
      expect(cb.getState()).toBe('closed')

      cb.canExecute({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 60 // exceeds per-request
      })

      expect(cb.getState()).toBe('open')
    })

    it('stays open during cooldown', () => {
      // Trip the breaker
      cb.canExecute({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 60
      })

      // Immediately try again
      const result = cb.canExecute({
        conversationId: 'conv-2',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 1
      })

      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('Cooldown')
      expect(result.state).toBe('open')
    })

    it('transitions to half_open after cooldown expires', async () => {
      // Use very short cooldown for this test
      const fastCB = new CircuitBreaker({
        maxCostPerRequestCents: 50,
        maxCostPerSessionCents: 200,
        maxCostPerDayCents: 500,
        maxTurnsPerSession: 10,
        maxConcurrentAgentRuns: 2,
        warningThresholdPercent: 80,
        cooldownAfterLimitMs: 50 // 50ms
      })

      // Trip the breaker
      fastCB.canExecute({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 60
      })

      expect(fastCB.getState()).toBe('open')

      // Wait for cooldown
      await new Promise((r) => setTimeout(r, 60))

      // Probe request should transition to half_open then closed
      const result = fastCB.canExecute({
        conversationId: 'conv-2',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 1
      })

      expect(result.allowed).toBe(true)
      expect(fastCB.getState()).toBe('closed')
    })
  })

  describe('agent run concurrency', () => {
    it('allows up to max concurrent runs', () => {
      expect(cb.canStartAgentRun('run-1').allowed).toBe(true)
      expect(cb.canStartAgentRun('run-2').allowed).toBe(true)
    })

    it('blocks beyond max concurrent runs', () => {
      cb.canStartAgentRun('run-1')
      cb.canStartAgentRun('run-2')

      const result = cb.canStartAgentRun('run-3')
      expect(result.allowed).toBe(false)
      expect(result.reason).toContain('concurrent')
    })

    it('allows new runs after completing existing ones', () => {
      cb.canStartAgentRun('run-1')
      cb.canStartAgentRun('run-2')
      cb.endAgentRun('run-1')

      const result = cb.canStartAgentRun('run-3')
      expect(result.allowed).toBe(true)
    })
  })

  describe('recordUsage', () => {
    it('accumulates session costs', () => {
      cb.recordUsage('conv-1', 10)
      cb.recordUsage('conv-1', 20)

      const status = cb.getStatus()
      const session = status.sessions.find((s) => s.conversationId === 'conv-1')
      expect(session?.costCents).toBe(30)
      expect(session?.turns).toBe(2)
    })

    it('tracks sessions independently', () => {
      cb.recordUsage('conv-1', 10)
      cb.recordUsage('conv-2', 50)

      const status = cb.getStatus()
      expect(status.sessions).toHaveLength(2)
      expect(status.sessions.find((s) => s.conversationId === 'conv-1')?.costCents).toBe(10)
      expect(status.sessions.find((s) => s.conversationId === 'conv-2')?.costCents).toBe(50)
    })
  })

  describe('event handling', () => {
    it('emits events and allows unsubscribe', () => {
      const events: CircuitEvent[] = []
      const unsub = cb.onEvent((e) => events.push(e))

      cb.canExecute({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 60
      })

      expect(events.length).toBeGreaterThan(0)
      expect(events.some((e) => e.type === 'circuit_opened')).toBe(true)

      unsub()
      const countBefore = events.length

      cb.reset()
      // After unsubscribe, no new events
      expect(events.length).toBe(countBefore)
    })
  })

  describe('reset', () => {
    it('clears all state', () => {
      cb.recordUsage('conv-1', 100)
      cb.canStartAgentRun('run-1')

      // Trip the breaker
      cb.canExecute({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        estimatedCostCents: 60
      })

      cb.reset()

      expect(cb.getState()).toBe('closed')
      const status = cb.getStatus()
      expect(status.sessions).toHaveLength(0)
      expect(status.activeAgentRuns).toBe(0)
    })
  })

  describe('getStatus', () => {
    it('returns complete status', () => {
      cb.recordUsage('conv-1', 50)
      cb.canStartAgentRun('run-1')

      const status = cb.getStatus()
      expect(status.state).toBe('closed')
      expect(status.activeAgentRuns).toBe(1)
      expect(status.sessions).toHaveLength(1)
      expect(status.config.maxCostPerRequestCents).toBe(50)
    })
  })

  describe('configuration', () => {
    it('allows config updates', () => {
      cb.updateConfig({ maxCostPerRequestCents: 100 })
      expect(cb.getConfig().maxCostPerRequestCents).toBe(100)

      // Old limits should still work
      expect(cb.getConfig().maxCostPerSessionCents).toBe(200)
    })
  })
})
