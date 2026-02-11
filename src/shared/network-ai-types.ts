/**
 * Network AI Server Configuration
 * For enterprise deployments with local/network AI servers
 */

export type NetworkAIProtocol = 'http' | 'https'
export type NetworkAIType = 'openai-compatible' | 'ollama' | 'vllm' | 'text-generation-webui' | 'llamacpp' | 'custom'

export interface NetworkAIServerConfig {
  id: string
  name: string
  type: NetworkAIType
  protocol: NetworkAIProtocol
  host: string // e.g., "192.168.1.100" or "ai-server.company.local"
  port: number
  basePath?: string // e.g., "/v1" or "/api"
  apiKeyRequired: boolean
  apiKey?: string

  // Connection settings
  timeout?: number // milliseconds
  maxRetries?: number

  // Network info
  isLocal: boolean // true if on same machine (localhost/127.0.0.1)
  isLAN: boolean // true if on local network (192.168.x.x, 10.x.x.x)

  // Security
  tlsVerify: boolean // verify SSL certificates
  allowSelfSigned: boolean // allow self-signed certs for internal servers

  // Metadata
  description?: string
  createdAt: number
  lastConnected?: number
  status?: 'online' | 'offline' | 'unknown'
}

export interface NetworkDiscoveryResult {
  host: string
  port: number
  type: NetworkAIType
  version?: string
  models?: string[]
  responseTime: number
}

/**
 * Common network AI server configurations
 */
export const NETWORK_AI_TEMPLATES: Record<string, Partial<NetworkAIServerConfig>> = {
  'ollama-local': {
    name: 'Ollama (Local)',
    type: 'ollama',
    protocol: 'http',
    host: 'localhost',
    port: 11434,
    apiKeyRequired: false,
    isLocal: true,
    isLAN: false,
    tlsVerify: false,
    allowSelfSigned: true
  },
  'ollama-network': {
    name: 'Ollama (Network)',
    type: 'ollama',
    protocol: 'http',
    port: 11434,
    apiKeyRequired: false,
    isLocal: false,
    isLAN: true,
    tlsVerify: false,
    allowSelfSigned: true
  },
  'vllm-server': {
    name: 'vLLM Server',
    type: 'vllm',
    protocol: 'http',
    port: 8000,
    basePath: '/v1',
    apiKeyRequired: false,
    isLocal: false,
    isLAN: true,
    tlsVerify: false,
    allowSelfSigned: true
  },
  'text-gen-webui': {
    name: 'Text Generation WebUI',
    type: 'text-generation-webui',
    protocol: 'http',
    port: 5000,
    basePath: '/v1',
    apiKeyRequired: false,
    isLocal: false,
    isLAN: true,
    tlsVerify: false,
    allowSelfSigned: true
  },
  'llamacpp-server': {
    name: 'llama.cpp Server',
    type: 'llamacpp',
    protocol: 'http',
    port: 8080,
    apiKeyRequired: false,
    isLocal: false,
    isLAN: true,
    tlsVerify: false,
    allowSelfSigned: true
  }
}

/**
 * Check if host is local network IP
 */
export function isLocalNetwork(host: string): boolean {
  // localhost variants
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return true
  }

  // Private IP ranges
  const privateRanges = [
    /^10\./,                    // 10.0.0.0 - 10.255.255.255
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0 - 172.31.255.255
    /^192\.168\./               // 192.168.0.0 - 192.168.255.255
  ]

  return privateRanges.some(range => range.test(host))
}

/**
 * Build full API URL from config
 */
export function buildAPIUrl(config: NetworkAIServerConfig): string {
  const baseUrl = `${config.protocol}://${config.host}:${config.port}`
  return config.basePath ? `${baseUrl}${config.basePath}` : baseUrl
}
