/**
 * MCP Client Manager
 * Manages connections to MCP (Model Context Protocol) servers.
 * Communicates via JSON-RPC 2.0 over stdio (spawned subprocess).
 */

import { ChildProcess, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { generateId } from '../utils/id-generator'
import { validateMCPConfig } from '../utils/mcp-sanitizer'
import type { MCPServer, MCPTool, MCPToolResult } from '../../shared/types'
import readline from 'readline'

interface PendingRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface MCPServerEntry {
  config: MCPServer
  process: ChildProcess | null
  tools: MCPTool[]
  pendingRequests: Map<string | number, PendingRequest>
}

const REQUEST_TIMEOUT_MS = 30000

export class MCPClientManager extends EventEmitter {
  private servers: Map<string, MCPServerEntry> = new Map()
  private requestCounter = 0

  /**
   * Add an MCP server configuration (does not connect yet).
   */
  addServer(config: Omit<MCPServer, 'id' | 'connected'>): MCPServer {
    // Validate command, args, and env before accepting the config
    const validation = validateMCPConfig({
      command: config.command,
      args: config.args,
      env: config.env
    })
    if (!validation.valid) {
      throw new Error(`MCP config rejected: ${validation.error}`)
    }

    const server: MCPServer = {
      ...config,
      id: generateId(),
      connected: false
    }

    this.servers.set(server.id, {
      config: server,
      process: null,
      tools: [],
      pendingRequests: new Map()
    })

    return server
  }

  /**
   * Remove an MCP server (disconnects if connected).
   */
  async removeServer(serverId: string): Promise<boolean> {
    const entry = this.servers.get(serverId)
    if (!entry) return false

    await this.disconnect(serverId)
    this.servers.delete(serverId)
    return true
  }

  /**
   * List all configured servers.
   */
  listServers(): MCPServer[] {
    return Array.from(this.servers.values()).map((entry) => entry.config)
  }

  /**
   * Connect to an MCP server by spawning its process.
   */
  async connect(serverId: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.servers.get(serverId)
    if (!entry) return { success: false, error: 'Server not found' }

    if (entry.config.connected && entry.process) {
      return { success: true } // Already connected
    }

    try {
      const { command, args = [], env = {} } = entry.config

      // Re-validate before spawning (defense-in-depth)
      const validation = validateMCPConfig({ command, args, env })
      if (!validation.valid) {
        return { success: false, error: `Security check failed: ${validation.error}` }
      }

      // Spawn the MCP server process
      const proc = spawn(command, args, {
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe']
      })

      entry.process = proc

      // Read stdout line by line for JSON-RPC responses
      const rl = readline.createInterface({ input: proc.stdout! })
      rl.on('line', (line) => {
        this.handleServerResponse(serverId, line)
      })

      // Log stderr (server logs go here)
      proc.stderr?.on('data', (data) => {
        console.log(`[MCP:${entry.config.name}] ${data.toString().trim()}`)
      })

      proc.on('error', (err) => {
        console.error(`MCP process error (${entry.config.name}):`, err.message)
        entry.config.connected = false
        this.emit('server-disconnected', serverId)
      })

      proc.on('close', (code) => {
        console.log(`MCP process closed (${entry.config.name}): code ${code}`)
        entry.config.connected = false
        entry.process = null

        // Reject all pending requests
        for (const [, pending] of entry.pendingRequests) {
          clearTimeout(pending.timeout)
          pending.reject(new Error('MCP server process closed'))
        }
        entry.pendingRequests.clear()

        this.emit('server-disconnected', serverId)
      })

      // Initialize the MCP session
      const initResult = await this.sendRequest(serverId, 'initialize', {
        protocolVersion: '0.1.0',
        clientInfo: { name: 'mingly', version: '1.0.0' },
        capabilities: {}
      })

      if (!initResult) {
        throw new Error('Initialize request failed')
      }

      entry.config.connected = true

      // Fetch available tools
      await this.refreshTools(serverId)

      console.log(`Connected to MCP server: ${entry.config.name} (${entry.tools.length} tools)`)
      this.emit('server-connected', serverId)

      return { success: true }
    } catch (error) {
      console.error(`Failed to connect to MCP server:`, error)
      entry.config.connected = false
      if (entry.process) {
        entry.process.kill()
        entry.process = null
      }
      return { success: false, error: (error as Error).message }
    }
  }

  /**
   * Disconnect from an MCP server.
   */
  async disconnect(serverId: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.servers.get(serverId)
    if (!entry) return { success: false, error: 'Server not found' }

    if (entry.process) {
      entry.process.kill()
      entry.process = null
    }

    entry.config.connected = false
    entry.tools = []

    // Reject pending requests
    for (const [, pending] of entry.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Disconnected'))
    }
    entry.pendingRequests.clear()

    this.emit('server-disconnected', serverId)
    return { success: true }
  }

  /**
   * List tools available on a server.
   */
  listTools(serverId: string): MCPTool[] {
    const entry = this.servers.get(serverId)
    return entry?.tools || []
  }

  /**
   * List all tools across all connected servers.
   */
  listAllTools(): MCPTool[] {
    const allTools: MCPTool[] = []
    for (const entry of this.servers.values()) {
      if (entry.config.connected) {
        allTools.push(...entry.tools)
      }
    }
    return allTools
  }

  /**
   * Execute a tool on a specific server.
   */
  async executeTool(
    serverId: string,
    toolName: string,
    args: Record<string, any>
  ): Promise<MCPToolResult> {
    const entry = this.servers.get(serverId)
    if (!entry || !entry.config.connected) {
      return { toolName, result: null, error: 'Server not connected' }
    }

    try {
      const response = await this.sendRequest(serverId, 'tools/call', {
        name: toolName,
        arguments: args
      })

      if (response.error) {
        return { toolName, result: null, error: response.error.message }
      }

      // MCP returns content array with text items
      const content = response.result?.content || []
      const textContent = content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n')

      let parsedResult: any
      try {
        parsedResult = JSON.parse(textContent)
      } catch {
        parsedResult = textContent
      }

      return { toolName, result: parsedResult }
    } catch (error) {
      return { toolName, result: null, error: (error as Error).message }
    }
  }

  /**
   * Refresh the tool list from a server.
   */
  private async refreshTools(serverId: string): Promise<void> {
    const entry = this.servers.get(serverId)
    if (!entry || !entry.config.connected) return

    try {
      const response = await this.sendRequest(serverId, 'tools/list', {})

      if (response.result?.tools) {
        entry.tools = response.result.tools.map((tool: any) => ({
          id: `${serverId}:${tool.name}`,
          serverName: entry.config.name,
          toolName: tool.name,
          description: tool.description || '',
          inputSchema: tool.inputSchema || {}
        }))
      }
    } catch (error) {
      console.error('Failed to refresh tools:', error)
    }
  }

  /**
   * Send a JSON-RPC 2.0 request to an MCP server.
   */
  private sendRequest(serverId: string, method: string, params: any): Promise<any> {
    const entry = this.servers.get(serverId)
    if (!entry?.process?.stdin) {
      return Promise.reject(new Error('Server not connected'))
    }

    const requestId = ++this.requestCounter
    const request = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      params
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        entry.pendingRequests.delete(requestId)
        reject(new Error(`MCP request timed out: ${method}`))
      }, REQUEST_TIMEOUT_MS)

      entry.pendingRequests.set(requestId, { resolve, reject, timeout })

      const line = JSON.stringify(request) + '\n'
      entry.process!.stdin!.write(line)
    })
  }

  /**
   * Handle a JSON-RPC response from an MCP server.
   */
  private handleServerResponse(serverId: string, line: string): void {
    const entry = this.servers.get(serverId)
    if (!entry) return

    try {
      const response = JSON.parse(line)
      const requestId = response.id

      if (requestId !== undefined && entry.pendingRequests.has(requestId)) {
        const pending = entry.pendingRequests.get(requestId)!
        entry.pendingRequests.delete(requestId)
        clearTimeout(pending.timeout)
        pending.resolve(response)
      }
    } catch (err) {
      // Not JSON - might be a log line that leaked to stdout
      console.warn(`[MCP:${entry.config.name}] non-JSON stdout: ${line.substring(0, 100)}`)
    }
  }

  /**
   * Disconnect from all servers and clean up.
   */
  async shutdown(): Promise<void> {
    const serverIds = Array.from(this.servers.keys())
    await Promise.all(serverIds.map((id) => this.disconnect(id)))
  }
}

// ── Singleton ──────────────────────────────────────────────────

let managerInstance: MCPClientManager | null = null

export function getMCPClientManager(): MCPClientManager {
  if (!managerInstance) {
    managerInstance = new MCPClientManager()
  }
  return managerInstance
}
