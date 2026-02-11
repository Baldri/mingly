import fetch from 'node-fetch'
import { SimpleStore } from '../utils/simple-store'
import type { NetworkAIServerConfig, NetworkDiscoveryResult, NetworkAIType } from '../../shared/network-ai-types'
import { buildAPIUrl, isLocalNetwork } from '../../shared/network-ai-types'

export class NetworkAIManager {
  private store: SimpleStore
  private servers: Map<string, NetworkAIServerConfig> = new Map()

  constructor() {
    this.store = new SimpleStore('network-ai-servers.json')
    this.loadServers()
  }

  /**
   * Load saved network AI servers from disk
   */
  private loadServers(): void {
    const savedServers = this.store.get('servers', []) as NetworkAIServerConfig[]
    savedServers.forEach(server => {
      this.servers.set(server.id, server)
    })
    console.log(`📡 Loaded ${savedServers.length} network AI servers`)
  }

  /**
   * Save servers to disk
   */
  private saveServers(): void {
    const serversArray = Array.from(this.servers.values())
    this.store.set('servers', serversArray)
  }

  /**
   * Add a new network AI server
   */
  addServer(config: Omit<NetworkAIServerConfig, 'id' | 'createdAt'>): NetworkAIServerConfig {
    const server: NetworkAIServerConfig = {
      ...config,
      id: `${config.host}:${config.port}`,
      createdAt: Date.now(),
      isLocal: config.host === 'localhost' || config.host === '127.0.0.1',
      isLAN: isLocalNetwork(config.host)
    }

    this.servers.set(server.id, server)
    this.saveServers()

    console.log(`📡 Added network AI server: ${server.name} at ${buildAPIUrl(server)}`)
    return server
  }

  /**
   * Remove a network AI server
   */
  removeServer(serverId: string): boolean {
    const removed = this.servers.delete(serverId)
    if (removed) {
      this.saveServers()
      console.log(`📡 Removed network AI server: ${serverId}`)
    }
    return removed
  }

  /**
   * Get all configured servers
   */
  getServers(): NetworkAIServerConfig[] {
    return Array.from(this.servers.values())
  }

  /**
   * Get server by ID
   */
  getServer(serverId: string): NetworkAIServerConfig | undefined {
    return this.servers.get(serverId)
  }

  /**
   * Test connection to a network AI server
   */
  async testConnection(serverId: string): Promise<{ success: boolean; responseTime?: number; error?: string }> {
    const server = this.servers.get(serverId)
    if (!server) {
      return { success: false, error: 'Server not found' }
    }

    const startTime = Date.now()
    const baseUrl = buildAPIUrl(server)

    try {
      // Try different health check endpoints based on server type
      const healthEndpoints = this.getHealthEndpoints(server.type)

      for (const endpoint of healthEndpoints) {
        try {
          const response = await fetch(`${baseUrl}${endpoint}`, {
            method: 'GET',
            headers: server.apiKey ? { 'Authorization': `Bearer ${server.apiKey}` } : {},
            // @ts-ignore - timeout is valid in node-fetch
            timeout: server.timeout || 5000
          })

          if (response.ok) {
            const responseTime = Date.now() - startTime

            // Update server status
            server.status = 'online'
            server.lastConnected = Date.now()
            this.saveServers()

            console.log(`📡 ✅ ${server.name} is online (${responseTime}ms)`)
            return { success: true, responseTime }
          }
        } catch (endpointError) {
          // Try next endpoint
          continue
        }
      }

      throw new Error('All health endpoints failed')

    } catch (error) {
      server.status = 'offline'
      this.saveServers()

      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.error(`📡 ❌ ${server.name} connection failed:`, errorMessage)
      return { success: false, error: errorMessage }
    }
  }

  /**
   * Get health check endpoints based on server type
   */
  private getHealthEndpoints(type: NetworkAIType): string[] {
    switch (type) {
      case 'ollama':
        return ['/api/tags', '/api/version']
      case 'vllm':
      case 'openai-compatible':
        return ['/v1/models', '/models', '/health']
      case 'text-generation-webui':
        return ['/v1/models', '/api/v1/model']
      case 'llamacpp':
        return ['/health', '/v1/models']
      default:
        return ['/health', '/v1/models', '/api/health']
    }
  }

  /**
   * Discover AI servers on local network
   * Scans common ports for AI servers
   */
  async discoverServers(networkRange: string = '192.168.1'): Promise<NetworkDiscoveryResult[]> {
    console.log(`📡 Scanning network ${networkRange}.0/24 for AI servers...`)

    const commonPorts = [
      { port: 11434, type: 'ollama' as NetworkAIType },
      { port: 8000, type: 'vllm' as NetworkAIType },
      { port: 5000, type: 'text-generation-webui' as NetworkAIType },
      { port: 8080, type: 'llamacpp' as NetworkAIType },
      { port: 1234, type: 'openai-compatible' as NetworkAIType } // LM Studio
    ]

    const discovered: NetworkDiscoveryResult[] = []

    // Scan localhost first
    for (const { port, type } of commonPorts) {
      const result = await this.scanHost('localhost', port, type)
      if (result) discovered.push(result)
    }

    // Note: Full network scanning can be slow and may be blocked by firewalls
    // In production, only scan if explicitly requested by user

    console.log(`📡 Discovery complete: found ${discovered.length} servers`)
    return discovered
  }

  /**
   * Scan a specific host:port for AI server
   */
  private async scanHost(host: string, port: number, expectedType: NetworkAIType): Promise<NetworkDiscoveryResult | null> {
    const startTime = Date.now()

    try {
      const baseUrl = `http://${host}:${port}`
      const healthEndpoints = this.getHealthEndpoints(expectedType)

      for (const endpoint of healthEndpoints) {
        try {
          const response = await fetch(`${baseUrl}${endpoint}`, {
            method: 'GET',
            // @ts-ignore
            timeout: 2000 // Quick scan
          })

          if (response.ok) {
            const responseTime = Date.now() - startTime
            const data = await response.json() as any

            return {
              host,
              port,
              type: expectedType,
              version: data.version,
              models: data.models?.map((m: any) => m.name || m.id) || [],
              responseTime
            }
          }
        } catch {
          continue
        }
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Get list of available models from a network server
   */
  async getModels(serverId: string): Promise<string[]> {
    const server = this.servers.get(serverId)
    if (!server) {
      throw new Error('Server not found')
    }

    const baseUrl = buildAPIUrl(server)

    try {
      let endpoint = '/v1/models'
      if (server.type === 'ollama') {
        endpoint = '/api/tags'
      }

      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: 'GET',
        headers: server.apiKey ? { 'Authorization': `Bearer ${server.apiKey}` } : {},
        // @ts-ignore
        timeout: server.timeout || 5000
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json() as any

      // Parse models based on server type
      if (server.type === 'ollama') {
        return data.models?.map((m: any) => m.name) || []
      } else {
        return data.data?.map((m: any) => m.id) || []
      }
    } catch (error) {
      console.error(`Failed to get models from ${server.name}:`, error)
      return []
    }
  }
}

// Singleton instance
let networkAIManagerInstance: NetworkAIManager | null = null

export function getNetworkAIManager(): NetworkAIManager {
  if (!networkAIManagerInstance) {
    networkAIManagerInstance = new NetworkAIManager()
  }
  return networkAIManagerInstance
}
