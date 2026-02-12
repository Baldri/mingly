import type { Message } from '../../shared/types'
import type { LLMClient } from './client-manager'
import type { StreamChunk } from './anthropic-client'

export class OllamaClient implements LLMClient {
  private baseURL = 'http://localhost:11434'

  setApiKey(_apiKey: string): void {
    // Ollama doesn't need API key, but keep interface compatible
  }

  async validateApiKey(): Promise<boolean> {
    try {
      // Check if Ollama is running
      const response = await fetch(`${this.baseURL}/api/version`, {
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

      const response = await fetch(`${this.baseURL}/api/chat`, {
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

    const response = await fetch(`${this.baseURL}/api/chat`, {
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

    const data = (await response.json()) as any
    return data.message?.content || ''
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
      const response = await fetch(`${this.baseURL}/api/tags`)

      if (!response.ok) {
        throw new Error('Failed to fetch Ollama models')
      }

      const data = (await response.json()) as any
      return data.models || []
    } catch (error) {
      console.error('Failed to get Ollama models:', error)
      return []
    }
  }

  // Ollama-specific: Pull a model
  async pullModel(modelName: string): Promise<void> {
    const response = await fetch(`${this.baseURL}/api/pull`, {
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
}
