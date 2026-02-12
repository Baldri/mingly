import Anthropic from '@anthropic-ai/sdk'
import type { Message } from '../../shared/types'

export interface StreamChunk {
  content: string
  done: boolean
}

export class AnthropicClient {
  private client: Anthropic | null = null

  constructor(private apiKey: string) {
    if (apiKey) {
      this.client = new Anthropic({ apiKey })
    }
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey
    this.client = new Anthropic({ apiKey })
  }

  async validateApiKey(): Promise<boolean> {
    if (!this.client) return false

    try {
      // Simple test request to validate API key
      await this.client.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }]
      })
      return true
    } catch (error) {
      console.error('API Key validation failed:', error)
      return false
    }
  }

  async *sendMessage(
    messages: Message[],
    model: string = 'claude-3-5-sonnet-20241022',
    temperature: number = 1.0
  ): AsyncGenerator<StreamChunk> {
    if (!this.client) {
      throw new Error('Anthropic client not initialized. API key missing.')
    }

    try {
      // Convert app messages to Anthropic format (with vision support)
      const anthropicMessages = messages.map((msg) => ({
        role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: msg.attachments?.length
          ? [
              ...msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: att.mimeType,
                    data: att.data
                  }
                })),
              { type: 'text' as const, text: msg.content }
            ]
          : msg.content
      }))

      // Stream the response
      const stream = await this.client.messages.stream({
        model,
        max_tokens: 4096,
        temperature,
        messages: anthropicMessages
      })

      // Process stream chunks
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta') {
          if (chunk.delta.type === 'text_delta') {
            yield {
              content: chunk.delta.text,
              done: false
            }
          }
        } else if (chunk.type === 'message_stop') {
          yield {
            content: '',
            done: true
          }
        }
      }
    } catch (error) {
      console.error('Anthropic API error:', error)
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  async sendMessageNonStreaming(
    messages: Message[],
    model: string = 'claude-3-5-sonnet-20241022',
    temperature: number = 1.0
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Anthropic client not initialized. API key missing.')
    }

    try {
      const anthropicMessages = messages.map((msg) => ({
        role: msg.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: msg.attachments?.length
          ? [
              ...msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => ({
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: att.mimeType,
                    data: att.data
                  }
                })),
              { type: 'text' as const, text: msg.content }
            ]
          : msg.content
      }))

      const response = await this.client.messages.create({
        model,
        max_tokens: 4096,
        temperature,
        messages: anthropicMessages
      })

      // Extract text from response
      const textContent = response.content.find((block) => block.type === 'text')
      return textContent && 'text' in textContent ? textContent.text : ''
    } catch (error) {
      console.error('Anthropic API error:', error)
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Get available models
  getModels(): string[] {
    return [
      'claude-3-5-sonnet-20241022', // Latest Sonnet
      'claude-3-opus-20240229',
      'claude-3-sonnet-20240229',
      'claude-3-haiku-20240307'
    ]
  }
}
