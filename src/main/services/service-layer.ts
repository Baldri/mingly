/**
 * Mingly Service Layer
 *
 * Extracts core business logic from IPC handlers into a transport-agnostic
 * layer. Used by both Electron IPC (standalone/hybrid) and the HTTP/WS API
 * server (server mode).
 *
 * This does NOT replace ipc-handlers.ts — it wraps the same singleton
 * managers so both transports share one set of state.
 */

import { getClientManager } from '../llm-clients/client-manager'
import { getNetworkAIManager } from '../network/network-ai-manager'
import { getRouter } from '../routing/intelligent-router'
import { getSystemPromptManager } from '../prompts/system-prompt-manager'
import { getCommandHandler } from '../commands/command-handler'
import { getContextInjector } from '../rag/context-injector'
import { getTrackingEngine } from '../tracking/tracking-engine'
import { ConversationModel } from '../database/models/conversation'
import { MessageModel } from '../database/models/message'
import { generateId } from '../utils/id-generator'
import type { Message, LLMProvider } from '../../shared/types'
import type { StreamChunk } from '../llm-clients/base-client'

// ── Types ───────────────────────────────────────────────────────

export interface ChatRequest {
  conversationId: string
  messages: Message[]
  provider: string
  model: string
  temperature?: number
}

export interface ChatStreamEvent {
  type: 'chunk' | 'complete' | 'error'
  content?: string
  metadata?: ChatResponseMetadata
  error?: string
}

export interface ChatResponseMetadata {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost: number
  latencyMs: number
  ragSources?: Array<{ filename: string; score: number }>
}

export interface ChatResponse {
  success: boolean
  response?: string
  metadata?: ChatResponseMetadata
  ragSources?: Array<{ filename: string; score: number }>
  error?: string
}

export interface ProviderInfo {
  id: string
  available: boolean
  models: string[]
}

// ── Service Layer ───────────────────────────────────────────────

export class ServiceLayer {
  private clientManager = getClientManager()
  private networkAIManager = getNetworkAIManager()
  private router = getRouter()
  private systemPromptManager = getSystemPromptManager()
  private commandHandler = getCommandHandler()
  private contextInjector = getContextInjector()
  private trackingEngine = getTrackingEngine()

