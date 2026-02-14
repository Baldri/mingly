/**
 * DocMind Integration
 *
 * Provides two connection paths to the DocMind knowledge base:
 *
 * 1. **MCP (stdio)** — Spawns the DocMind MCP server as a child process.
 *    This gives access to all 11 tools (search, chat, hybrid_search, agentic_chat, etc.)
 *    and integrates with the MCP auto-tool-selection in SEND_MESSAGE.
 *
 * 2. **REST API** — Connects to the DocMind FastAPI server (port 8000).
 *    Used for RAG context injection via the ContextInjector fallback chain.
 *
 * Both paths can be active simultaneously — MCP for tool-use, REST for context injection.
 */

import { getMCPClientManager } from '../mcp/mcp-client-manager'
import { getRAGWissenClient } from '../rag/rag-wissen-client'
import { getContextInjector } from '../rag/context-injector'
import { SimpleStore } from '../utils/simple-store'
import * as fs from 'fs'

export interface DocMindConfig {
  /** Enable DocMind integration */
  enabled: boolean
  /** Path to the DocMind project root (rag-wissen) */
  projectPath: string
  /** Python executable (python3 or full path) */
  pythonPath: string

  /** MCP stdio connection */
  mcp: {
    enabled: boolean
    /** Auto-connect on app start */
    autoConnect: boolean
  }

  /** REST API connection */
  rest: {
    enabled: boolean
    host: string
    port: number
    /** API key for authenticated access */
    apiKey?: string
  }

  /** RAG context injection settings */
  contextInjection: {
    /** Enable DocMind as a context source in the ContextInjector */
    enabled: boolean
    /** Default collection to search */
    collection: string
  }
}

const DEFAULT_CONFIG: DocMindConfig = {
  enabled: true,
  projectPath: process.env.DOCMIND_PROJECT_PATH || '',
  pythonPath: process.env.DOCMIND_PYTHON_PATH || 'python3',

  mcp: {
    enabled: true,
    autoConnect: true
  },

  rest: {
    enabled: true,
    host: 'localhost',
    port: 8000
  },

  contextInjection: {
    enabled: true,
    collection: 'rag_documents'
  }
}

const store = SimpleStore.create()

export class DocMindIntegration {
  private config: DocMindConfig
  private mcpServerId: string | null = null

  constructor() {
    const saved = store.get('docmind_config') as Partial<DocMindConfig> | undefined
    this.config = this.mergeConfig(DEFAULT_CONFIG, saved)
  }

  private mergeConfig(base: DocMindConfig, override?: Partial<DocMindConfig>): DocMindConfig {
    if (!override) return { ...base }
    return {
      ...base,
      ...override,
      mcp: { ...base.mcp, ...(override.mcp || {}) },
      rest: { ...base.rest, ...(override.rest || {}) },
      contextInjection: { ...base.contextInjection, ...(override.contextInjection || {}) }
    }
  }

  getConfig(): DocMindConfig {
    return JSON.parse(JSON.stringify(this.config))
  }

  updateConfig(updates: Partial<DocMindConfig>): void {
    this.config = this.mergeConfig(this.config, updates)
    store.set('docmind_config', this.config)
  }

  // ── MCP Connection ──────────────────────────────────────────

  /**
   * Connect to DocMind via MCP (stdio).
   * Spawns python3 src/mcp_server.py as a child process.
   */
  async connectMCP(): Promise<{ success: boolean; tools?: number; error?: string }> {
    if (!this.config.enabled || !this.config.mcp.enabled) {
      return { success: false, error: 'DocMind MCP integration is disabled' }
    }

    const mcpServerPath = `${this.config.projectPath}/src/mcp_server.py`
    if (!fs.existsSync(mcpServerPath)) {
      return { success: false, error: `MCP server not found at: ${mcpServerPath}` }
    }

    const mcpManager = getMCPClientManager()

    // Remove existing DocMind server if re-connecting
    if (this.mcpServerId) {
      await mcpManager.removeServer(this.mcpServerId)
      this.mcpServerId = null
    }

    // Add and connect DocMind MCP server
    const server = mcpManager.addServer({
      name: 'DocMind',
      command: this.config.pythonPath,
      args: [mcpServerPath],
      env: {
        PYTHONPATH: this.config.projectPath,
        ...(this.config.rest.apiKey ? { DOCMIND_API_KEY: this.config.rest.apiKey } : {})
      }
    })

    this.mcpServerId = server.id

    const result = await mcpManager.connect(server.id)

    if (result.success) {
      const tools = mcpManager.listTools(server.id)
      console.log(`✅ DocMind MCP connected (${tools.length} tools available)`)
      return { success: true, tools: tools.length }
    }

    return { success: false, error: result.error }
  }

