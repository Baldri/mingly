/**
 * ContextInjector Tests
 * Tests RAG context injection logic (mocking RAG + SimpleStore).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron (needed by SimpleStore)
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/mingly-ci-test'
  }
}))

// Mock SimpleStore — don't persist any data to avoid cross-test contamination
vi.mock('../../src/main/utils/simple-store', () => ({
  SimpleStore: {
    create: vi.fn(() => ({
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn()
    }))
  }
}))

// Mock RAG manager
vi.mock('../../src/main/rag/rag-manager', () => ({
  getRAGManager: vi.fn().mockReturnValue({
    getContext: vi.fn().mockResolvedValue('Relevant context from docs'),
    search: vi.fn().mockResolvedValue({
      results: [{ filename: 'test.md', source: 'test.md', score: 0.9 }]
    })
  })
}))

// Mock RAG HTTP client
vi.mock('../../src/main/rag/rag-http-client', () => ({
  getRAGHttpClient: vi.fn().mockReturnValue({
    isAvailable: vi.fn().mockResolvedValue(false),
    getContext: vi.fn()
  })
}))

import { ContextInjector } from '../../src/main/rag/context-injector'

describe('ContextInjector', () => {
  describe('getConfig', () => {
    it('should return default config', () => {
      const injector = new ContextInjector()
      const config = injector.getConfig()
      expect(config.enabled).toBe(false)
      expect(config.collectionName).toBe('documents')
      expect(config.maxChunks).toBe(3)
      expect(config.scoreThreshold).toBe(0.65)
      expect(config.preferLocal).toBe(true)
    })
  })

  describe('updateConfig', () => {
    it('should update config values', () => {
      const injector = new ContextInjector()
      injector.updateConfig({ enabled: true, maxChunks: 5 })
      const config = injector.getConfig()
      expect(config.enabled).toBe(true)
      expect(config.maxChunks).toBe(5)
    })

    it('should preserve existing values', () => {
      const injector = new ContextInjector()
      injector.updateConfig({ enabled: true })
      const config = injector.getConfig()
      expect(config.collectionName).toBe('documents')
    })
  })

  describe('getContext', () => {
    it('should return empty context when disabled', async () => {
      const injector = new ContextInjector()
      // Don't enable — default is disabled
      const result = await injector.getContext('What is TypeScript?')
      expect(result.context).toBe('')
      expect(result.source).toBe('none')
      expect(result.sources).toEqual([])
    })

    it('should fetch from local RAG when enabled and preferLocal', async () => {
      const injector = new ContextInjector()
      injector.updateConfig({ enabled: true, preferLocal: true })
      const result = await injector.getContext('What is TypeScript?')
      expect(result.context).toBe('Relevant context from docs')
      expect(result.source).toBe('local')
      expect(result.sources.length).toBeGreaterThan(0)
      expect(result.timeMs).toBeGreaterThanOrEqual(0)
    })
  })

  describe('buildAugmentedPrompt', () => {
    it('should return base prompt when no context', () => {
      const injector = new ContextInjector()
      const result = injector.buildAugmentedPrompt('You are a helper.', '')
      expect(result).toBe('You are a helper.')
    })

    it('should inject context into prompt', () => {
      const injector = new ContextInjector()
      const result = injector.buildAugmentedPrompt(
        'You are a helper.',
        'TypeScript is a typed superset of JavaScript.'
      )
      expect(result).toContain('You are a helper.')
      expect(result).toContain('Knowledge Base')
      expect(result).toContain('TypeScript is a typed superset')
    })
  })
})
