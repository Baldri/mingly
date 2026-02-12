/**
 * ComparisonService Tests
 * Tests parallel execution, partial failure handling, winner marking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock database
const mockSessions: Record<string, any>[] = []
const mockResults: Record<string, any>[] = []
let idCounter = 0

vi.mock('../../src/main/database/models/comparison', () => ({
  ComparisonModel: {
    createSession: vi.fn((prompt: string, models: any[]) => {
      const session = { id: `session-${++idCounter}`, prompt, models, createdAt: Date.now() }
      mockSessions.push(session)
      return session
    }),
    addResult: vi.fn((data: any) => {
      const result = { id: `result-${++idCounter}`, ...data, createdAt: Date.now() }
      mockResults.push(result)
      return result
    }),
    getHistory: vi.fn(() => []),
    markWinner: vi.fn(() => true),
    getSessionResults: vi.fn(() => [])
  }
}))

vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({
    sendMessageNonStreaming: vi.fn(async (provider: string, _msgs: any[], model: string) => {
      if (provider === 'fail-provider') throw new Error('API error')
      return `Response from ${provider}/${model}`
    })
  }))
}))

vi.mock('../../src/main/utils/id-generator', () => ({
  generateId: vi.fn(() => `id-${++idCounter}`)
}))

import { ComparisonService, getComparisonService } from '../../src/main/services/comparison-service'

describe('ComparisonService', () => {
  let service: ComparisonService

  beforeEach(() => {
    service = new ComparisonService()
    mockSessions.length = 0
    mockResults.length = 0
    idCounter = 0
    vi.clearAllMocks()
  })

  describe('runComparison', () => {
    it('should run comparison across multiple models', async () => {
      const result = await service.runComparison('Hello', [
        { provider: 'anthropic', model: 'claude-3-sonnet' },
        { provider: 'openai', model: 'gpt-4-turbo' }
      ])

      expect(result.session).toBeDefined()
      expect(result.session.prompt).toBe('Hello')
      expect(result.results).toHaveLength(2)
      expect(result.errors).toHaveLength(0)
    })

    it('should handle partial failures gracefully', async () => {
      const result = await service.runComparison('Hello', [
        { provider: 'anthropic', model: 'claude-3-sonnet' },
        { provider: 'fail-provider', model: 'broken-model' }
      ])

      expect(result.results).toHaveLength(2)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].provider).toBe('fail-provider')
      expect(result.errors[0].error).toContain('API error')
    })

    it('should create a session', async () => {
      const result = await service.runComparison('Test prompt', [
        { provider: 'anthropic', model: 'claude-3-sonnet' },
        { provider: 'google', model: 'gemini-1.5-flash' }
      ])

      expect(result.session.id).toBeDefined()
      expect(result.session.models).toHaveLength(2)
    })

    it('should handle three models', async () => {
      const result = await service.runComparison('Hello', [
        { provider: 'anthropic', model: 'claude-3-sonnet' },
        { provider: 'openai', model: 'gpt-4-turbo' },
        { provider: 'google', model: 'gemini-1.5-flash' }
      ])

      expect(result.results).toHaveLength(3)
      expect(result.errors).toHaveLength(0)
    })

    it('should handle all models failing', async () => {
      const result = await service.runComparison('Hello', [
        { provider: 'fail-provider', model: 'a' },
        { provider: 'fail-provider', model: 'b' }
      ])

      expect(result.results).toHaveLength(2)
      expect(result.errors).toHaveLength(2)
    })
  })

  describe('markWinner', () => {
    it('should mark a winner', () => {
      const success = service.markWinner('session-1', 'result-1')
      expect(success).toBe(true)
    })
  })

  describe('getHistory', () => {
    it('should return history', () => {
      const history = service.getHistory()
      expect(Array.isArray(history)).toBe(true)
    })

    it('should accept limit parameter without throwing', () => {
      expect(() => service.getHistory(10)).not.toThrow()
    })
  })

  describe('singleton', () => {
    it('should return same instance', () => {
      const a = getComparisonService()
      const b = getComparisonService()
      expect(a).toBe(b)
    })
  })
})
