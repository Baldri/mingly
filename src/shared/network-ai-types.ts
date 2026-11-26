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
 * Whether a hostname names THIS machine, and nothing else.
 *
 * Deliberately NOT `isLocalNetwork`, which is also true for the whole RFC1918
 * space. The two answer different questions and must not be swapped: a box at
 * 192.168.1.50 is on the local network, but content sent there has left the
 * device — which is the only thing `residency: 'on-device'` promises
 * (provider-types.ts). Reusing the wider predicate for a locality check is
 * what put a LAN host behind an on-device label in the first place.
 *
 * Pass a hostname that came out of `new URL(...)`, not a raw config string.
 * URL parsing normalises the numeric IPv4 encodings for us — `2130706433`,
 * `0x7f.1` and `127.1` all arrive here as `127.0.0.1` (measured 26.11.2026) —
 * so this function never has to recognise a spelling.
 *
 * Exactly three shapes are accepted: `localhost`, `::1` (with or without the
 * brackets `URL.hostname` keeps) and 127.0.0.0/8. Everything else is refused,
 * including `*.localhost` and IPv4-mapped IPv6 (`::ffff:7f00:1`): both do
 * resolve to loopback, neither is a configuration anyone needs for a local
 * Ollama, and a parser that tried to cover them is where the next
 * off-by-one-encoding hole would sit. Fail closed rather than clever.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '')

  if (bare === 'localhost') return true
  if (bare === '::1') return true

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (!v4) return false

  const octets = v4.slice(1).map(Number)
  if (octets.some((octet) => octet > 255)) return false
  return octets[0] === 127
}

/**
 * Whether the URL's host is this machine. Returns false for anything that is
 * not a parseable absolute URL — an unparseable target is not a loopback
 * target.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHostname(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Build full API URL from config
 */
export function buildAPIUrl(config: NetworkAIServerConfig): string {
  const baseUrl = `${config.protocol}://${config.host}:${config.port}`
  return config.basePath ? `${baseUrl}${config.basePath}` : baseUrl
}
