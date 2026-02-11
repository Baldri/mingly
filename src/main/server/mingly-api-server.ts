/**
 * Mingly API Server
 *
 * REST + WebSocket server that exposes the ServiceLayer over HTTP.
 * Used in SERVER deployment mode to allow network clients (other Mingly
 * instances in HYBRID mode, or any HTTP client) to use this node's LLM pool.
 *
 * Endpoints:
 *   GET  /health           — Health check + provider status
 *   GET  /info             — Server info (name, providers, models)
 *   GET  /providers        — List available providers and models
 *   POST /chat             — Non-streaming chat completion
 *   POST /chat/stream      — SSE streaming chat completion
 *   WS   /ws               — WebSocket streaming chat
 *   GET  /conversations    — List conversations
 *   POST /conversations    — Create conversation
 *   GET  /conversations/:id — Get conversation with messages
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import { getServiceLayer, ChatStreamEvent } from '../services/service-layer'
import type { MinglyServerConfig, APIServerInfo, APIHealthResponse, APIChatRequest } from '../../shared/deployment-types'
import { generateId } from '../utils/id-generator'
import { createLogger } from '../../shared/logger'

const log = createLogger('APIServer')

// Read version dynamically from package.json
let APP_VERSION = '0.1.0'
try {
  const pkg = require('../../package.json')
  APP_VERSION = pkg.version || APP_VERSION
} catch { /* fallback to hardcoded */ }

export class MinglyAPIServer {
  private httpServer: ReturnType<typeof createServer> | null = null
  private wss: WebSocketServer | null = null
  private config: MinglyServerConfig
  private startTime: number = 0
  private activeSessions: number = 0

  constructor(config: MinglyServerConfig) {
    this.config = config
  }

  /**
   * Start the API server
   */
  async start(): Promise<void> {
    this.startTime = Date.now()
    const serviceLayer = getServiceLayer()

    // Create HTTP server
    this.httpServer = createServer(async (req, res) => {
      // CORS headers
      this.setCORSHeaders(res)

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      // Auth check
      if (this.config.requireAuth && !this.checkAuth(req)) {
        this.sendJSON(res, 401, { error: 'Unauthorized', message: 'Valid API key required in Authorization header' })
        return
      }

      try {
        await this.handleRequest(req, res)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal server error'
        this.sendJSON(res, 500, { error: 'InternalServerError', message })
      }
    })

    // WebSocket server (attached to HTTP server)
    if (this.config.enableWebSocket) {
      this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' })

      this.wss.on('connection', (ws, req) => {
        // Auth check for WebSocket
        if (this.config.requireAuth && !this.checkAuth(req)) {
          ws.close(4001, 'Unauthorized')
          return
        }

        if (this.activeSessions >= this.config.maxSessions) {
          ws.close(4002, 'Max sessions reached')
          return
        }

        this.activeSessions++
        log.info('WebSocket client connected', { activeSessions: this.activeSessions })

        ws.on('message', async (data) => {
          try {
            const message = JSON.parse(data.toString())
            await this.handleWSMessage(ws, message)
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Invalid message'
            ws.send(JSON.stringify({ type: 'error', error: errorMsg }))
          }
        })

        ws.on('close', () => {
          this.activeSessions--
          log.info('WebSocket client disconnected', { activeSessions: this.activeSessions })
        })
      })
    }

    // Start listening
    return new Promise((resolve) => {
      this.httpServer!.listen(this.config.port, this.config.host, () => {
        log.info('Mingly API Server started', {
          http: `http://${this.config.host}:${this.config.port}`,
          ws: this.config.enableWebSocket ? `ws://${this.config.host}:${this.config.port}/ws` : 'disabled',
          auth: this.config.requireAuth ? 'required' : 'disabled',
          maxSessions: this.config.maxSessions,
        })
        resolve()
      })
    })
  }

