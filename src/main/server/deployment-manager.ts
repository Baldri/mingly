/**
 * Deployment Manager
 *
 * Orchestrates the three deployment modes:
 * - STANDALONE: Default Electron app, no server.
 * - SERVER:     Starts the Mingly API Server alongside the Electron UI.
 * - HYBRID:     Connects to remote Mingly Servers for additional LLMs.
 *
 * Persists deployment config to disk via SimpleStore.
 */

import { SimpleStore } from '../utils/simple-store'
import { MinglyAPIServer, getMinglyAPIServer, getExistingAPIServer } from './mingly-api-server'
import { getMinglyServerClient, MinglyServerClient } from './mingly-server-client'
import type {
  DeploymentConfig,
  DeploymentMode,
  MinglyServerConfig,
  HybridClientConfig,
  MinglyRemoteServer
} from '../../shared/deployment-types'
import { DEFAULT_DEPLOYMENT_CONFIG, DEFAULT_SERVER_CONFIG, DEFAULT_HYBRID_CONFIG } from '../../shared/deployment-types'

export interface DeploymentStatus {
  mode: DeploymentMode
  server: {
    running: boolean
    port?: number
    host?: string
    activeSessions?: number
  }
  hybrid: {
    connectedServers: number
    totalServers: number
    servers: Array<{
      id: string
      name: string
      status: string
      latencyMs?: number
      models?: string[]
    }>
  }
}

export class DeploymentManager {
  private store: SimpleStore
  private config: DeploymentConfig
  private apiServer: MinglyAPIServer | null = null
  private serverClient: MinglyServerClient

  constructor() {
    this.store = new SimpleStore('deployment-config.json')
    this.config = this.loadConfig()
    this.serverClient = getMinglyServerClient()
  }

  /**
   * Load deployment config from disk
   */
  private loadConfig(): DeploymentConfig {
    const saved = this.store.get('config', null) as DeploymentConfig | null
    if (saved) {
      return {
        mode: saved.mode || DEFAULT_DEPLOYMENT_CONFIG.mode,
        server: { ...DEFAULT_SERVER_CONFIG, ...saved.server },
        hybrid: { ...DEFAULT_HYBRID_CONFIG, ...saved.hybrid }
      }
    }
    return { ...DEFAULT_DEPLOYMENT_CONFIG }
  }

  /**
   * Save deployment config to disk
   */
  private saveConfig(): void {
    this.store.set('config', this.config)
  }

  /**
   * Get current deployment config
   */
  getConfig(): DeploymentConfig {
    return { ...this.config }
  }

  /**
   * Update deployment config
   */
  updateConfig(partial: Partial<DeploymentConfig>): DeploymentConfig {
    if (partial.mode !== undefined) {
      this.config.mode = partial.mode
    }
    if (partial.server) {
      this.config.server = { ...this.config.server, ...partial.server }
    }
    if (partial.hybrid) {
      this.config.hybrid = { ...this.config.hybrid, ...partial.hybrid }
    }
    this.saveConfig()
    return this.getConfig()
  }

  /**
   * Get current deployment status
   */
  getStatus(): DeploymentStatus {
    const existingServer = getExistingAPIServer()
    const remoteServers = this.serverClient.getServers()

    return {
      mode: this.config.mode,
      server: {
        running: existingServer !== null,
        port: existingServer ? this.config.server.port : undefined,
        host: existingServer ? this.config.server.host : undefined
      },
      hybrid: {
        connectedServers: remoteServers.filter(s => s.status === 'online').length,
        totalServers: remoteServers.length,
        servers: remoteServers.map(s => ({
          id: s.id,
          name: s.name,
          status: s.status,
          latencyMs: s.latencyMs,
          models: s.availableModels
        }))
      }
    }
  }

  // ── Server Mode ───────────────────────────────────────────────

