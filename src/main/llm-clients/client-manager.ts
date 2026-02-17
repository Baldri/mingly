import { AnthropicClient } from './anthropic-client'
import { OpenAIClient } from './openai-client'
import { GoogleClient } from './google-client'
import { OllamaClient } from './ollama-client'
import { GenericOpenAIClient } from './generic-openai-client'
import type { Message, ToolDefinition, AgentToolCall } from '../../shared/types'
import type { StreamChunk } from './anthropic-client'
import type { ProviderConfig } from '../../shared/provider-types'

export type LLMProvider = 'anthropic' | 'openai' | 'google' | 'ollama' | string

/**
 * Response from a tool-use capable LLM call.
 * The LLM may respond with text, tool calls, or both.
 * `stopReason` indicates whether the model wants to call tools or is done.
 */
export interface ToolUseResponse {
  /** Text content from the LLM (may be empty if only tool calls) */
  text: string
  /** Tool calls requested by the LLM */
  toolCalls: AgentToolCall[]
  /** Whether the model finished generating */
  done: boolean
  /** Why the model stopped: 'stop' = final answer, 'tool_use' = wants to call tools */
  stopReason: 'stop' | 'tool_use'
  /** Token usage for this turn (if available from the API) */
  tokens?: { input: number; output: number }
}

export interface LLMClient {
  setApiKey(apiKey: string): void
  validateApiKey(): Promise<boolean>
  sendMessage(
    messages: Message[],
    model: string,
    temperature: number
  ): AsyncGenerator<StreamChunk>
  sendMessageNonStreaming(
    messages: Message[],
    model: string,
    temperature: number
  ): Promise<string>
  getModels(): string[]

  /**
   * Send a message with tool definitions. Non-streaming.
   * The LLM may respond with tool_calls that the caller must execute.
   * Only implemented by providers that support native tool-use (Anthropic, OpenAI).
   */
  sendMessageWithTools?(
    messages: Message[],
    model: string,
    tools: ToolDefinition[],
    temperature?: number
  ): Promise<ToolUseResponse>

  /** Whether this client supports native tool-use via sendMessageWithTools() */
  supportsToolUse?(): boolean
}

export class LLMClientManager {
  private clients: Map<string, LLMClient> = new Map()
  private apiKeys: Map<string, string> = new Map()
  private customProviders: Map<string, ProviderConfig> = new Map()

  constructor() {
    // Initialize built-in clients with empty API keys
    this.clients.set('anthropic', new AnthropicClient(''))
    this.clients.set('openai', new OpenAIClient(''))
    this.clients.set('google', new GoogleClient(''))
    this.clients.set('ollama', new OllamaClient())
    // 'local' is an alias for ollama (for routing purposes)
    this.clients.set('local', new OllamaClient())
  }

  /**
   * Register a custom provider (e.g., LM Studio, LocalAI, OpenRouter)
   */
  registerCustomProvider(config: ProviderConfig): void {
    this.customProviders.set(config.id, config)

    // Create client based on type
    if (config.type === 'ollama') {
      this.clients.set(config.id, new OllamaClient())
    } else if (config.apiBase) {
      // OpenAI-compatible custom provider
      this.clients.set(config.id, new GenericOpenAIClient(config.apiBase))
    }
  }

  /**
   * Get list of all registered providers (built-in + custom)
   */
  getProviders(): string[] {
    return Array.from(this.clients.keys())
  }

  /**
   * Check if provider is registered
   */
  hasProvider(provider: string): boolean {
    return this.clients.has(provider)
  }

  setApiKey(provider: string, apiKey: string): void {
    // Clear old key reference before setting new one
    if (this.apiKeys.has(provider)) {
      this.apiKeys.delete(provider)
    }
    this.apiKeys.set(provider, apiKey)

    const client = this.clients.get(provider)
    if (client) {
      client.setApiKey(apiKey)
    }
  }

  getApiKey(provider: string): string | undefined {
    return this.apiKeys.get(provider)
  }

  /**
   * Remove an API key from memory. Call when a key is deleted or on shutdown.
   */
  clearApiKey(provider: string): void {
    this.apiKeys.delete(provider)
    const client = this.clients.get(provider)
    if (client) {
      client.setApiKey('')
    }
  }

