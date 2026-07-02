/**
 * Provider Type System
 * Supports built-in providers (Anthropic, OpenAI, Google, Ollama)
 * AND custom providers (any OpenAI-compatible API)
 */

// Built-in providers
export type BuiltInProvider = 'anthropic' | 'openai' | 'google' | 'ollama'

// Provider can be built-in OR custom
export type LLMProvider = BuiltInProvider | string

// Provider configuration for custom providers
export interface ProviderConfig {
  id: string // unique identifier
  name: string // display name
  type: 'built-in' | 'custom' | 'ollama'

  // API Configuration
  apiBase?: string // e.g., "http://localhost:1234/v1" for LM Studio
  apiKeyRequired: boolean

  // Supported features
  supportsStreaming: boolean
  supportsVision?: boolean
  supportsFunctionCalling?: boolean

  // Model list (can be fetched dynamically)
  models: ProviderModel[]

  // Display metadata
  icon?: string
  badge?: string // e.g., "FREE", "LOCAL", "BETA"
  color?: string
}

export interface ProviderModel {
  id: string // e.g., "gpt-4-turbo-preview"
  name: string // e.g., "GPT-4 Turbo"
  contextWindow?: number
  costPer1kTokens?: {
    input: number
    output: number
  }
}

// Built-in provider configs
export const BUILT_IN_PROVIDERS: Record<BuiltInProvider, ProviderConfig> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    type: 'built-in',
    apiKeyRequired: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsFunctionCalling: true,
    models: [
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        contextWindow: 1000000,
        costPer1kTokens: { input: 0.003, output: 0.015 }
      },
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        contextWindow: 1000000,
        costPer1kTokens: { input: 0.005, output: 0.025 }
      },
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        contextWindow: 200000,
        costPer1kTokens: { input: 0.001, output: 0.005 }
      }
    ],
    color: '#D97757'
  },

  openai: {
    id: 'openai',
    name: 'OpenAI (ChatGPT)',
    type: 'built-in',
    apiKeyRequired: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsFunctionCalling: true,
    models: [
      {
        id: 'gpt-4-turbo-preview',
        name: 'GPT-4 Turbo',
        contextWindow: 128000,
        costPer1kTokens: { input: 0.01, output: 0.03 }
      },
      {
        id: 'gpt-4',
        name: 'GPT-4',
        contextWindow: 8192,
        costPer1kTokens: { input: 0.03, output: 0.06 }
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        contextWindow: 16385,
        costPer1kTokens: { input: 0.0005, output: 0.0015 }
      }
    ],
    color: '#10A37F'
  },

  google: {
    id: 'google',
    name: 'Google (Gemini)',
    type: 'built-in',
    apiKeyRequired: true,
    supportsStreaming: true,
    supportsVision: true,
    supportsFunctionCalling: true,
    models: [
      {
        id: 'gemini-1.5-pro-latest',
        name: 'Gemini 1.5 Pro',
        contextWindow: 1000000
      },
      {
        id: 'gemini-1.5-flash-latest',
        name: 'Gemini 1.5 Flash',
        contextWindow: 1000000
      },
      {
        id: 'gemini-pro',
        name: 'Gemini Pro',
        contextWindow: 32000
      }
    ],
    color: '#4285F4'
  },

  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    type: 'ollama',
    apiBase: 'http://localhost:11434',
    apiKeyRequired: false,
    supportsStreaming: true,
    supportsVision: false,
    supportsFunctionCalling: false,
    models: [], // Dynamically fetched from Ollama
    badge: 'FREE',
    color: '#000000'
  }
}

// Custom provider template
export function createCustomProvider(
  id: string,
  name: string,
  apiBase: string,
  requiresKey: boolean = true
): ProviderConfig {
  return {
    id,
    name,
    type: 'custom',
    apiBase,
    apiKeyRequired: requiresKey,
    supportsStreaming: true, // Assume OpenAI-compatible
    models: [], // Will be fetched or manually configured
    badge: 'CUSTOM',
    color: '#9333EA'
  }
}

// Example custom providers
export const CUSTOM_PROVIDER_TEMPLATES = {
  'lm-studio': createCustomProvider(
    'lm-studio',
    'LM Studio',
    'http://localhost:1234/v1',
    false
  ),
  'localai': createCustomProvider(
    'localai',
    'LocalAI',
    'http://localhost:8080/v1',
    false
  ),
  'text-generation-webui': createCustomProvider(
    'text-generation-webui',
    'Text Generation WebUI',
    'http://localhost:5000/v1',
    false
  ),
  'openrouter': createCustomProvider(
    'openrouter',
    'OpenRouter',
    'https://openrouter.ai/api/v1',
    true
  )
}
