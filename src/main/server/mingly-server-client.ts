/**
 * Mingly Server Client
 *
 * Connects to a remote Mingly API Server (another Mingly instance in SERVER
 * mode) and exposes its LLM pool as if they were local providers.
 *
 * Used in HYBRID deployment mode to let a desktop client use network LLMs
 * alongside local models and cloud APIs.
 */

import WebSocket from 'ws'
import type { MinglyRemoteServer } from '../../shared/deployment-types'
import type { APIServerInfo, APIHealthResponse } from '../../shared/deployment-types'
import type { StreamChunk } from '../llm-clients/base-client'
import { generateId } from '../utils/id-generator'

export class MinglyServerClient {
  private servers: Map<string, MinglyRemoteServer> = new Map()
  private wsConnections: Map<string, WebSocket> = new Map()

  /**
   * Add a remote Mingly Server
   */
  addServer(server: Omit<MinglyRemoteServer, 'status'>): MinglyRemoteServer {
    const entry: MinglyRemoteServer = {
      ...server,
      status: 'unknown'
    }
    this.servers.set(server.id, entry)
    return entry
  }

  /**
   * Remove a remote server
   */
  removeServer(serverId: string): boolean {
    this.disconnectWS(serverId)
    return this.servers.delete(serverId)
  }

  /**
   * Get all configured remote servers
   */
  getServers(): MinglyRemoteServer[] {
    return Array.from(this.servers.values())
  }

  /**
   * Get a specific server
   */
  getServer(serverId: string): MinglyRemoteServer | undefined {
    return this.servers.get(serverId)
  }