  /**
   * Send a chat message with streaming via callback.
   * This is the core chat pipeline used by both IPC and HTTP/WS transports.
   */
  async sendMessageStreaming(
    request: ChatRequest,
    onEvent: (event: ChatStreamEvent) => void
  ): Promise<ChatResponse> {
    const { conversationId, messages, provider, model, temperature = 1.0 } = request

    try {
      const userMessage = messages[messages.length - 1].content

      // 1. Check for commands
      const commandResult = await this.commandHandler.handleCommand(userMessage)
      if (commandResult.handled && commandResult.response) {
        onEvent({ type: 'complete' })
        return { success: true, response: commandResult.response }
      }

      // 2. Extract actual message (if mode modifier was used)
      const actualMessage = this.commandHandler.extractMessage(userMessage, commandResult)
      const mode = this.commandHandler.getMode(commandResult)

      // 3. Build system prompt with mode
      let systemPrompt = await this.systemPromptManager.buildSystemPrompt({
        customMode: mode
      })

      // 3b. Auto-inject RAG context if enabled
      let ragSources: Array<{ filename: string; score: number }> = []
      try {
        const ragResult = await this.contextInjector.getContext(actualMessage)
        if (ragResult.context) {
          systemPrompt = this.contextInjector.buildAugmentedPrompt(systemPrompt, ragResult.context)
          ragSources = ragResult.sources
        }
      } catch {
        // RAG injection failure is non-blocking
      }

      // 4. Prepend system prompt to messages
      const messagesWithSystem: Message[] = [
        { id: generateId(), role: 'system', content: systemPrompt },
        ...messages.slice(0, -1),
        { id: generateId(), role: 'user', content: actualMessage }
      ]

      // 5. Stream the response
      const startTime = Date.now()
      const stream = await this.clientManager.sendMessage(provider, messagesWithSystem, model, temperature)

      let fullResponse = ''
      for await (const chunk of stream) {
        if (!chunk.done) {
          fullResponse += chunk.content
          onEvent({ type: 'chunk', content: chunk.content })
        }
      }

      const latencyMs = Date.now() - startTime

      // 6. Persist to database
      try {
        MessageModel.create(conversationId, 'assistant', fullResponse)
        ConversationModel.updateTimestamp(conversationId)
      } catch {
        // DB failure is non-blocking
      }

      // 7. Track usage
      const inputText = messagesWithSystem.map(m => m.content).join('\n')
      const inputTokens = this.trackingEngine.estimateTokens(inputText)
      const outputTokens = this.trackingEngine.estimateTokens(fullResponse)
      const { totalCost } = this.trackingEngine.calculateCost(model, inputTokens, outputTokens)

      try {
        this.trackingEngine.recordEvent({
          conversationId,
          provider,
          model,
          inputText,
          outputText: fullResponse,
          latencyMs,
          ragUsed: ragSources.length > 0,
          ragSourceCount: ragSources.length,
          success: true,
          inputTokens,
          outputTokens
        })
      } catch {
        // Tracking failure is non-blocking
      }

      const metadata: ChatResponseMetadata = {
        provider,
        model,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cost: totalCost,
        latencyMs,
        ragSources: ragSources.length > 0 ? ragSources : undefined
      }

      onEvent({ type: 'complete', metadata })

      return {
        success: true,
        response: fullResponse,
        metadata,
        ragSources: ragSources.length > 0 ? ragSources : undefined
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      // Track failure
      try {
        this.trackingEngine.recordEvent({
          conversationId,
          provider,
          model,
          inputText: '',
          outputText: '',
          latencyMs: 0,
          ragUsed: false,
          ragSourceCount: 0,
          success: false,
          errorMessage
        })
      } catch { /* ignore */ }

      onEvent({ type: 'error', error: errorMessage })
      return { success: false, error: errorMessage }
    }
  }

  /**
   * Non-streaming chat (for REST API without WebSocket)
   */
  async sendMessage(request: ChatRequest): Promise<ChatResponse> {
    let result: ChatResponse = { success: false }

    await this.sendMessageStreaming(request, (event) => {
      if (event.type === 'complete') {
        // metadata is set via the return value
      }
    })

    // The return value from sendMessageStreaming already has the full response
    return result
  }

  /**
   * Get available providers and their models
   */
  getProviders(): ProviderInfo[] {
    const providers = this.clientManager.getAllProviders()
    return providers.map(id => ({
      id,
      available: this.clientManager.hasApiKey(id),
      models: this.clientManager.getModels(id)
    }))
  }

  /**
   * Get network AI servers
   */
  getNetworkServers() {
    return this.networkAIManager.getServers()
  }

  /**
   * Test connection to a network AI server
   */
  async testNetworkServer(serverId: string) {
    return this.networkAIManager.testConnection(serverId)
  }

  /**
   * Get routing suggestion for a message
   */
  async getRoutingSuggestion(message: string, currentProvider: string) {
    const availableProviders = this.clientManager.getProvidersWithApiKeys()
    return this.router.getSuggestion(message, currentProvider, availableProviders)
  }

  /**
   * Validate an API key for a provider
   */
  async validateApiKey(provider: string): Promise<boolean> {
    return this.clientManager.validateApiKey(provider)
  }

  /**
   * Get conversations list
   */
  getConversations() {
    return ConversationModel.findAll()
  }

  /**
   * Get a single conversation with messages
   */
  getConversation(id: string) {
    return ConversationModel.findById(id)
  }

  /**
   * Create a new conversation
   */
  createConversation(title: string, provider: string, model: string) {
    return ConversationModel.create(title, provider as LLMProvider, model)
  }

  /**
   * Delete a conversation
   */
  deleteConversation(id: string) {
    return ConversationModel.delete(id)
  }
}

// ── Singleton ───────────────────────────────────────────────────

let serviceLayerInstance: ServiceLayer | null = null

export function getServiceLayer(): ServiceLayer {
  if (!serviceLayerInstance) {
    serviceLayerInstance = new ServiceLayer()
  }
  return serviceLayerInstance
}
