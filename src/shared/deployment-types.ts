/**
 * Mingly Deployment Mode Types
 *
 * Three deployment modes:
 * 1. STANDALONE  — Single-user desktop app. Local LLM + Cloud APIs.
 * 2. SERVER      — Headless/windowed server exposing REST + WebSocket API.
 *                  Manages an LLM pool for network clients.
 * 3. HYBRID      — Desktop client that uses local LLM, connects to a
 *                  Mingly Server for additional models, and can fall back
 *                  to cloud APIs.
 */

// ── Deployment Mode ─────────────────────────────────────────────

export type DeploymentMode = 'standalone' | 'server' | 'hybrid'

// ── Server Configuration (for SERVER mode) ──────────────────────

export interface MinglyServerConfig {
  /** Port the HTTP/WS API listens on */
  port: number
  /** Bind address (0.0.0.0 for all interfaces, 127.0.0.1 for localhost only) */
  host: string
  /** Require API key for all requests */
  requireAuth: boolean
  /** Server-level API key (clients must send this in Authorization header) */
  apiKey?: string
  /** Enable WebSocket streaming endpoint */
  enableWebSocket: boolean
  /** Max concurrent sessions */
  maxSessions: number
  /** CORS allowed origins (empty = same-origin only) */
  corsOrigins: string[]
  /** Enable server discovery via mDNS/Bonjour */
  enableDiscovery: boolean
  /** Human-readable server name for discovery */
  serverName: string
}

export const DEFAULT_SERVER_CONFIG: MinglyServerConfig = {
  port: 3939,
  host: '127.0.0.1',
  requireAuth: true,
  enableWebSocket: true,
  maxSessions: 10,
  corsOrigins: [],
  enableDiscovery: true,
  serverName: 'Mingly Server'
}

// ── Hybrid Client Configuration (for HYBRID mode) ──────────────

export interface MinglyRemoteServer {
  /** Unique identifier */
  id: string
  /** Display name */
  name: string
  /** Server URL (e.g. http://192.168.1.50:3939) */
  url: string
  /** API key if server requires auth */
  apiKey?: string
  /** Connection status */
  status: 'online' | 'offline' | 'connecting' | 'unknown'
  /** Last successful connection timestamp */
  lastConnected?: number
  /** Response time in ms from last health check */
  latencyMs?: number
  /** Models available on this server */
  availableModels?: string[]
  /** Server version */
  serverVersion?: string
}

export interface HybridClientConfig {
  /** Remote Mingly Servers to connect to */
  remoteServers: MinglyRemoteServer[]
  /** Preferred LLM source priority */
  priority: LLMSourcePriority
  /** Fall back to cloud if local + network unavailable */
  cloudFallback: boolean
  /** Auto-discover Mingly Servers on LAN */
  autoDiscover: boolean
}

export type LLMSourcePriority = 'local-first' | 'network-first' | 'cloud-first' | 'cheapest' | 'fastest'

export const DEFAULT_HYBRID_CONFIG: HybridClientConfig = {
  remoteServers: [],
  priority: 'local-first',
  cloudFallback: true,
  autoDiscover: true
}

// ── Deployment Configuration ────────────────────────────────────

export interface DeploymentConfig {
  mode: DeploymentMode
  server: MinglyServerConfig
  hybrid: HybridClientConfig
}

export const DEFAULT_DEPLOYMENT_CONFIG: DeploymentConfig = {
  mode: 'standalone',
  server: DEFAULT_SERVER_CONFIG,
  hybrid: DEFAULT_HYBRID_CONFIG
}

// ── API Types (Server REST API) ─────────────────────────────────

export interface APIRequest {
  /** Request ID for tracking */
  requestId: string
  /** Timestamp */
  timestamp: number
}

export interface APIChatRequest extends APIRequest {
  messages: Array<{
    role: 'user' | 'assistant' | 'system'
    content: string
  }>
  provider?: string
  model?: string
  temperature?: number
  stream?: boolean
}

export interface APIChatResponse {
  requestId: string
  content: string
  provider: string
  model: string
  tokens?: number
  cost?: number
  finishReason?: string
}

export interface APIStreamChunk {
  requestId: string
  content: string
  done: boolean
}

export interface APIServerInfo {
  name: string
  version: string
  mode: DeploymentMode
  providers: string[]
  models: Record<string, string[]>
  maxSessions: number
  activeSessions: number
}

export interface APIHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  uptime: number
  version: string
  providers: Record<string, { available: boolean; latencyMs?: number }>
}
