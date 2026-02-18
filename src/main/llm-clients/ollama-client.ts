import type { Message, ToolDefinition } from '../../shared/types'
import type { LLMClient, ToolUseResponse } from './client-manager'
import type { StreamChunk } from './anthropic-client'
import { fetchWithTools } from './openai-tool-use-helper'
import { getOllamaLoadBalancer } from '../network/ollama-load-balancer'

// ── Response types for Ollama API ─────────────────────────────

interface OllamaChatResponse {
  message?: { content?: string }
  done?: boolean
}

interface OllamaTagsResponse {
  models?: Array<{ name: string; size: number; modified: string }>
}

export class OllamaClient implements LLMClient {
  private baseURL = 'http://localhost:11434'

  setApiKey(_apiKey: string): void {
    // Ollama doesn't need API key, but keep interface compatible
  }

  /**
   * Set the base URL for this client (used by LocalAIBridge for network servers).
   */
  setBaseURL(url: string): void {
    this.baseURL = url
  }

  /**
   * Get the effective base URL, consulting the load balancer when multi-backend is available.
   * Falls back to the configured baseURL if no load-balanced backends are healthy.
   */
  private getEffectiveBaseURL(): string {
    const balancer = getOllamaLoadBalancer()
    if (balancer.isBalancingAvailable()) {
      const url = balancer.getNextUrl()
      if (url) return url
    }
    return this.baseURL
  }

  async validateApiKey(): Promise<boolean> {
    try {
      // Check if Ollama is running (use effective URL for load-balanced setups)
      const effectiveUrl = this.getEffectiveBaseURL()
      const response = await fetch(`${effectiveUrl}/api/version`, {
        method: 'GET'
      })
      return response.ok
    } catch (error) {
      console.error('Ollama not running:', error)
      return false
    }
  }

  async *sendMessage(
    messages: Message[],
    model: string,
    temperature: number = 1.0
  ): AsyncGenerator<StreamChunk> {
    try {
      // Convert messages to Ollama format (with vision support for llava/bakllava)
      const ollamaMessages = messages.map((msg) => ({
        role: msg.role === 'system' ? 'system' : msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
        ...(msg.attachments?.length
          ? {
              images: msg.attachments
                .filter((att) => att.type === 'image')
                .map((att) => att.data)
            }
          : {})
      }))

      const effectiveUrl = this.getEffectiveBaseURL()
      const response = await fetch(`${effectiveUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: model,
          messages: ollamaMessages,
          stream: true,
          options: {
            temperature: temperature
          }
        })
      })

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.statusText}`)
      }

      if (!response.body) {
        throw new Error('No response body from Ollama')
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
          try {
            const data = JSON.parse(line)

            if (data.message?.content) {
              yield {
                content: data.message.content,
                done: false
              }
            }

            if (data.done) {
              yield { content: '', done: true }
              return
            }
          } catch (e) {
            console.warn('Failed to parse Ollama chunk:', e)
          }
        }
      }
    } catch (error) {
      console.error('Ollama streaming error:', error)
      throw error
    }
  }

  async sendMessageNonStreaming(
    messages: Message[],
    model: string,
    temperature: number = 1.0
  ): Promise<string> {
    const ollamaMessages = messages.map((msg) => ({
      role: msg.role === 'system' ? 'system' : msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
      ...(msg.attachments?.length
        ? {
            images: msg.attachments
              .filter((att) => att.type === 'image')
              .map((att) => att.data)
          }
        : {})
    }))

    const effectiveUrl = this.getEffectiveBaseURL()
    const response = await fetch(`${effectiveUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        messages: ollamaMessages,
        stream: false,
        options: {
          temperature: temperature
        }
      })
    })

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.statusText}`)
    }

    const data = (await response.json()) as OllamaChatResponse
    return data.message?.content ?? ''
  }

  getModels(): string[] {
    // Models will be fetched dynamically
    return [
      'gemma2:2b',
      'llama3:8b',
      'llama3:70b',
      'mistral:7b',
      'mixtral:8x7b',
      'phi3:mini',
      'codellama:7b'
    ]
  }

  // Ollama-specific: Fetch installed models
  async getInstalledModels(): Promise<
    Array<{ name: string; size: number; modified: string }>
  > {
    try {
      const effectiveUrl = this.getEffectiveBaseURL()
      const response = await fetch(`${effectiveUrl}/api/tags`)

      if (!response.ok) {
        throw new Error('Failed to fetch Ollama models')
      }

      const data = (await response.json()) as OllamaTagsResponse
      if (!Array.isArray(data?.models)) return []
      return data.models
    } catch (error) {
      console.error('Failed to get Ollama models:', error)
      return []
    }
  }

  // Ollama-specific: Pull a model
  async pullModel(modelName: string): Promise<void> {
    const effectiveUrl = this.getEffectiveBaseURL()
    const response = await fetch(`${effectiveUrl}/api/pull`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: modelName
      })
    })

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${response.statusText}`)
    }

    // Stream progress updates
    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value)
      const lines = chunk.split('\n').filter((line) => line.trim())

      for (const line of lines) {
        try {
          const data = JSON.parse(line)
          console.log('Pull progress:', data.status)
        } catch (e) {
          // Ignore parse errors
        }
      }
    }
  }

  /**
   * Send a message with tool definitions via Ollama's OpenAI-compatible endpoint.
   * Uses /v1/chat/completions which supports the OpenAI tool_calls format.
   */
  async sendMessageWithTools(
    messages: Message[],
    model: string,
    tools: ToolDefinition[],
    temperature: number = 1.0
  ): Promise<ToolUseResponse> {
    // Use OpenAI-compatible endpoint (no API key needed for local Ollama)
    const effectiveUrl = this.getEffectiveBaseURL()
    return fetchWithTools(
      `${effectiveUrl}/v1`,
      model,
      messages,
      tools,
      temperature,
      {}, // No Authorization header needed
      'Ollama'
    )
  }

  /** Ollama supports tool-use via OpenAI-compatible endpoint */
  supportsToolUse(): boolean {
    return true
  }
}