  /**
   * Stop the API server
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close()
        this.wss = null
      }
      if (this.httpServer) {
        this.httpServer.close(() => {
          log.info('Mingly API Server stopped')
          this.httpServer = null
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  /**
   * Route HTTP requests
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const path = url.pathname
    const method = req.method || 'GET'

    // GET /health
    if (method === 'GET' && path === '/health') {
      return this.handleHealth(res)
    }

    // GET /info
    if (method === 'GET' && path === '/info') {
      return this.handleInfo(res)
    }

    // GET /providers
    if (method === 'GET' && path === '/providers') {
      return this.handleProviders(res)
    }

    // POST /chat
    if (method === 'POST' && path === '/chat') {
      const body = await this.readBody(req)
      return this.handleChat(res, body)
    }

    // POST /chat/stream (Server-Sent Events)
    if (method === 'POST' && path === '/chat/stream') {
      const body = await this.readBody(req)
      return this.handleChatStream(res, body)
    }

    // GET /conversations
    if (method === 'GET' && path === '/conversations') {
      return this.handleListConversations(res)
    }

    // POST /conversations
    if (method === 'POST' && path === '/conversations') {
      const body = await this.readBody(req)
      return this.handleCreateConversation(res, body)
    }

    // GET /conversations/:id
    const convMatch = path.match(/^\/conversations\/([a-zA-Z0-9_-]+)$/)
    if (method === 'GET' && convMatch) {
      return this.handleGetConversation(res, convMatch[1])
    }

    // 404
    this.sendJSON(res, 404, { error: 'NotFound', message: `${method} ${path} not found` })
  }

  // ── REST Handlers ─────────────────────────────────────────────

  private handleHealth(res: ServerResponse): void {
    const serviceLayer = getServiceLayer()
    const providers = serviceLayer.getProviders()

    const providerStatus: Record<string, { available: boolean }> = {}
    for (const p of providers) {
      providerStatus[p.id] = { available: p.available }
    }

    const response: APIHealthResponse = {
      status: providers.some(p => p.available) ? 'healthy' : 'unhealthy',
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: APP_VERSION,
      providers: providerStatus
    }

    this.sendJSON(res, 200, response)
  }

  private handleInfo(res: ServerResponse): void {
    const serviceLayer = getServiceLayer()
    const providers = serviceLayer.getProviders()

    const models: Record<string, string[]> = {}
    for (const p of providers) {
      if (p.available) {
        models[p.id] = p.models
      }
    }

    const response: APIServerInfo = {
      name: this.config.serverName,
      version: APP_VERSION,
      mode: 'server',
      providers: providers.filter(p => p.available).map(p => p.id),
      models,
      maxSessions: this.config.maxSessions,
      activeSessions: this.activeSessions
    }

    this.sendJSON(res, 200, response)
  }

  private handleProviders(res: ServerResponse): void {
    const serviceLayer = getServiceLayer()
    this.sendJSON(res, 200, { providers: serviceLayer.getProviders() })
  }

  private async handleChat(res: ServerResponse, body: string): Promise<void> {
    const parsed = this.parseChatRequest(body)
    if (!parsed) {
      this.sendJSON(res, 400, { error: 'BadRequest', message: 'Invalid chat request. Required: messages[]' })
      return
    }

    const serviceLayer = getServiceLayer()
    const result = await serviceLayer.sendMessageStreaming(
      {
        conversationId: parsed.conversationId || generateId(),
        messages: parsed.messages.map(m => ({ id: generateId(), role: m.role, content: m.content })),
        provider: parsed.provider || 'anthropic',
        model: parsed.model || 'claude-3-5-sonnet-20241022',
        temperature: parsed.temperature
      },
      () => {} // No streaming for REST
    )

    this.sendJSON(res, result.success ? 200 : 500, {
      requestId: parsed.requestId,
      ...result
    })
  }

  private async handleChatStream(res: ServerResponse, body: string): Promise<void> {
    const parsed = this.parseChatRequest(body)
    if (!parsed) {
      this.sendJSON(res, 400, { error: 'BadRequest', message: 'Invalid chat request. Required: messages[]' })
      return
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    })

    const serviceLayer = getServiceLayer()
    await serviceLayer.sendMessageStreaming(
      {
        conversationId: parsed.conversationId || generateId(),
        messages: parsed.messages.map(m => ({ id: generateId(), role: m.role, content: m.content })),
        provider: parsed.provider || 'anthropic',
        model: parsed.model || 'claude-3-5-sonnet-20241022',
        temperature: parsed.temperature
      },
      (event: ChatStreamEvent) => {
        if (event.type === 'chunk') {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: event.content })}\n\n`)
        } else if (event.type === 'complete') {
          res.write(`data: ${JSON.stringify({ type: 'complete', metadata: event.metadata })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        } else if (event.type === 'error') {
          res.write(`data: ${JSON.stringify({ type: 'error', error: event.error })}\n\n`)
          res.end()
        }
      }
    )
  }

  private handleListConversations(res: ServerResponse): void {
    const serviceLayer = getServiceLayer()
    const conversations = serviceLayer.getConversations()
    this.sendJSON(res, 200, { conversations })
  }

  private handleCreateConversation(res: ServerResponse, body: string): void {
    try {
      const { title, provider, model } = JSON.parse(body)
      const serviceLayer = getServiceLayer()
      const conversation = serviceLayer.createConversation(
        title || 'New Conversation',
        provider || 'anthropic',
        model || 'claude-3-5-sonnet-20241022'
      )
      this.sendJSON(res, 201, { conversation })
    } catch {
      this.sendJSON(res, 400, { error: 'BadRequest', message: 'Invalid request body' })
    }
  }

  private handleGetConversation(res: ServerResponse, id: string): void {
    const serviceLayer = getServiceLayer()
    const conversation = serviceLayer.getConversation(id)
    if (conversation) {
      this.sendJSON(res, 200, { conversation })
    } else {
      this.sendJSON(res, 404, { error: 'NotFound', message: 'Conversation not found' })
    }
  }

  // ── WebSocket Handler ─────────────────────────────────────────

  private async handleWSMessage(ws: WebSocket, message: any): Promise<void> {
    if (message.type !== 'chat') {
      ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${message.type}` }))
      return
    }

    const requestId = message.requestId || generateId()

    if (!message.messages || !Array.isArray(message.messages)) {
      ws.send(JSON.stringify({ type: 'error', requestId, error: 'messages[] required' }))
      return
    }

    const serviceLayer = getServiceLayer()
    await serviceLayer.sendMessageStreaming(
      {
        conversationId: message.conversationId || generateId(),
        messages: message.messages.map((m: any) => ({ id: generateId(), role: m.role, content: m.content })),
        provider: message.provider || 'anthropic',
        model: message.model || 'claude-3-5-sonnet-20241022',
        temperature: message.temperature
      },
      (event: ChatStreamEvent) => {
        if (ws.readyState !== WebSocket.OPEN) return

        ws.send(JSON.stringify({
          requestId,
          ...event
        }))
      }
    )
  }

  // ── Helpers ───────────────────────────────────────────────────

  private checkAuth(req: IncomingMessage): boolean {
    if (!this.config.requireAuth || !this.config.apiKey) return true

    const authHeader = req.headers['authorization']
    if (!authHeader) return false

    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
    return token === this.config.apiKey
  }

  private setCORSHeaders(res: ServerResponse): void {
    const origins = this.config.corsOrigins.length > 0
      ? this.config.corsOrigins.join(', ')
      : '*'

    res.setHeader('Access-Control-Allow-Origin', origins)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }

  private sendJSON(res: ServerResponse, status: number, data: any): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => { body += chunk.toString() })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }

  private parseChatRequest(body: string): (APIChatRequest & { conversationId?: string }) | null {
    try {
      const parsed = JSON.parse(body)
      if (!parsed.messages || !Array.isArray(parsed.messages)) return null

      return {
        requestId: parsed.requestId || generateId(),
        timestamp: Date.now(),
        messages: parsed.messages,
        provider: parsed.provider,
        model: parsed.model,
        temperature: parsed.temperature,
        stream: parsed.stream,
        conversationId: parsed.conversationId
      }
    } catch {
      return null
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────

let apiServerInstance: MinglyAPIServer | null = null

export function getMinglyAPIServer(config: MinglyServerConfig): MinglyAPIServer {
  if (!apiServerInstance) {
    apiServerInstance = new MinglyAPIServer(config)
  }
  return apiServerInstance
}

export function getExistingAPIServer(): MinglyAPIServer | null {
  return apiServerInstance
}
