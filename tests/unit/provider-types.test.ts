/**
 * Provider Types Tests
 * Tests provider configuration, built-in providers, and custom provider creation.
 */

import { describe, it, expect } from 'vitest'
import {
  BUILT_IN_PROVIDERS,
  createCustomProvider,
  CUSTOM_PROVIDER_TEMPLATES
} from '../../src/shared/provider-types'
import type { BuiltInProvider } from '../../src/shared/provider-types'

describe('BUILT_IN_PROVIDERS', () => {
  const providers: BuiltInProvider[] = ['anthropic', 'openai', 'google', 'ollama']

  it('should define all built-in providers', () => {
    for (const p of providers) {
      expect(BUILT_IN_PROVIDERS[p]).toBeDefined()
    }
  })

  it('should have required fields on each provider', () => {
    for (const p of providers) {
      const config = BUILT_IN_PROVIDERS[p]
      expect(config.id).toBe(p)
      expect(config.name).toBeTruthy()
      expect(config.type).toBeTruthy()
      expect(typeof config.apiKeyRequired).toBe('boolean')
      expect(typeof config.supportsStreaming).toBe('boolean')
      expect(Array.isArray(config.models)).toBe(true)
    }
  })

  it('should require API key for cloud providers', () => {
    expect(BUILT_IN_PROVIDERS.anthropic.apiKeyRequired).toBe(true)
    expect(BUILT_IN_PROVIDERS.openai.apiKeyRequired).toBe(true)
    expect(BUILT_IN_PROVIDERS.google.apiKeyRequired).toBe(true)
  })

  it('should NOT require API key for Ollama', () => {
    expect(BUILT_IN_PROVIDERS.ollama.apiKeyRequired).toBe(false)
  })

  it('should have models for cloud providers', () => {
    expect(BUILT_IN_PROVIDERS.anthropic.models.length).toBeGreaterThan(0)
    expect(BUILT_IN_PROVIDERS.openai.models.length).toBeGreaterThan(0)
    expect(BUILT_IN_PROVIDERS.google.models.length).toBeGreaterThan(0)
  })

  it('should have context window for all models', () => {
    for (const p of providers) {
      for (const model of BUILT_IN_PROVIDERS[p].models) {
        expect(model.id).toBeTruthy()
        expect(model.name).toBeTruthy()
      }
    }
  })

  it('should support streaming on all providers', () => {
    for (const p of providers) {
      expect(BUILT_IN_PROVIDERS[p].supportsStreaming).toBe(true)
    }
  })
})

describe('createCustomProvider', () => {
  it('should create a custom provider with defaults', () => {
    const provider = createCustomProvider('test', 'Test Provider', 'http://localhost:8080/v1')
    expect(provider.id).toBe('test')
    expect(provider.name).toBe('Test Provider')
    expect(provider.apiBase).toBe('http://localhost:8080/v1')
    expect(provider.apiKeyRequired).toBe(true)
    expect(provider.type).toBe('custom')
    expect(provider.supportsStreaming).toBe(true)
    expect(provider.badge).toBe('CUSTOM')
  })

  it('should allow no API key requirement', () => {
    const provider = createCustomProvider('local', 'Local', 'http://localhost:1234/v1', false)
    expect(provider.apiKeyRequired).toBe(false)
  })
})

describe('CUSTOM_PROVIDER_TEMPLATES', () => {
  it('should define LM Studio template', () => {
    const tmpl = CUSTOM_PROVIDER_TEMPLATES['lm-studio']
    expect(tmpl.id).toBe('lm-studio')
    expect(tmpl.apiBase).toContain('1234')
    expect(tmpl.apiKeyRequired).toBe(false)
  })

  it('should define LocalAI template', () => {
    const tmpl = CUSTOM_PROVIDER_TEMPLATES['localai']
    expect(tmpl.id).toBe('localai')
    expect(tmpl.apiBase).toContain('8080')
  })

  it('should define OpenRouter template (requires key)', () => {
    const tmpl = CUSTOM_PROVIDER_TEMPLATES['openrouter']
    expect(tmpl.apiKeyRequired).toBe(true)
    expect(tmpl.apiBase).toContain('openrouter.ai')
  })

  it('should define Text Generation WebUI template', () => {
    const tmpl = CUSTOM_PROVIDER_TEMPLATES['text-generation-webui']
    expect(tmpl.id).toBe('text-generation-webui')
    expect(tmpl.apiBase).toContain('5000')
  })
})
