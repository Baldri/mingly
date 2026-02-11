import type { LLMConfig, Message } from '../../shared/types'

export interface StreamChunk {
  content: string
  done: boolean
}

export interface SendMessageParams {
  messages: Message[]
  config: LLMConfig
  onChunk?: (chunk: StreamChunk) => void
}

export interface SendMessageResult {
  content: string
  tokens?: {
    prompt: number
    completion: number
    total: number
  }
  cost?: number
}

export abstract class BaseLLMClient {
  abstract provider: string

  /**
   * Send a message and get streaming response
   */
  abstract sendMessage(params: SendMessageParams): Promise<SendMessageResult>

  /**
   * Validate API key by making a test request
   */
  abstract validateApiKey(apiKey: string): Promise<boolean>

  /**
   * Get available models for this provider
   */
  abstract getAvailableModels(): Promise<string[]>

  /**
   * Calculate cost based on token usage and model
   */
  protected calculateCost(
    tokens: { prompt: number; completion: number },
    model: string
  ): number {
    // Override in subclasses with provider-specific pricing
    return 0
  }
}
