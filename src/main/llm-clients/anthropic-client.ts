import Anthropic from '@anthropic-ai/sdk'
import type { Message, ToolDefinition, AgentToolCall } from '../../shared/types'
import type { ToolUseResponse } from './client-manager'

export interface StreamChunk {
  content: string
  done: boolean
}

export class AnthropicClient {
  private client: Anthropic | null = null

  constructor(apiKey: string) {
    if (apiKey) {
      this.client = new Anthropic({ apiKey })
    }
  }

  setApiKey(apiKey: string): void {
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

  /**
   * Send a message with tool definitions (non-streaming).
   * Uses Anthropic's native tool_use feature.
   * Returns structured response with text and/or tool calls.
   */
  async sendMessageWithTools(
    messages: Message[],
    model: string,
    tools: ToolDefinition[],
    temperature: number = 1.0
  ): Promise<ToolUseResponse> {
    if (!this.client) {
      throw new Error('Anthropic client not initialized. API key missing.')
    }

    // Convert app messages to Anthropic format
    // Anthropic tool-use conversations may include tool_result messages
    const anthropicMessages = messages.map((msg) => {
      // Tool result messages use a special format
      if (msg.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: msg.toolCallId ?? '',
              content: msg.content
            }
          ]
        }
      }

      // Assistant messages may contain tool_use blocks from previous turns
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const contentBlocks: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        > = []

        // Add text block if there's content
        if (msg.content) {
          contentBlocks.push({ type: 'text' as const, text: msg.content })
        }

        // Add tool_use blocks
        for (const tc of msg.toolCalls) {
          contentBlocks.push({
            type: 'tool_use' as const,
            id: tc.id,
            name: tc.name,
            input: tc.arguments
          })
        }

        return {
          role: 'assistant' as const,
          content: contentBlocks
        }
      }

      // Regular user/assistant messages (with optional vision)
      return {
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
      }
    })

    // Convert ToolDefinition[] to Anthropic tool format
    const anthropicTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
    }))

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: 4096,
        temperature,
        messages: anthropicMessages as Anthropic.MessageParam[],
        tools: anthropicTools
      })

      // Parse response: extract text blocks and tool_use blocks
      let text = ''
      const toolCalls: AgentToolCall[] = []

      for (const block of response.content) {
        if (block.type === 'text') {
          text += block.text
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: (block.input as Record<string, unknown>) ?? {}
          })
        }
      }

      return {
        text,
        toolCalls,
        done: response.stop_reason !== 'tool_use',
        stopReason: response.stop_reason === 'tool_use' ? 'tool_use' : 'stop',
        tokens: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens
        }
      }
    } catch (error) {
      console.error('Anthropic tool-use API error:', error)
      throw new Error(
        `Anthropic tool-use failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /** Anthropic supports native tool-use */
  supportsToolUse(): boolean {
    return true
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
