/**
 * Intelligent Router Tests
 * Tests heuristic routing logic (mocking Ollama dependency).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Ollama module — must use regular function for `new` to work
vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(function () {
    this.list = vi.fn().mockRejectedValue(new Error('Not available'))
    this.generate = vi.fn()
  })
}))

import { IntelligentRouter } from '../../src/main/routing/intelligent-router'

describe('IntelligentRouter', () => {
  let router: IntelligentRouter

  beforeEach(() => {
    router = new IntelligentRouter()
  })

  describe('heuristic routing (fallback)', () => {
    it('should route code-related messages to anthropic', async () => {
      const result = await router.route(
        'Help me debug this TypeScript function',
        ['anthropic', 'openai', 'google']
      )
      expect(result.category).toBe('code')
      expect(result.suggestedProvider).toBe('anthropic')
    })

    it('should route creative messages to openai', async () => {
      const result = await router.route(
        'Write a creative story about a magical forest',
        ['anthropic', 'openai', 'google']
      )
      expect(result.category).toBe('creative')
      expect(result.suggestedProvider).toBe('openai')
    })

    it('should route analysis messages to google', async () => {
      const result = await router.route(
        'Analyze and compare these two research papers and summarize',
        ['anthropic', 'openai', 'google']
      )
      expect(result.category).toBe('analysis')
      expect(result.suggestedProvider).toBe('google')
    })

    it('should default to conversation for generic messages', async () => {
      const result = await router.route(
        'Hello, how are you today?',
        ['anthropic', 'openai', 'google']
      )
      expect(result.category).toBe('conversation')
      expect(result.suggestedProvider).toBe('anthropic') // Best for conversation
    })

    it('should return only available provider when single provider', async () => {
      const result = await router.route(
        'Help me debug this code',
        ['openai']
      )
      expect(result.suggestedProvider).toBe('openai')
      expect(result.confidence).toBe(0.5)
    })

    it('should include reasoning in the result', async () => {
      const result = await router.route(
        'Write a poem',
        ['anthropic', 'openai']
      )
      expect(result.reasoning).toBeTruthy()
      expect(typeof result.reasoning).toBe('string')
    })
  })

  describe('getSuggestion', () => {
    it('should not suggest switch when current provider is best', async () => {
      const result = await router.getSuggestion(
        'Help me with this code bug',
        'anthropic',
        ['anthropic', 'openai', 'google']
      )
      expect(result.shouldSwitch).toBe(false)
    })

    it('should suggest switch when better provider available', async () => {
      const result = await router.getSuggestion(
        'Write a creative novel chapter',
        'google',
        ['anthropic', 'openai', 'google']
      )
      // OpenAI is best for creative; google is current
      expect(result.shouldSwitch).toBe(true)
      expect(result.suggestion?.suggestedProvider).toBe('openai')
    })

    it('should suggest switch when provider capability score is high', async () => {
      const result = await router.getSuggestion(
        'Hi there',
        'openai',
        ['anthropic', 'openai']
      )
      // Anthropic has higher conversation score (0.95 vs 0.90), so switch is suggested
      expect(result.shouldSwitch).toBe(true)
      expect(result.suggestion?.suggestedProvider).toBe('anthropic')
    })
  })
})
