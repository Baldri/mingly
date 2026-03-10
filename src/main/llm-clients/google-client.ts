import { GoogleGenerativeAI } from '@google/generative-ai'
import type { Message } from '../../shared/types'
import type { StreamChunk } from './anthropic-client'
import type { ProviderHealthCheck, HealthCheckItem } from './health-check-types'

export class GoogleClient {
  private client: GoogleGenerativeAI | null = null

  constructor(apiKey: string) {
    if (apiKey) {
      this.client = new GoogleGenerativeAI(apiKey)
    }
  }

  setApiKey(apiKey: string): void {
    this.client = new GoogleGenerativeAI(apiKey)
  }

  async validateApiKey(): Promise<boolean> {
    if (!this.client) return false

    try {
      // Simple test request to validate API key
      const model = this.client.getGenerativeModel({ model: 'gemini-pro' })
      await model.generateContent('Hi')
      return true
    } catch (error) {
      console.error('Google API Key validation failed:', error)
      return false
    }
  }

  async *sendMessage(
    messages: Message[],
    model: string = 'gemini-pro',
    temperature: number = 1.0
  ): AsyncGenerator<StreamChunk> {
    if (!this.client) {
      throw new Error('Google client not initialized. API key missing.')
    }

    try {
      const genModel = this.client.getGenerativeModel({
        model,
        generationConfig: {
          temperature
        }
      })

      // Convert messages to Gemini format (history + current message)
      // Gemini expects conversation history as "parts" array

      // Validate messages array is not empty
      if (messages.length === 0) {
        throw new Error('Messages array cannot be empty')
      }

      // Convert messages to Gemini format with vision support
      const history = messages.slice(0, -1).map((msg) => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: msg.attachments?.length
          ? [
              { text: msg.content },
              ...msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => ({
                  inlineData: { mimeType: att.mimeType, data: att.data }
                }))
            ]
          : [{ text: msg.content }]
      }))

      const lastMsg = messages[messages.length - 1]
      const currentParts = lastMsg.attachments?.length
        ? [
            { text: lastMsg.content },
            ...lastMsg.attachments
              .filter((att) => att.type === 'image')
              .map((att) => ({
                inlineData: { mimeType: att.mimeType, data: att.data }
              }))
          ]
        : lastMsg.content

      // Start chat with history
      const chat = genModel.startChat({
        history
      })

      // Stream the response
      const result = await chat.sendMessageStream(currentParts)

      // Process stream chunks
      for await (const chunk of result.stream) {
        const text = chunk.text()
        if (text) {
          yield {
            content: text,
            done: false
          }
        }
      }

      yield {
        content: '',
        done: true
      }
    } catch (error) {
      console.error('Google API error:', error)
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  async sendMessageNonStreaming(
    messages: Message[],
    model: string = 'gemini-pro',
    temperature: number = 1.0
  ): Promise<string> {
    if (!this.client) {
      throw new Error('Google client not initialized. API key missing.')
    }

    try {
      const genModel = this.client.getGenerativeModel({
        model,
        generationConfig: {
          temperature
        }
      })

      // Convert messages to Gemini format with vision support
      const history = messages.slice(0, -1).map((msg) => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: msg.attachments?.length
          ? [
              { text: msg.content },
              ...msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => ({
                  inlineData: { mimeType: att.mimeType, data: att.data }
                }))
            ]
          : [{ text: msg.content }]
      }))

      const lastMsg = messages[messages.length - 1]
      const currentParts = lastMsg.attachments?.length
        ? [
            { text: lastMsg.content },
            ...lastMsg.attachments
              .filter((att) => att.type === 'image')
              .map((att) => ({
                inlineData: { mimeType: att.mimeType, data: att.data }
              }))
          ]
        : lastMsg.content

      const chat = genModel.startChat({
        history
      })

      const result = await chat.sendMessage(currentParts)
      const response = await result.response
      return response.text()
    } catch (error) {
      console.error('Google API error:', error)
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  /**
   * Run a structured health check against the Google Generative AI API.
   * Checks API key presence, connectivity, and model availability.
   */
  async healthCheck(): Promise<ProviderHealthCheck> {
    const start = Date.now()
    const checks: HealthCheckItem[] = []
    let overallStatus: 'pass' | 'warn' | 'fail' = 'pass'

    // 1. Check if API key / client is configured
    if (!this.client) {
      checks.push({
        code: 'api_key_missing',
        level: 'error',
        message: 'API key is not configured'
      })
      return {
        provider: 'google',
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

    // 2. Test connectivity with a minimal generation request
    try {
      const model = this.client.getGenerativeModel({ model: 'gemini-pro' })
      await model.generateContent('ping')
      checks.push({
        code: 'api_reachable',
        level: 'info',
        message: 'Google Generative AI API is reachable and responding'
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)

      if (errorMsg.includes('API_KEY_INVALID') || errorMsg.includes('401') || errorMsg.includes('403')) {
        checks.push({
          code: 'api_auth_failed',
          level: 'error',
          message: 'API key is invalid or lacks permissions',
          detail: errorMsg
        })
        overallStatus = 'fail'
      } else if (errorMsg.includes('429') || errorMsg.includes('RESOURCE_EXHAUSTED')) {
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
          message: 'Failed to connect to Google Generative AI API',
          detail: errorMsg
        })
        overallStatus = 'fail'
      }
    }

    // 3. Report configured models
    const models = this.getModels()
    checks.push({
      code: 'models_available',
      level: 'info',
      message: `${models.length} models configured`,
      detail: models.join(', ')
    })

    return {
      provider: 'google',
      status: overallStatus,
      checks,
      testedAt: new Date().toISOString(),
      latencyMs: Date.now() - start
    }
  }

  // Get available models
  getModels(): string[] {
    return [
      'gemini-pro',
      'gemini-pro-vision' // For image inputs (future feature)
    ]
  }
}
