import OpenAI from 'openai'
import type { Message } from '../../shared/types'
import type { StreamChunk } from './anthropic-client'

export class OpenAIClient {
  private client: OpenAI | null = null

  constructor(private apiKey: string) {
    if (apiKey) {
      this.client = new OpenAI({ apiKey })
    }
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey
    this.client = new OpenAI({ apiKey })
  }

  async validateApiKey(): Promise<boolean> {
    console.log(`[OpenAI] Validating API key - client exists: ${!!this.client}, apiKey length: ${this.apiKey?.length || 0}`)

    if (!this.client) {
      console.error('[OpenAI] Client not initialized')
      return false
    }

    if (!this.apiKey || this.apiKey.trim().length === 0) {
      console.error('[OpenAI] API key is empty')
      return false
    }

    try {
      console.log('[OpenAI] Testing API key by listing models...')
      // Test by listing models
      await this.client.models.list()
      console.log('[OpenAI] ✅ API key is valid!')
      return true
    } catch (error) {
      console.error('[OpenAI] ❌ API Key validation failed:', error)
      return false
    }
  }

  async *sendMessage(
    messages: Message[],
    model: string = 'gpt-4-turbo-preview',
    temperature: number = 1.0
  ): AsyncGenerator<StreamChunk> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized. API key missing.')
    }

    try {
      // Convert app messages to OpenAI format
      const openaiMessages = messages.map((msg) => ({
        role: msg.role,
        content: msg.content
      }))

      // Stream the response
      const stream = await this.client.chat.completions.create({
        model,
        messages: openaiMessages,
        temperature,
        stream: true
      })

      // Process stream chunks
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta

        if (delta?.content) {
          yield {
            content: delta.content,
            done: false
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          yield {
            content: '',
            done: true
          }
        }
      }
    } catch (error) {
      console.error('OpenAI API error:', error)
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  async sendMessageNonStreaming(
    messages: Message[],
    model: string = 'gpt-4-turbo-preview',
    temperature: number = 1.0
  ): Promise<string> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized. API key missing.')
    }

    try {
      const openaiMessages = messages.map((msg) => ({
        role: msg.role,
        content: msg.content
      }))

      const response = await this.client.chat.completions.create({
        model,
        messages: openaiMessages,
        temperature
      })

      return response.choices[0]?.message?.content || ''
    } catch (error) {
      console.error('OpenAI API error:', error)
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Get available models
  getModels(): string[] {
    return [
      'gpt-4-turbo-preview',
      'gpt-4',
      'gpt-4-32k',
      'gpt-3.5-turbo',
      'gpt-3.5-turbo-16k'
    ]
  }
}
