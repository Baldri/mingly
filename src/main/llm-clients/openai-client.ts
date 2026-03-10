import OpenAI from 'openai'
import type { Message, ToolDefinition, AgentToolCall } from '../../shared/types'
import type { StreamChunk } from './anthropic-client'
import type { ToolUseResponse } from './client-manager'
import type { ProviderHealthCheck, HealthCheckItem } from './health-check-types'

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
    console.log(`[OpenAI] Validating API key - client exists: ${!!this.client}, hasKey: ${!!this.apiKey}`)

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
      // Convert app messages to OpenAI format (with vision support)
      const openaiMessages = messages.map((msg) => ({
        role: msg.role,
        content: msg.attachments?.length
          ? [
              { type: 'text' as const, text: msg.content },
              ...msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => ({
                  type: 'image_url' as const,
                  image_url: {
                    url: `data:${att.mimeType};base64,${att.data}`
                  }
                }))
            ]
          : msg.content
      }))

      // Stream the response
      const stream = await this.client.chat.completions.create({
        model,
        messages: openaiMessages as any,
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
        content: msg.attachments?.length
          ? [
              { type: 'text' as const, text: msg.content },
              ...msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => ({
                  type: 'image_url' as const,
                  image_url: {
                    url: `data:${att.mimeType};base64,${att.data}`
                  }
                }))
            ]
          : msg.content
      }))

      const response = await this.client.chat.completions.create({
        model,
        messages: openaiMessages as any,
        temperature
      })

      return response.choices[0]?.message?.content || ''
    } catch (error) {
      console.error('OpenAI API error:', error)
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Send a message with tool definitions (non-streaming).
   * Uses OpenAI's function calling / tool_calls feature.
   * Returns structured response with text and/or tool calls.
   */
  async sendMessageWithTools(
    messages: Message[],
    model: string,
    tools: ToolDefinition[],
    temperature: number = 1.0
  ): Promise<ToolUseResponse> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized. API key missing.')
    }

    // Convert app messages to OpenAI format
    // OpenAI uses 'tool' role for tool results and 'assistant' with tool_calls
    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = messages.map((msg) => {
      // Tool result messages
      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          tool_call_id: msg.toolCallId ?? '',
          content: msg.content
        }
      }

      // Assistant messages with tool calls from previous turns
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        return {
          role: 'assistant' as const,
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments)
            }
          }))
        }
      }

      // Regular user/assistant messages (with optional vision)
      if (msg.role === 'user' && msg.attachments?.length) {
        return {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: msg.content },
            ...msg.attachments
              .filter((att) => att.type === 'image')
              .map((att) => ({
                type: 'image_url' as const,
                image_url: {
                  url: `data:${att.mimeType};base64,${att.data}`
                }
              }))
          ]
        }
      }

      return {
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content
      }
    })

    // Convert ToolDefinition[] to OpenAI tool format
    const openaiTools: OpenAI.ChatCompletionTool[] = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }))

    try {
      const response = await this.client.chat.completions.create({
        model,
        messages: openaiMessages,
        tools: openaiTools,
        temperature
      })

      const choice = response.choices[0]
      if (!choice) {
        throw new Error('No response choice returned from OpenAI')
      }

      const assistantMsg = choice.message
      const text = assistantMsg.content ?? ''
      const toolCalls: AgentToolCall[] = []

      // Parse tool_calls from the response
      // OpenAI SDK v6 has a union type: FunctionToolCall | CustomToolCall
      // We only handle function tool calls (type === 'function')
      if (assistantMsg.tool_calls?.length) {
        for (const tc of assistantMsg.tool_calls) {
          if (tc.type !== 'function') continue // Skip custom tool calls

          const fnCall = tc as { id: string; type: 'function'; function: { name: string; arguments: string } }
          let parsedArgs: Record<string, unknown> = {}
          try {
            parsedArgs = JSON.parse(fnCall.function.arguments)
          } catch {
            console.warn(`Failed to parse tool call arguments for ${fnCall.function.name}`)
          }

          toolCalls.push({
            id: fnCall.id,
            name: fnCall.function.name,
            arguments: parsedArgs
          })
        }
      }

      const finishReason = choice.finish_reason

      return {
        text,
        toolCalls,
        done: finishReason !== 'tool_calls',
        stopReason: finishReason === 'tool_calls' ? 'tool_use' : 'stop',
        tokens: response.usage
          ? {
              input: response.usage.prompt_tokens,
              output: response.usage.completion_tokens
            }
          : undefined
      }
    } catch (error) {
      console.error('OpenAI tool-use API error:', error)
      throw new Error(
        `OpenAI tool-use failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /** OpenAI supports native tool-use (function calling) */
  supportsToolUse(): boolean {
    return true
  }

  /**
   * Run a structured health check against the OpenAI API.
   * Checks API key presence, connectivity via models.list(), and model availability.
   */
  async healthCheck(): Promise<ProviderHealthCheck> {
    const start = Date.now()
    const checks: HealthCheckItem[] = []
    let overallStatus: 'pass' | 'warn' | 'fail' = 'pass'

    // 1. Check if API key is configured
    if (!this.client || !this.apiKey || this.apiKey.trim().length === 0) {
      checks.push({
        code: 'api_key_missing',
        level: 'error',
        message: 'API key is not configured'
      })
      return {
        provider: 'openai',
        status: 'fail',
        checks,
        testedAt: new Date().toISOString(),
        latencyMs: Date.now() - start
      }
    }

    checks.push({
      code: 'api_key_set',
      level: 'info',
      message: 'API key is configured'
    })

    // 2. Test API connectivity by listing models
    try {
      const modelList = await this.client.models.list()
      const modelIds: string[] = []
      for await (const model of modelList) {
        modelIds.push(model.id)
      }
      checks.push({
        code: 'api_reachable',
        level: 'info',
        message: 'OpenAI API is reachable and responding'
      })
      checks.push({
        code: 'models_available',
        level: 'info',
        message: `${modelIds.length} models available from API`,
        detail: modelIds.slice(0, 10).join(', ') + (modelIds.length > 10 ? '...' : '')
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)

      if (errorMsg.includes('401') || errorMsg.includes('Incorrect API key')) {
        checks.push({
          code: 'api_auth_failed',
          level: 'error',
          message: 'API key is invalid or expired',
          detail: errorMsg
        })
        overallStatus = 'fail'
      } else if (errorMsg.includes('429') || errorMsg.includes('rate')) {
        checks.push({
          code: 'api_rate_limited',
          level: 'warn',
          message: 'API is rate-limited but reachable',
          detail: errorMsg
        })
        overallStatus = 'warn'
      } else {
        checks.push({
          code: 'api_unreachable',
          level: 'error',
          message: 'Failed to connect to OpenAI API',
          detail: errorMsg
        })
        overallStatus = 'fail'
      }
    }

    return {
      provider: 'openai',
      status: overallStatus,
      checks,
      testedAt: new Date().toISOString(),
      latencyMs: Date.now() - start
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
