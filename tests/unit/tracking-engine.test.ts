/**
 * Tracking Engine Tests
 * Tests pure functions (estimateTokens, calculateCost) and mocks DB for recordEvent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the database module
vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbAll: vi.fn(() => []),
  dbGet: vi.fn(() => ({
    total_messages: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_tokens: 0,
    total_cost: 0,
    avg_latency: 0,
    rag_count: 0,
    error_count: 0
  }))
}))

import { TrackingEngine, getTrackingEngine } from '../../src/main/tracking/tracking-engine'
import { dbRun, dbGet, dbAll } from '../../src/main/database/index'

describe('TrackingEngine', () => {
  let engine: TrackingEngine

  beforeEach(() => {
    engine = new TrackingEngine()
    vi.clearAllMocks()
  })

  describe('estimateTokens', () => {
    it('should estimate ~4 chars per token', () => {
      expect(engine.estimateTokens('abcd')).toBe(1)
      expect(engine.estimateTokens('abcdefgh')).toBe(2)
    })

    it('should round up', () => {
      expect(engine.estimateTokens('ab')).toBe(1) // ceil(2/4) = 1
      expect(engine.estimateTokens('abcde')).toBe(2) // ceil(5/4) = 2
    })

    it('should return 0 for empty string', () => {
      expect(engine.estimateTokens('')).toBe(0)
    })

    it('should handle long text', () => {
      const text = 'a'.repeat(1000)
      expect(engine.estimateTokens(text)).toBe(250)
    })
  })

  describe('calculateCost', () => {
    it('should calculate cost for known models', () => {
      const result = engine.calculateCost('gpt-4', 1_000_000, 500_000)
      expect(result.inputCost).toBe(30) // 30 per 1M
      expect(result.outputCost).toBe(30) // 60 per 1M * 0.5M
      expect(result.totalCost).toBe(60)
    })

    it('should calculate cost for Claude models', () => {
      const result = engine.calculateCost('claude-3-5-sonnet-20241022', 1_000_000, 1_000_000)
      expect(result.inputCost).toBe(3)
      expect(result.outputCost).toBe(15)
      expect(result.totalCost).toBe(18)
    })

    it('should return 0 for unknown models', () => {
      const result = engine.calculateCost('unknown-model', 1000, 1000)
      expect(result.inputCost).toBe(0)
      expect(result.outputCost).toBe(0)
      expect(result.totalCost).toBe(0)
    })

    it('should return 0 for zero tokens', () => {
      const result = engine.calculateCost('gpt-4', 0, 0)
      expect(result.totalCost).toBe(0)
    })

    it('should calculate for cheap models', () => {
      const result = engine.calculateCost('claude-3-haiku-20240307', 1_000_000, 1_000_000)
      expect(result.inputCost).toBe(0.25)
      expect(result.outputCost).toBe(1.25)
      expect(result.totalCost).toBe(1.5)
    })
  })

  describe('recordEvent', () => {
    it('should record an event and call dbRun', () => {
      const event = engine.recordEvent({
        conversationId: 'conv-1',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        inputText: 'Hello',
        outputText: 'Hi there!',
        latencyMs: 500,
        ragUsed: false,
        ragSourceCount: 0,
        success: true
      })

      expect(dbRun).toHaveBeenCalledOnce()
      expect(event.conversationId).toBe('conv-1')
      expect(event.provider).toBe('anthropic')
      expect(event.model).toBe('claude-3-5-sonnet-20241022')
      expect(event.success).toBe(true)
      expect(event.inputTokens).toBeGreaterThan(0)
      expect(event.outputTokens).toBeGreaterThan(0)
      expect(event.id).toMatch(/^trk_/)
    })

    it('should use provided token counts when available', () => {
      const event = engine.recordEvent({
        conversationId: 'conv-2',
        provider: 'openai',
        model: 'gpt-4',
        inputText: 'Hello',
        outputText: 'Hi',
        latencyMs: 200,
        ragUsed: true,
        ragSourceCount: 3,
        success: true,
        inputTokens: 100,
        outputTokens: 50
      })

      expect(event.inputTokens).toBe(100)
      expect(event.outputTokens).toBe(50)
      expect(event.totalTokens).toBe(150)
      expect(event.ragUsed).toBe(true)
      expect(event.ragSourceCount).toBe(3)
    })

    it('should record error events', () => {
      const event = engine.recordEvent({
        conversationId: 'conv-3',
        provider: 'openai',
        model: 'gpt-4',
        inputText: 'Hello',
        outputText: '',
        latencyMs: 1000,
        ragUsed: false,
        ragSourceCount: 0,
        success: false,
        errorMessage: 'Rate limit exceeded'
      })

      expect(event.success).toBe(false)
      expect(event.errorMessage).toBe('Rate limit exceeded')
    })
  })

  describe('getSummary', () => {
    it('should return a summary object', () => {
      const summary = engine.getSummary()
      expect(summary).toHaveProperty('totalMessages')
      expect(summary).toHaveProperty('totalCost')
      expect(summary).toHaveProperty('byProvider')
      expect(summary).toHaveProperty('byModel')
      expect(summary).toHaveProperty('avgLatencyMs')
      expect(summary).toHaveProperty('ragHitRate')
      expect(summary).toHaveProperty('errorRate')
    })

    it('should pass time range parameters to query', () => {
      engine.getSummary(1000, 2000)
      expect(dbGet).toHaveBeenCalled()
      const callArgs = (dbGet as any).mock.calls[0]
      expect(callArgs[1]).toEqual([1000, 2000])
    })
  })

  describe('getDailyUsage', () => {
    it('should call dbAll with correct query', () => {
      engine.getDailyUsage(7)
      expect(dbAll).toHaveBeenCalled()
    })

    it('should return an array', () => {
      const usage = engine.getDailyUsage()
      expect(Array.isArray(usage)).toBe(true)
    })
  })

  describe('getRecentEvents', () => {
    it('should call dbAll with limit', () => {
      engine.getRecentEvents(10)
      expect(dbAll).toHaveBeenCalled()
      const callArgs = (dbAll as any).mock.calls[0]
      expect(callArgs[1]).toEqual([10])
    })
  })

  describe('getTrackingEngine singleton', () => {
    it('should return same instance', () => {
      const a = getTrackingEngine()
      const b = getTrackingEngine()
      expect(a).toBe(b)
    })
  })
})