  /**
   * Start the API server (SERVER mode)
   */
  async startServer(configOverride?: Partial<MinglyServerConfig>): Promise<{ success: boolean; error?: string }> {
    if (getExistingAPIServer()) {
      return { success: false, error: 'Server is already running' }
    }

    const serverConfig = { ...this.config.server, ...configOverride }

    try {
      this.apiServer = getMinglyAPIServer(serverConfig)
      await this.apiServer.start()

      // Update mode to server
      this.config.mode = 'server'
      this.saveConfig()

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start server'
      return { success: false, error: message }
    }
  }

  /**
   * Stop the API server
   */
  async stopServer(): Promise<{ success: boolean; error?: string }> {
    const server = getExistingAPIServer()
    if (!server) {
      return { success: false, error: 'Server is not running' }
    }

    try {
      await server.stop()
      this.apiServer = null

      // Switch back to standalone if was in server mode
      if (this.config.mode === 'server') {
        this.config.mode = 'standalone'
        this.saveConfig()
      }

      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to stop server'
      return { success: false, error: message }
    }
  }

  // ── Hybrid Mode ───────────────────────────────────────────────

  /**
   * Add a remote Mingly Server
   */
  addRemoteServer(server: Omit<MinglyRemoteServer, 'status'>): MinglyRemoteServer {
    const result = this.serverClient.addServer(server)

    // Persist to config
    this.config.hybrid.remoteServers = this.serverClient.getServers()
    this.saveConfig()

    return result
  }

  /**
   * Remove a remote server
   */
  removeRemoteServer(serverId: string): boolean {
    const result = this.serverClient.removeServer(serverId)

    this.config.hybrid.remoteServers = this.serverClient.getServers()
    this.saveConfig()

    return result
  }

  /**
   * Get all remote servers
   */
  getRemoteServers(): MinglyRemoteServer[] {
    return this.serverClient.getServers()
  }

  /**
   * Check health of a remote server
   */
  async checkRemoteServer(serverId: string) {
    const health = await this.serverClient.checkHealth(serverId)
    const info = await this.serverClient.getServerInfo(serverId)

    return {
      health,
      info,
      server: this.serverClient.getServer(serverId)
    }
  }

  /**
   * Discover Mingly Servers on the network
   */
  async discoverServers(networkRange?: string) {
    return this.serverClient.discoverServers(networkRange)
  }

  /**
   * Get the server client (for hybrid mode LLM routing)
   */
  getServerClient(): MinglyServerClient {
    return this.serverClient
  }

  /**
   * Initialize based on saved config (call on app startup)
   */
  async initialize(): Promise<void> {
    console.log(`📦 Deployment mode: ${this.config.mode}`)

    // Restore remote servers from config
    if (this.config.hybrid.remoteServers.length > 0) {
      for (const server of this.config.hybrid.remoteServers) {
        this.serverClient.addServer(server)
      }
      console.log(`📡 Restored ${this.config.hybrid.remoteServers.length} remote server(s)`)
    }

    // Auto-start server if configured as server mode
    if (this.config.mode === 'server') {
      console.log('🚀 Auto-starting API server (server mode configured)...')
      const result = await this.startServer()
      if (!result.success) {
        console.error('Failed to auto-start server:', result.error)
      }
    }

    // Auto-check remote servers if in hybrid mode
    if (this.config.mode === 'hybrid') {
      const servers = this.serverClient.getServers()
      for (const server of servers) {
        this.serverClient.checkHealth(server.id).catch(() => {
          // Non-blocking health check on startup
        })
      }
    }
  }

  /**
   * Shutdown everything
   */
  async shutdown(): Promise<void> {
    await this.stopServer()
    this.serverClient.shutdown()
  }
}

// ── Singleton ───────────────────────────────────────────────────

let deploymentManagerInstance: DeploymentManager | null = null

export function getDeploymentManager(): DeploymentManager {
  if (!deploymentManagerInstance) {
    deploymentManagerInstance = new DeploymentManager()
  }
  return deploymentManagerInstance
}
