import type { Message } from '../../shared/types'
import type { LLMClient } from './client-manager'
import type { StreamChunk } from './anthropic-client'

/**
 * Generic OpenAI-compatible client
 * Works with: LM Studio, LocalAI, text-generation-webui, OpenRouter, etc.
 */
export class GenericOpenAIClient implements LLMClient {
  private apiKey: string = ''
  private baseURL: string

  constructor(baseURL: string) {
    this.baseURL = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey
  }

  async validateApiKey(): Promise<boolean> {
    try {
      // Try to list models as health check
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: this.getHeaders()
      })
      return response.ok
    } catch (error) {
      console.error('Generic OpenAI client validation failed:', error)
      return false
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    }

    return headers
  }

  async *sendMessage(
    messages: Message[],
    model: string,
    temperature: number = 1.0
  ): AsyncGenerator<StreamChunk> {
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

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          model: model,
          messages: openaiMessages,
          temperature: temperature,
          stream: true
        })
      })

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`)
      }

      if (!response.body) {
        throw new Error('No response body')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          yield { content: '', done: true }
          break
        }

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n').filter((line) => line.trim())

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)

            if (data === '[DONE]') {
              yield { content: '', done: true }
              return
            }

            try {
              const parsed = JSON.parse(data)
              const content = parsed.choices?.[0]?.delta?.content || ''

              if (content) {
                yield {
                  content: content,
                  done: false
                }
              }
            } catch (e) {
              console.warn('Failed to parse SSE chunk:', e)
            }
          }
        }
      }
    } catch (error) {
      console.error('Generic OpenAI streaming error:', error)
      throw error
    }
  }

  async sendMessageNonStreaming(
    messages: Message[],
    model: string,
    temperature: number = 1.0
  ): Promise<string> {
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

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: model,
        messages: openaiMessages,
        temperature: temperature,
        stream: false
      })
    })

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`)
    }

    const data = (await response.json()) as any
    return data.choices?.[0]?.message?.content || ''
  }

  getModels(): string[] {
    // Models will be fetched dynamically via API
    return []
  }

  async fetchModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseURL}/models`, {
        method: 'GET',
        headers: this.getHeaders()
      })

      if (!response.ok) {
        throw new Error('Failed to fetch models')
      }

      const data = (await response.json()) as any
      return data.data?.map((m: any) => m.id) || []
    } catch (error) {
      console.error('Failed to fetch models:', error)
      return []
    }
  }
}
