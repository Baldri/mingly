/**
 * Local AI Bridge
 *
 * Bridges NetworkAIManager (server discovery/management) with
 * LLMClientManager (message sending). When a network AI server is
 * verified online, this bridge registers it as a usable provider so
 * the chat pipeline can send messages to it.
 *
 * This solves the gap where NetworkAIManager could discover servers
 * but they weren't available as selectable providers in the chat UI.
 */

import { getNetworkAIManager, NetworkAIManager } from './network-ai-manager'
import { getClientManager, LLMClientManager } from '../llm-clients/client-manager'
import { GenericOpenAIClient } from '../llm-clients/generic-openai-client'
import { OllamaClient } from '../llm-clients/ollama-client'
import { getOllamaLoadBalancer } from './ollama-load-balancer'
import { buildAPIUrl } from '../../shared/network-ai-types'
import type { NetworkAIServerConfig } from '../../shared/network-ai-types'

export interface LocalAIProvider {
  /** Provider ID (matches NetworkAIServerConfig.id) */
  id: string
  /** Display name */
  name: string
  /** Server type */
  type: string
  /** Available models (fetched dynamically) */
  models: string[]
  /** Connection status */
  status: 'online' | 'offline' | 'unknown'
  /** Last refreshed */
  lastRefreshed?: number
}

export class LocalAIBridge {
  private networkManager: NetworkAIManager
  private clientManager: LLMClientManager
  private registeredProviders: Map<string, LocalAIProvider> = new Map()
  private refreshInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.networkManager = getNetworkAIManager()
    this.clientManager = getClientManager()
  }

  /**
   * Initialize the bridge: register all known online servers as providers.
   */
  async initialize(): Promise<void> {
    const servers = this.networkManager.getServers()

    for (const server of servers) {
      await this.registerServer(server)
    }

    console.log(`🔗 Local AI Bridge: registered ${this.registeredProviders.size} provider(s)`)

    // Start load balancer health checks if we have Ollama backends
    const loadBalancer = getOllamaLoadBalancer()
    if (loadBalancer.getBackends().length > 0) {
      loadBalancer.startHealthChecks()
      const stats = loadBalancer.getStats()
      console.log(`⚖️ Load Balancer: ${stats.totalBackends} Ollama backend(s), ${stats.healthyBackends} healthy`)
    }

    // Start periodic refresh (every 60 seconds)
    this.refreshInterval = setInterval(() => this.refreshAll(), 60_000)
  }

  /**
   * Register a network AI server as a chat provider
   */
  async registerServer(server: NetworkAIServerConfig): Promise<LocalAIProvider | null> {
    const providerId = `network:${server.id}`

    // Build API URL
    const apiUrl = buildAPIUrl(server)

    // Register the appropriate client type
    if (server.type === 'ollama') {
      // Ollama has its own client
      this.clientManager.registerCustomProvider({
        id: providerId,
        name: server.name,
        type: 'ollama',
        apiBase: apiUrl,
        apiKeyRequired: false,
        supportsStreaming: true,
        models: []
      })

      // Register with load balancer for multi-backend routing
      getOllamaLoadBalancer().addBackend(server)
    } else {
      // All other types use OpenAI-compatible client
      const apiBase = server.type === 'vllm' || server.type === 'openai-compatible'
        ? `${apiUrl}/v1`
        : apiUrl

      this.clientManager.registerCustomProvider({
        id: providerId,
        name: server.name,
        type: 'custom',
        apiBase,
        apiKeyRequired: server.apiKeyRequired,
        supportsStreaming: true,
        models: []
      })

      // Set API key if provided
      if (server.apiKey) {
        this.clientManager.setApiKey(providerId, server.apiKey)
      }
    }

    // Fetch available models
    let models: string[] = []
    try {
      models = await this.networkManager.getModels(server.id)
    } catch {
      // Model fetch failure is non-blocking
    }

    const provider: LocalAIProvider = {
      id: providerId,
      name: server.name,
      type: server.type,
      models,
      status: server.status || 'unknown',
      lastRefreshed: Date.now()
    }

    this.registeredProviders.set(providerId, provider)
    return provider
  }

  /**
   * Unregister a server from the client manager
   */
  unregisterServer(serverId: string): void {
    const providerId = `network:${serverId}`
    this.registeredProviders.delete(providerId)

    // Remove from load balancer pool
    getOllamaLoadBalancer().removeBackend(serverId)

    // Note: LLMClientManager doesn't have a removeProvider method,
    // but the provider will be unavailable since it has no API key
  }

  /**
   * Get all registered local AI providers
   */
  getProviders(): LocalAIProvider[] {
    return Array.from(this.registeredProviders.values())
  }

  /**
   * Get a specific provider
   */
  getProvider(providerId: string): LocalAIProvider | undefined {
    return this.registeredProviders.get(providerId)
  }

  /**
   * Refresh models and status for all registered providers
   */
  async refreshAll(): Promise<void> {
    const servers = this.networkManager.getServers()

    for (const server of servers) {
      const providerId = `network:${server.id}`
      const provider = this.registeredProviders.get(providerId)

      if (!provider) {
        // New server found, register it
        await this.registerServer(server)
        continue
      }

      // Refresh status
      try {
        const result = await this.networkManager.testConnection(server.id)
        provider.status = result.success ? 'online' : 'offline'

        if (result.success) {
          // Refresh models
          provider.models = await this.networkManager.getModels(server.id)

          // Ensure Ollama backends are in the load balancer pool
          if (server.type === 'ollama') {
            getOllamaLoadBalancer().addBackend(server)
          }
        }

        provider.lastRefreshed = Date.now()
      } catch {
        provider.status = 'offline'
      }
    }
  }

  /**
   * Auto-discover and register local AI servers
   */
  async autoDiscover(): Promise<LocalAIProvider[]> {
    const discovered = await this.networkManager.discoverServers()
    const newProviders: LocalAIProvider[] = []

    for (const result of discovered) {
      const serverId = `${result.host}:${result.port}`

      // Check if already known
      if (this.networkManager.getServer(serverId)) continue

      // Add to network manager
      const server = this.networkManager.addServer({
        name: `${result.type} (${result.host})`,
        type: result.type,
        protocol: 'http',
        host: result.host,
        port: result.port,
        apiKeyRequired: false,
        isLocal: result.host === 'localhost' || result.host === '127.0.0.1',
        isLAN: true,
        tlsVerify: false,
        allowSelfSigned: true
      })

      // Register as provider
      const provider = await this.registerServer(server)
      if (provider) newProviders.push(provider)
    }

    return newProviders
  }

  /**
   * Shutdown the bridge
   */
  shutdown(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval)
      this.refreshInterval = null
    }

    // Stop load balancer health checks and clear backends
    getOllamaLoadBalancer().shutdown()
  }
}

// ── Singleton ───────────────────────────────────────────────────

let bridgeInstance: LocalAIBridge | null = null

export function getLocalAIBridge(): LocalAIBridge {
  if (!bridgeInstance) {
    bridgeInstance = new LocalAIBridge()
  }
  return bridgeInstance
}
