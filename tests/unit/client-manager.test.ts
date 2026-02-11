/**
 * LLM Client Manager Tests
 * Tests provider registration, API key management, and client retrieval.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all LLM client modules to avoid real SDK imports
// NOTE: Must use regular functions (not arrows) so they work with `new`
vi.mock('../../src/main/llm-clients/anthropic-client', () => ({
  AnthropicClient: vi.fn().mockImplementation(function () {
    this.setApiKey = vi.fn()
    this.validateApiKey = vi.fn().mockResolvedValue(true)
    this.sendMessage = vi.fn()
    this.sendMessageNonStreaming = vi.fn()
    this.getModels = vi.fn().mockReturnValue(['claude-3-5-sonnet-20241022'])
  })
}))

vi.mock('../../src/main/llm-clients/openai-client', () => ({
  OpenAIClient: vi.fn().mockImplementation(function () {
    this.setApiKey = vi.fn()
    this.validateApiKey = vi.fn().mockResolvedValue(true)
    this.sendMessage = vi.fn()
    this.sendMessageNonStreaming = vi.fn()
    this.getModels = vi.fn().mockReturnValue(['gpt-4'])
  })
}))

vi.mock('../../src/main/llm-clients/google-client', () => ({
  GoogleClient: vi.fn().mockImplementation(function () {
    this.setApiKey = vi.fn()
    this.validateApiKey = vi.fn().mockResolvedValue(true)
    this.sendMessage = vi.fn()
    this.sendMessageNonStreaming = vi.fn()
    this.getModels = vi.fn().mockReturnValue(['gemini-pro'])
  })
}))

vi.mock('../../src/main/llm-clients/ollama-client', () => ({
  OllamaClient: vi.fn().mockImplementation(function () {
    this.setApiKey = vi.fn()
    this.validateApiKey = vi.fn().mockResolvedValue(true)
    this.sendMessage = vi.fn()
    this.sendMessageNonStreaming = vi.fn()
    this.getModels = vi.fn().mockReturnValue(['llama3:8b'])
  })
}))

vi.mock('../../src/main/llm-clients/generic-openai-client', () => ({
  GenericOpenAIClient: vi.fn().mockImplementation(function () {
    this.setApiKey = vi.fn()
    this.validateApiKey = vi.fn().mockResolvedValue(true)
    this.sendMessage = vi.fn()
    this.sendMessageNonStreaming = vi.fn()
    this.getModels = vi.fn().mockReturnValue([])
  })
}))

import { LLMClientManager } from '../../src/main/llm-clients/client-manager'

describe('LLMClientManager', () => {
  let manager: LLMClientManager

  beforeEach(() => {
    manager = new LLMClientManager()
  })

  describe('Provider Registration', () => {
    it('should have built-in providers', () => {
      const providers = manager.getProviders()
      expect(providers).toContain('anthropic')
      expect(providers).toContain('openai')
      expect(providers).toContain('google')
      expect(providers).toContain('ollama')
      expect(providers).toContain('local')
    })

    it('should check if provider exists', () => {
      expect(manager.hasProvider('anthropic')).toBe(true)
      expect(manager.hasProvider('unknown')).toBe(false)
    })

    it('should register custom providers', () => {
      manager.registerCustomProvider({
        id: 'lm-studio',
        name: 'LM Studio',
        type: 'custom',
        apiBase: 'http://localhost:1234/v1',
        apiKeyRequired: false,
        supportsStreaming: true,
        models: []
      })
      expect(manager.hasProvider('lm-studio')).toBe(true)
    })
  })

  describe('API Key Management', () => {
    it('should set and get API keys', () => {
      manager.setApiKey('anthropic', 'sk-test-key')
      expect(manager.getApiKey('anthropic')).toBe('sk-test-key')
    })

    it('should report ollama as having API key (not required)', () => {
      expect(manager.hasApiKey('ollama')).toBe(true)
    })

    it('should report local as having API key (not required)', () => {
      expect(manager.hasApiKey('local')).toBe(true)
    })

    it('should report missing API key for cloud providers without key', () => {
      expect(manager.hasApiKey('anthropic')).toBe(false)
    })

    it('should report API key present after setting', () => {
      manager.setApiKey('openai', 'sk-openai-key')
      expect(manager.hasApiKey('openai')).toBe(true)
    })
  })

  describe('Client Retrieval', () => {
    it('should get client for provider with API key', () => {
      manager.setApiKey('anthropic', 'sk-test')
      const client = manager.getClient('anthropic')
      expect(client).toBeDefined()
    })

    it('should throw for unknown provider', () => {
      expect(() => manager.getClient('nonexistent')).toThrow('Unknown provider')
    })

    it('should throw for cloud provider without API key', () => {
      expect(() => manager.getClient('anthropic')).toThrow('API key not set')
    })

    it('should get ollama client without API key', () => {
      const client = manager.getClient('ollama')
      expect(client).toBeDefined()
    })

    it('should get models for a provider', () => {
      const models = manager.getModels('anthropic')
      expect(Array.isArray(models)).toBe(true)
    })
  })

  describe('Provider Listing', () => {
    it('should list all providers', () => {
      const all = manager.getAllProviders()
      expect(all.length).toBeGreaterThanOrEqual(5) // anthropic, openai, google, ollama, local
    })

    it('should list providers with API keys', () => {
      manager.setApiKey('anthropic', 'sk-test')
      const withKeys = manager.getProvidersWithApiKeys()
      expect(withKeys).toContain('anthropic')
      expect(withKeys).toContain('ollama')
      expect(withKeys).toContain('local')
    })
  })

  describe('Validation', () => {
    it('should validate API key for provider', async () => {
      manager.setApiKey('anthropic', 'sk-test')
      const valid = await manager.validateApiKey('anthropic')
      expect(valid).toBe(true)
    })

    it('should return false for missing API key', async () => {
      const valid = await manager.validateApiKey('openai')
      expect(valid).toBe(false)
    })

    it('should throw for unknown provider validation', async () => {
      await expect(manager.validateApiKey('nonexistent')).rejects.toThrow('Unknown provider')
    })

    it('should validate ollama without key', async () => {
      const valid = await manager.validateApiKey('ollama')
      expect(valid).toBe(true)
    })
  })
})
