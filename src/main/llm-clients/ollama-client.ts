import type { Message, ToolDefinition } from '../../shared/types'
import type { LLMClient, ToolUseResponse } from './client-manager'
import type { StreamChunk } from './anthropic-client'
import type { ProviderHealthCheck, HealthCheckItem } from './health-check-types'
import { fetchWithTools } from './openai-tool-use-helper'
import { getOllamaLoadBalancer } from '../network/ollama-load-balancer'
import { isLoopbackUrl } from '../../shared/network-ai-types'

/**
 * Refuse a destination that is not this machine.
 *
 * Only reached for an UNPINNED client, i.e. the built-in `ollama` / `local`
 * provider. Those two ids are registered with `residency: 'on-device'`, which
 * makes `residencyIsCloud` false and so skips preflightGuard's sensitive-data
 * and upload-consent branch altogether. If that provider could reach another
 * host, content would leave the device with no consent check and an audit
 * trail recording it as on-device — the error is the lesser outcome.
 */
function assertOnDevice(url: string): string {
  if (isLoopbackUrl(url)) return url
  throw new Error(
    `Refusing to send an on-device request to "${url}": that host is not this machine. ` +
      'Select the network provider for that server instead.'
  )
}

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
  /**
   * True once a caller named this client's endpoint explicitly. A pinned
   * client is one particular server — the `network:{id}` provider the user
   * picked — and must reach THAT machine, so it never consults the shared
   * pool. Unpinned, the client is the built-in `ollama` / `local` provider.
   */
  private endpointPinned = false

  setApiKey(_apiKey: string): void {
    // Ollama doesn't need API key, but keep interface compatible
  }

  /**
   * Pin this client to one endpoint (used by LocalAIBridge for network
   * servers, via LLMClientManager.registerCustomProvider).
   *
   * Pinning is what makes provider selection mean something: before
   * 26.11.2026 a `network:*` client was constructed with the default
   * localhost URL and this method was never called, so selecting a LAN server
   * dialled localhost — or, once the pool held two backends, whichever one
   * round-robin happened to pick.
   */
  setBaseURL(url: string): void {
    this.baseURL = url
    this.endpointPinned = true
  }

  /**
   * The URL this client dispatches to.
   *
   * Pinned: its own endpoint, always. Unpinned: this is the provider the
   * registry declares `residency: 'on-device'`, so the destination has to be
   * on this device. The pool is loopback-only by construction
   * (OllamaLoadBalancer.addBackend), and this check is the second half of that
   * guarantee — it holds for every way a URL can arrive here, including a
   * future caller that sets one some other way. A guard that only watches one
   * route is a guard against one spelling.
   *
   * Fail closed: a dispatch that would leave the device under an on-device
   * label is refused, not redirected. Silently substituting a different
   * destination is the behaviour this fix removes.
   */
  private getEffectiveBaseURL(): string {
    if (this.endpointPinned) return this.baseURL

    const balancer = getOllamaLoadBalancer()
    if (balancer.isBalancingAvailable()) {
      const url = balancer.getNextUrl()
      if (url) return assertOnDevice(url)
    }
    return assertOnDevice(this.baseURL)
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

  /**
   * Run a structured health check against the Ollama server.
   * Checks server version endpoint and loaded models via /api/tags.
   */
  async healthCheck(): Promise<ProviderHealthCheck> {
    const start = Date.now()
    const checks: HealthCheckItem[] = []
    let overallStatus: 'pass' | 'warn' | 'fail' = 'pass'
    const effectiveUrl = this.getEffectiveBaseURL()

    // 1. Check /api/version — is the server running?
    try {
      const versionRes = await fetch(`${effectiveUrl}/api/version`, { method: 'GET' })
      if (versionRes.ok) {
        const versionData = (await versionRes.json()) as { version?: string }
        checks.push({
          code: 'server_running',
          level: 'info',
          message: 'Ollama server is running',
          detail: versionData.version ? `Version ${versionData.version}` : null
        })
      } else {
        checks.push({
          code: 'server_error',
          level: 'error',
          message: `Ollama server returned HTTP ${versionRes.status}`,
          detail: versionRes.statusText
        })
        overallStatus = 'fail'
      }
    } catch (error) {
      checks.push({
        code: 'server_unreachable',
        level: 'error',
        message: 'Cannot connect to Ollama server',
        detail: error instanceof Error ? error.message : String(error)
      })
      return {
        provider: 'ollama',
        status: 'fail',
        checks,
        testedAt: new Date().toISOString(),
        latencyMs: Date.now() - start
      }
    }

    // 2. Check /api/tags — which models are loaded?
    try {
      const tagsRes = await fetch(`${effectiveUrl}/api/tags`, { method: 'GET' })
      if (tagsRes.ok) {
        const tagsData = (await tagsRes.json()) as OllamaTagsResponse
        const models = tagsData.models ?? []
        if (models.length > 0) {
          checks.push({
            code: 'models_loaded',
            level: 'info',
            message: `${models.length} model(s) available`,
            detail: models.map((m) => m.name).join(', ')
          })
        } else {
          checks.push({
            code: 'no_models',
            level: 'warn',
            message: 'No models installed — pull a model first',
            detail: 'Run: ollama pull <model-name>'
          })
          if (overallStatus === 'pass') overallStatus = 'warn'
        }
      } else {
        checks.push({
          code: 'tags_error',
          level: 'warn',
          message: 'Failed to list models',
          detail: `HTTP ${tagsRes.status}`
        })
        if (overallStatus === 'pass') overallStatus = 'warn'
      }
    } catch (error) {
      checks.push({
        code: 'tags_error',
        level: 'warn',
        message: 'Failed to query models endpoint',
        detail: error instanceof Error ? error.message : String(error)
      })
      if (overallStatus === 'pass') overallStatus = 'warn'
    }

    return {
      provider: 'ollama',
      status: overallStatus,
      checks,
      testedAt: new Date().toISOString(),
      latencyMs: Date.now() - start
    }
  }
}