  /**
   * Disconnect DocMind MCP server.
   */
  async disconnectMCP(): Promise<{ success: boolean }> {
    if (!this.mcpServerId) return { success: true }

    const mcpManager = getMCPClientManager()
    await mcpManager.disconnect(this.mcpServerId)
    this.mcpServerId = null
    console.log('DocMind MCP disconnected')
    return { success: true }
  }

  /**
   * Check if DocMind MCP is connected and list available tools.
   */
  getMCPStatus(): { connected: boolean; serverId: string | null; tools: string[] } {
    if (!this.mcpServerId) {
      return { connected: false, serverId: null, tools: [] }
    }

    const mcpManager = getMCPClientManager()
    const tools = mcpManager.listTools(this.mcpServerId)

    return {
      connected: tools.length > 0,
      serverId: this.mcpServerId,
      tools: tools.map(t => t.toolName)
    }
  }

  // ── REST API Connection ─────────────────────────────────────

  /**
   * Configure the RAG-Wissen client to connect to DocMind's REST API.
   */
  configureRESTClient(): void {
    if (!this.config.enabled || !this.config.rest.enabled) return

    const wissenClient = getRAGWissenClient()
    wissenClient.updateConfig({
      host: this.config.rest.host,
      port: this.config.rest.port,
      protocol: 'http',
      enabled: true,
      defaultCollection: this.config.contextInjection.collection,
      apiMode: 'rest'
    })

    console.log(`✅ DocMind REST client configured (${this.config.rest.host}:${this.config.rest.port})`)
  }

  /**
   * Check if the DocMind REST API is reachable.
   */
  async checkRESTHealth(): Promise<{ available: boolean; data?: any; error?: string }> {
    try {
      const url = `http://${this.config.rest.host}:${this.config.rest.port}/health`
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) })

      if (!response.ok) {
        return { available: false, error: `HTTP ${response.status}` }
      }

      const data = await response.json()
      return { available: true, data }
    } catch (error) {
      return { available: false, error: (error as Error).message }
    }
  }

  // ── Context Injection ────────────────────────────────────────

  /**
   * Enable DocMind as a context source in the ContextInjector.
   * This enables RAG-Wissen in the context injection fallback chain.
   */
  enableContextInjection(): void {
    if (!this.config.contextInjection.enabled) return

    const injector = getContextInjector()
    injector.updateConfig({
      ragWissenEnabled: true,
      ragWissenCollection: this.config.contextInjection.collection
    })

    console.log(`✅ DocMind context injection enabled (collection: ${this.config.contextInjection.collection})`)
  }

  // ── Full Setup ───────────────────────────────────────────────

  /**
   * Initialize the complete DocMind integration:
   * 1. Configure REST client
   * 2. Enable context injection
   * 3. Connect MCP server (if autoConnect)
   */
  async initialize(): Promise<{
    rest: { available: boolean; error?: string }
    mcp: { connected: boolean; tools?: number; error?: string }
    contextInjection: boolean
  }> {
    const result = {
      rest: { available: false } as { available: boolean; error?: string },
      mcp: { connected: false } as { connected: boolean; tools?: number; error?: string },
      contextInjection: false
    }

    if (!this.config.enabled) {
      return result
    }

    // 1. REST API
    if (this.config.rest.enabled) {
      this.configureRESTClient()
      const health = await this.checkRESTHealth()
      result.rest = health
    }

    // 2. Context Injection
    if (this.config.contextInjection.enabled) {
      this.enableContextInjection()
      result.contextInjection = true
    }

    // 3. MCP
    if (this.config.mcp.enabled && this.config.mcp.autoConnect) {
      const mcpResult = await this.connectMCP()
      result.mcp = { connected: mcpResult.success, tools: mcpResult.tools, error: mcpResult.error }
    }

    console.log(`✅ DocMind integration initialized`, result)
    return result
  }

  /**
   * Get a comprehensive status of the DocMind integration.
   */
  async getStatus(): Promise<{
    config: DocMindConfig
    mcp: { connected: boolean; tools: string[] }
    rest: { available: boolean; error?: string }
    contextInjection: { enabled: boolean }
  }> {
    const mcpStatus = this.getMCPStatus()
    const restHealth = this.config.rest.enabled ? await this.checkRESTHealth() : { available: false }
    const injector = getContextInjector()

    return {
      config: this.getConfig(),
      mcp: { connected: mcpStatus.connected, tools: mcpStatus.tools },
      rest: { available: restHealth.available, error: restHealth.error },
      contextInjection: { enabled: injector.getConfig().ragWissenEnabled }
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────

let instance: DocMindIntegration | null = null

export function getDocMindIntegration(): DocMindIntegration {
  if (!instance) {
    instance = new DocMindIntegration()
  }
  return instance
}