  /**
   * Clear all API keys from memory. Call on app shutdown for security.
   */
  clearAllApiKeys(): void {
    for (const provider of this.apiKeys.keys()) {
      const client = this.clients.get(provider)
      if (client) {
        client.setApiKey('')
      }
    }
    this.apiKeys.clear()
  }

  hasApiKey(provider: string): boolean {
    // Ollama, local and custom local providers don't need API keys
    if (provider === 'ollama' || provider === 'local' || this.customProviders.get(provider)?.apiKeyRequired === false) {
      return true
    }

    const apiKey = this.apiKeys.get(provider)
    return !!apiKey && apiKey.length > 0
  }

  async validateApiKey(provider: string): Promise<boolean> {
    const client = this.clients.get(provider)
    if (!client) {
      throw new Error(`Unknown provider: ${provider}`)
    }

    console.log(`[ClientManager] Validating ${provider}`)

    // For providers without API key requirement, just check connectivity
    if (provider === 'ollama' || provider === 'local' || this.customProviders.get(provider)?.apiKeyRequired === false) {
      try {
        return await client.validateApiKey()
      } catch (error) {
        console.error(`Provider connectivity check failed for ${provider}:`, error)
        return false
      }
    }

    if (!this.hasApiKey(provider)) {
      console.error(`[ClientManager] No API key found for ${provider}, returning false WITHOUT validation`)
      return false
    }

    try {
      console.log(`[ClientManager] Calling ${provider}.validateApiKey()...`)
      return await client.validateApiKey()
    } catch (error) {
      console.error(`API key validation failed for ${provider}:`, error)
      return false
    }
  }

  getClient(provider: string): LLMClient {
    const client = this.clients.get(provider)
    if (!client) {
      throw new Error(`Unknown provider: ${provider}`)
    }

    // Check API key only if required
    const customConfig = this.customProviders.get(provider)
    const requiresKey = (provider === 'ollama' || provider === 'local') ? false : customConfig?.apiKeyRequired !== false

    if (requiresKey && !this.hasApiKey(provider)) {
      throw new Error(`API key not set for provider: ${provider}`)
    }

    return client
  }

  async sendMessage(
    provider: string,
    messages: Message[],
    model: string,
    temperature: number = 1.0
  ): Promise<AsyncGenerator<StreamChunk>> {
    const client = this.getClient(provider)
    return client.sendMessage(messages, model, temperature)
  }

  async sendMessageNonStreaming(
    provider: string,
    messages: Message[],
    model: string,
    temperature: number = 1.0
  ): Promise<string> {
    const client = this.getClient(provider)
    return await client.sendMessageNonStreaming(messages, model, temperature)
  }

  /**
   * Send a message with tool definitions (non-streaming).
   * Throws if the provider doesn't support tool-use.
   */
  async sendMessageWithTools(
    provider: string,
    messages: Message[],
    model: string,
    tools: ToolDefinition[],
    temperature: number = 1.0
  ): Promise<ToolUseResponse> {
    const client = this.getClient(provider)
    if (!client.sendMessageWithTools) {
      throw new Error(`Provider "${provider}" does not support tool-use. Use Anthropic or OpenAI.`)
    }
    return await client.sendMessageWithTools(messages, model, tools, temperature)
  }

  /**
   * Check if a provider supports native tool-use.
   */
  providerSupportsToolUse(provider: string): boolean {
    const client = this.clients.get(provider)
    if (!client) return false
    return client.supportsToolUse?.() ?? false
  }

  getModels(provider: LLMProvider): string[] {
    const client = this.clients.get(provider)
    if (!client) {
      throw new Error(`Unknown provider: ${provider}`)
    }
    return client.getModels()
  }

  getAllProviders(): LLMProvider[] {
    return Array.from(this.clients.keys())
  }

  getProvidersWithApiKeys(): LLMProvider[] {
    return this.getAllProviders().filter((provider) => this.hasApiKey(provider))
  }
}

// Singleton instance
let clientManagerInstance: LLMClientManager | null = null

export function getClientManager(): LLMClientManager {
  if (!clientManagerInstance) {
    clientManagerInstance = new LLMClientManager()
  }
  return clientManagerInstance
}
