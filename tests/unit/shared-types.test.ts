/**
 * Shared Types & Constants Tests
 * Validates exported types, constants, and IPC channel definitions.
 */

import { describe, it, expect } from 'vitest'
import { IPC_CHANNELS } from '../../src/shared/types'
import {
  APP_NAME,
  APP_VERSION,
  PROVIDERS,
  TOKEN_COSTS,
  DEFAULT_LLM_CONFIG,
  LOCAL_LLM_ENDPOINTS,
  KEYCHAIN_SERVICE,
  DB_NAME,
  DB_VERSION
} from '../../src/shared/constants'

describe('IPC_CHANNELS', () => {
  it('should have all LLM channels', () => {
    expect(IPC_CHANNELS.SEND_MESSAGE).toBe('llm:send-message')
    expect(IPC_CHANNELS.STREAM_MESSAGE).toBe('llm:stream-message')
    expect(IPC_CHANNELS.STREAM_CHUNK).toBe('llm:stream-chunk')
    expect(IPC_CHANNELS.VALIDATE_API_KEY).toBe('llm:validate-api-key')
  })

  it('should have all key management channels', () => {
    expect(IPC_CHANNELS.SAVE_API_KEY).toBe('keys:save')
    expect(IPC_CHANNELS.GET_API_KEY).toBe('keys:get')
    expect(IPC_CHANNELS.DELETE_API_KEY).toBe('keys:delete')
    expect(IPC_CHANNELS.LIST_API_KEYS).toBe('keys:list')
  })

  it('should have all MCP channels', () => {
    expect(IPC_CHANNELS.LIST_MCP_SERVERS).toBe('mcp:list-servers')
    expect(IPC_CHANNELS.CONNECT_MCP_SERVER).toBe('mcp:connect')
    expect(IPC_CHANNELS.DISCONNECT_MCP_SERVER).toBe('mcp:disconnect')
    expect(IPC_CHANNELS.LIST_MCP_TOOLS).toBe('mcp:list-tools')
    expect(IPC_CHANNELS.EXECUTE_MCP_TOOL).toBe('mcp:execute-tool')
  })

  it('should have all conversation channels', () => {
    expect(IPC_CHANNELS.CREATE_CONVERSATION).toBe('conversations:create')
    expect(IPC_CHANNELS.GET_CONVERSATION).toBe('conversations:get')
    expect(IPC_CHANNELS.GET_CONVERSATIONS).toBe('conversations:list')
    expect(IPC_CHANNELS.DELETE_CONVERSATION).toBe('conversations:delete')
  })

  it('should have tracking channels', () => {
    expect(IPC_CHANNELS.TRACKING_GET_SUMMARY).toBe('tracking:get-summary')
    expect(IPC_CHANNELS.TRACKING_GET_DAILY_USAGE).toBe('tracking:get-daily-usage')
    expect(IPC_CHANNELS.TRACKING_GET_RECENT_EVENTS).toBe('tracking:get-recent-events')
  })

  it('should have budget channels', () => {
    expect(IPC_CHANNELS.BUDGET_GET_CONFIG).toBe('budget:get-config')
    expect(IPC_CHANNELS.BUDGET_UPDATE_CONFIG).toBe('budget:update-config')
    expect(IPC_CHANNELS.BUDGET_GET_STATUS).toBe('budget:get-status')
  })

  it('should have RAG channels', () => {
    expect(IPC_CHANNELS.RAG_INITIALIZE).toBe('rag:initialize')
    expect(IPC_CHANNELS.RAG_SEARCH).toBe('rag:search')
    expect(IPC_CHANNELS.RAG_GET_CONTEXT).toBe('rag:get-context')
  })

  it('should have unique channel values (no duplicates)', () => {
    const values = Object.values(IPC_CHANNELS)
    const uniqueValues = new Set(values)
    expect(uniqueValues.size).toBe(values.length)
  })
})

describe('Constants', () => {
  it('should export app metadata', () => {
    expect(APP_NAME).toBe('Mingly')
    expect(APP_VERSION).toBe('0.1.0')
  })

  it('should define all providers', () => {
    expect(PROVIDERS.openai.name).toBe('OpenAI')
    expect(PROVIDERS.anthropic.name).toBe('Anthropic')
    expect(PROVIDERS.google.name).toBe('Google')
    expect(PROVIDERS.local.name).toBe('Local LLM')
  })

  it('should have models for each provider', () => {
    expect(PROVIDERS.openai.models.length).toBeGreaterThan(0)
    expect(PROVIDERS.anthropic.models.length).toBeGreaterThan(0)
    expect(PROVIDERS.google.models.length).toBeGreaterThan(0)
  })

  it('should have default models for each provider', () => {
    expect(PROVIDERS.openai.defaultModel).toBeDefined()
    expect(PROVIDERS.anthropic.defaultModel).toBeDefined()
    expect(PROVIDERS.google.defaultModel).toBeDefined()
  })

  it('should define token costs', () => {
    expect(TOKEN_COSTS['gpt-4'].input).toBeGreaterThan(0)
    expect(TOKEN_COSTS['gpt-4'].output).toBeGreaterThan(0)
    expect(TOKEN_COSTS['local-model'].input).toBe(0)
    expect(TOKEN_COSTS['local-model'].output).toBe(0)
  })

  it('should define default LLM config', () => {
    expect(DEFAULT_LLM_CONFIG.temperature).toBe(0.7)
    expect(DEFAULT_LLM_CONFIG.maxTokens).toBe(2000)
    expect(DEFAULT_LLM_CONFIG.topP).toBe(1.0)
  })

  it('should define local LLM endpoints', () => {
    expect(LOCAL_LLM_ENDPOINTS.ollama).toContain('localhost')
    expect(LOCAL_LLM_ENDPOINTS.lmStudio).toContain('localhost')
  })

  it('should define keychain and DB config', () => {
    expect(KEYCHAIN_SERVICE).toBe('mingly')
    expect(DB_NAME).toBe('mingly.db')
    expect(DB_VERSION).toBe(1)
  })
})