  /**
   * Health check a remote Mingly Server
   */
  async checkHealth(serverId: string): Promise<APIHealthResponse | null> {
    const server = this.servers.get(serverId)
    if (!server) return null

    try {
      const startTime = Date.now()
      const response = await fetch(`${server.url}/health`, {
        headers: this.getHeaders(server),
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) {
        server.status = 'offline'
        return null
      }

      const data = await response.json() as APIHealthResponse
      server.status = 'online'
      server.lastConnected = Date.now()
      server.latencyMs = Date.now() - startTime

      return data
    } catch {
      server.status = 'offline'
      return null
    }
  }

  /**
   * Get server info (providers, models, etc.)
   */
  async getServerInfo(serverId: string): Promise<APIServerInfo | null> {
    const server = this.servers.get(serverId)
    if (!server) return null

    try {
      const response = await fetch(`${server.url}/info`, {
        headers: this.getHeaders(server),
        signal: AbortSignal.timeout(5000)
      })

      if (!response.ok) return null

      const data = await response.json() as APIServerInfo
      server.availableModels = Object.values(data.models).flat()
      server.serverVersion = data.version

      return data
    } catch {
      return null
    }
  }

  /**
   * Send a non-streaming chat request to a remote server
   */
  async sendMessage(
    serverId: string,
    messages: Array<{ role: string; content: string }>,
    provider?: string,
    model?: string,
    temperature?: number
  ): Promise<{ success: boolean; content?: string; error?: string; metadata?: any }> {
    const server = this.servers.get(serverId)
    if (!server) return { success: false, error: 'Server not found' }

    try {
      const response = await fetch(`${server.url}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getHeaders(server)
        },
        body: JSON.stringify({
          requestId: generateId(),
          messages,
          provider,
          model,
          temperature
        }),
        signal: AbortSignal.timeout(120_000) // 2 min for LLM responses
      })

      const data = await response.json() as any
      return {
        success: data.success,
        content: data.response,
        error: data.error,
        metadata: data.metadata
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed'
      return { success: false, error: message }
    }
  }

  /**
   * Send a streaming chat request via SSE
   */
  async *sendMessageStreaming(
    serverId: string,
    messages: Array<{ role: string; content: string }>,
    provider?: string,
    model?: string,
    temperature?: number
  ): AsyncGenerator<StreamChunk> {
    const server = this.servers.get(serverId)
    if (!server) {
      yield { content: '', done: true }
      return
    }

    try {
      const response = await fetch(`${server.url}/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getHeaders(server)
        },
        body: JSON.stringify({
          requestId: generateId(),
          messages,
          provider,
          model,
          temperature,
          stream: true
        }),
        signal: AbortSignal.timeout(120_000)
      })

      if (!response.ok || !response.body) {
        yield { content: '', done: true }
        return
      }

      // Read SSE stream
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete SSE messages
        const lines = buffer.split('\n')
        buffer = lines.pop() || '' // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()

          if (data === '[DONE]') {
            yield { content: '', done: true }
            return
          }

          try {
            const parsed = JSON.parse(data)
            if (parsed.type === 'chunk') {
              yield { content: parsed.content || '', done: false }
            } else if (parsed.type === 'error') {
              console.error(`Remote server error: ${parsed.error}`)
              yield { content: '', done: true }
              return
            }
          } catch {
            // Ignore malformed SSE data
          }
        }
      }

      yield { content: '', done: true }
    } catch (error) {
      console.error('SSE streaming error:', error)
      yield { content: '', done: true }
    }
  }

  /**
   * Connect WebSocket to a remote server (for real-time streaming)
   */
  connectWS(serverId: string): Promise<boolean> {
    const server = this.servers.get(serverId)
    if (!server) return Promise.resolve(false)

    return new Promise((resolve) => {
      const wsUrl = server.url.replace(/^http/, 'ws') + '/ws'
      const headers: Record<string, string> = {}

      if (server.apiKey) {
        headers['Authorization'] = `Bearer ${server.apiKey}`
      }

      const ws = new WebSocket(wsUrl, { headers })

      ws.on('open', () => {
        this.wsConnections.set(serverId, ws)
        server.status = 'online'
        server.lastConnected = Date.now()
        console.log(`🔌 Connected to Mingly Server: ${server.name}`)
        resolve(true)
      })

      ws.on('error', () => {
        server.status = 'offline'
        resolve(false)
      })

      ws.on('close', () => {
        this.wsConnections.delete(serverId)
        server.status = 'offline'
      })
    })
  }

  /**
   * Disconnect WebSocket from a server
   */
  disconnectWS(serverId: string): void {
    const ws = this.wsConnections.get(serverId)
    if (ws) {
      ws.close()
      this.wsConnections.delete(serverId)
    }
  }

  /**
   * Send a streaming chat via WebSocket
   */
  sendMessageViaWS(
    serverId: string,
    messages: Array<{ role: string; content: string }>,
    onChunk: (content: string) => void,
    onComplete: (metadata?: any) => void,
    onError: (error: string) => void,
    provider?: string,
    model?: string,
    temperature?: number
  ): void {
    const ws = this.wsConnections.get(serverId)
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      onError('WebSocket not connected')
      return
    }

    const requestId = generateId()

    // Set up response handler
    const handler = (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString())
        if (message.requestId !== requestId) return

        if (message.type === 'chunk') {
          onChunk(message.content || '')
        } else if (message.type === 'complete') {
          ws.off('message', handler)
          onComplete(message.metadata)
        } else if (message.type === 'error') {
          ws.off('message', handler)
          onError(message.error || 'Unknown error')
        }
      } catch {
        // Ignore parse errors
      }
    }

    ws.on('message', handler)

    // Send request
    ws.send(JSON.stringify({
      type: 'chat',
      requestId,
      messages,
      provider,
      model,
      temperature
    }))
  }

  /**
   * Discover Mingly Servers on the local network
   * Scans common port (3939) on LAN
   */
  async discoverServers(networkRange: string = '192.168.1'): Promise<MinglyRemoteServer[]> {
    const discovered: MinglyRemoteServer[] = []

    // Scan localhost first
    const localResult = await this.probeServer('localhost', 3939)
    if (localResult) discovered.push(localResult)

    // Scan common LAN hosts (1-20 for quick scan)
    const scanPromises = []
    for (let i = 1; i <= 20; i++) {
      scanPromises.push(this.probeServer(`${networkRange}.${i}`, 3939))
    }

    const results = await Promise.allSettled(scanPromises)
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        discovered.push(result.value)
      }
    }

    return discovered
  }

  private async probeServer(host: string, port: number): Promise<MinglyRemoteServer | null> {
    const url = `http://${host}:${port}`

    try {
      const response = await fetch(`${url}/info`, {
        signal: AbortSignal.timeout(2000)
      })

      if (!response.ok) return null

      const info = await response.json() as APIServerInfo

      return {
        id: `${host}:${port}`,
        name: info.name,
        url,
        status: 'online',
        lastConnected: Date.now(),
        availableModels: Object.values(info.models).flat(),
        serverVersion: info.version
      }
    } catch {
      return null
    }
  }

  private getHeaders(server: MinglyRemoteServer): Record<string, string> {
    const headers: Record<string, string> = {}
    if (server.apiKey) {
      headers['Authorization'] = `Bearer ${server.apiKey}`
    }
    return headers
  }

  /**
   * Shutdown all connections
   */
  shutdown(): void {
    for (const [serverId] of this.wsConnections) {
      this.disconnectWS(serverId)
    }
    this.servers.clear()
  }
}

// ── Singleton ───────────────────────────────────────────────────

let serverClientInstance: MinglyServerClient | null = null

export function getMinglyServerClient(): MinglyServerClient {
  if (!serverClientInstance) {
    serverClientInstance = new MinglyServerClient()
  }
  return serverClientInstance
}
