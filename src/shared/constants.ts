export const APP_NAME = 'Mingly'
export const APP_VERSION = '0.1.0'

// LLM Provider Configurations
export const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    defaultModel: 'gpt-4-turbo',
    apiKeyEnvVar: 'OPENAI_API_KEY'
  },
  anthropic: {
    name: 'Anthropic',
    models: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
    defaultModel: 'claude-3-sonnet',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY'
  },
  google: {
    name: 'Google',
    models: ['gemini-pro', 'gemini-ultra'],
    defaultModel: 'gemini-pro',
    apiKeyEnvVar: 'GOOGLE_API_KEY'
  },
  local: {
    name: 'Local LLM',
    models: ['local-model'],
    defaultModel: 'local-model',
    apiKeyEnvVar: ''
  }
} as const

// Token Costs (per 1K tokens in USD)
export const TOKEN_COSTS = {
  'gpt-4': { input: 0.03, output: 0.06 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'claude-3-opus': { input: 0.015, output: 0.075 },
  'claude-3-sonnet': { input: 0.003, output: 0.015 },
  'claude-3-haiku': { input: 0.00025, output: 0.00125 },
  'gemini-pro': { input: 0.0005, output: 0.0015 },
  'gemini-ultra': { input: 0.0005, output: 0.0015 },
  'local-model': { input: 0, output: 0 }
} as const

// Default LLM Configuration
export const DEFAULT_LLM_CONFIG = {
  temperature: 0.7,
  maxTokens: 2000,
  topP: 1.0
}

// Local LLM Server Endpoints
export const LOCAL_LLM_ENDPOINTS = {
  lmStudio: 'http://localhost:1234',
  ollama: 'http://localhost:11434'
}

// Keychain Configuration
export const KEYCHAIN_SERVICE = 'mingly'

// Database Configuration
export const DB_NAME = 'mingly.db'
export const DB_VERSION = 1
