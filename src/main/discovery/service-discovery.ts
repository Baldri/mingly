/**
 * Unified Service Discovery Engine
 *
 * Scans for RAG and MCP servers across three locations:
 * - Local:   Well-known ports on localhost
 * - Network: mDNS/Bonjour + common LAN ports
 * - Cloud:   User-configured endpoints
 *
 * DocMind: auto-detected and connected without user action.
 */

import type { DiscoveredService } from '../../shared/types'

interface DiscoveryOptions {
  type?: 'rag' | 'mcp' | 'all'
  timeout?: number
}

// Well-known local RAG endpoints
const LOCAL_RAG_ENDPOINTS = [
  { name: 'Qdrant', provider: 'qdrant', port: 6333, path: '/collections', check: (d: any) => Array.isArray(d?.result?.collections) },
  { name: 'ChromaDB', provider: 'chromadb', port: 8000, path: '/api/v1/heartbeat', check: () => true },
  { name: 'RAG-Wissen', provider: 'rag-wissen', port: 8080, path: '/health', check: () => true },
  { name: 'DocMind REST', provider: 'docmind', port: 3100, path: '/health', check: () => true },
  { name: 'DocMind REST (alt)', provider: 'docmind', port: 8000, path: '/health', check: () => true },
]

// Well-known local MCP server locations
const LOCAL_MCP_PATHS = [
  { name: 'DocMind MCP', provider: 'docmind', command: 'docmind-server', description: 'DocMind knowledge base MCP' },
]

// Network scan ports (for LAN discovery)
const NETWORK_RAG_PORTS = [6333, 6334, 8000, 8080, 3100, 19530]
const NETWORK_MCP_PORTS = [3000, 3001, 8080, 9090]

class ServiceDiscovery {
  private cloudEndpoints: Array<{ type: 'rag' | 'mcp'; name: string; url: string; provider?: string }> = []

  /**
   * Add a user-configured cloud endpoint.
   */
  addCloudEndpoint(type: 'rag' | 'mcp', name: string, url: string, provider?: string): void {
    this.cloudEndpoints.push({ type, name, url, provider })
  }

  removeCloudEndpoint(url: string): void {
    this.cloudEndpoints = this.cloudEndpoints.filter((e) => e.url !== url)
  }

  /**
   * Run discovery across all locations.
   */
  async discover(options: DiscoveryOptions = {}): Promise<DiscoveredService[]> {
    const { type = 'all', timeout = 3000 } = options
    const results: DiscoveredService[] = []

    const tasks: Promise<DiscoveredService[]>[] = []

    if (type === 'all' || type === 'rag') {
      tasks.push(this.discoverLocalRAG(timeout))
      tasks.push(this.discoverCloudRAG(timeout))
      tasks.push(this.discoverNetworkRAG(timeout))
    }

    if (type === 'all' || type === 'mcp') {
      tasks.push(this.discoverLocalMCP())
      tasks.push(this.discoverCloudMCP(timeout))
      tasks.push(this.discoverNetworkMCP(timeout))
    }

    const allResults = await Promise.allSettled(tasks)
    for (const result of allResults) {
      if (result.status === 'fulfilled') {
        results.push(...result.value)
      }
    }

    return results
  }

  private async discoverLocalRAG(timeout: number): Promise<DiscoveredService[]> {
    const results: DiscoveredService[] = []

    const checks = LOCAL_RAG_ENDPOINTS.map(async (endpoint) => {
      const url = `http://localhost:${endpoint.port}${endpoint.path}`
      const status = await this.probe(url, timeout, endpoint.check)
      results.push({
        type: 'rag',
        location: 'local',
        name: endpoint.name,
        url: `http://localhost:${endpoint.port}`,
        status,
        provider: endpoint.provider,
      })
    })

    await Promise.allSettled(checks)
    return results
  }

  private async discoverLocalMCP(): Promise<DiscoveredService[]> {
    const results: DiscoveredService[] = []
    const { exec } = require('child_process')
    const { promisify } = require('util')
    const execAsync = promisify(exec)

    for (const mcp of LOCAL_MCP_PATHS) {
      try {
        // Check if the command exists on the system
        await execAsync(`which ${mcp.command}`)
        results.push({
          type: 'mcp',
          location: 'local',
          name: mcp.name,
          url: mcp.command,
          status: 'online',
          provider: mcp.provider,
        })
      } catch {
        // Command not found — skip
      }
    }

    // Also scan for common MCP config files
    const fs = require('fs')
    const path = require('path')
    const homedir = require('os').homedir()
    const mcpConfigPaths = [
      path.join(homedir, '.mcp', 'servers.json'),
      path.join(homedir, '.config', 'mcp', 'servers.json'),
    ]

    for (const configPath of mcpConfigPaths) {
      if (fs.existsSync(configPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(configPath, 'utf8'))
          const servers = data.servers || data
          if (Array.isArray(servers)) {
            for (const server of servers) {
              results.push({
                type: 'mcp',
                location: 'local',
                name: server.name || server.command || 'MCP Server',
                url: server.command || server.url || configPath,
                status: 'unknown',
                provider: server.provider,
              })
            }
          }
        } catch {
          // Invalid config — skip
        }
      }
    }

    return results
  }

  private async discoverCloudRAG(timeout: number): Promise<DiscoveredService[]> {
    const results: DiscoveredService[] = []

    for (const endpoint of this.cloudEndpoints.filter((e) => e.type === 'rag')) {
      const status = await this.probe(endpoint.url, timeout)
      results.push({
        type: 'rag',
        location: 'cloud',
        name: endpoint.name,
        url: endpoint.url,
        status,
        provider: endpoint.provider,
      })
    }

    return results
  }

  private async discoverCloudMCP(timeout: number): Promise<DiscoveredService[]> {
    const results: DiscoveredService[] = []

    for (const endpoint of this.cloudEndpoints.filter((e) => e.type === 'mcp')) {
      const status = await this.probe(endpoint.url, timeout)
      results.push({
        type: 'mcp',
        location: 'cloud',
        name: endpoint.name,
        url: endpoint.url,
        status,
        provider: endpoint.provider,
      })
    }

    return results
  }

  private async discoverNetworkRAG(timeout: number): Promise<DiscoveredService[]> {
    // Lightweight: probe common network addresses via mDNS-like approach
    // For now, scan local subnet .1 gateway for common RAG ports
    const results: DiscoveredService[] = []

    try {
      const os = require('os')
      const interfaces = os.networkInterfaces()
      const subnets = new Set<string>()

      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
          if (iface.family === 'IPv4' && !iface.internal) {
            const parts = iface.address.split('.')
            subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`)
          }
        }
      }

      // Scan gateway (.1) and a few common server addresses (.10, .100)
      const targets = [...subnets].flatMap((subnet) => [
        `${subnet}.1`,
        `${subnet}.10`,
        `${subnet}.100`,
      ])

      const checks = targets.flatMap((ip) =>
        NETWORK_RAG_PORTS.map(async (port) => {
          const url = `http://${ip}:${port}`
          const status = await this.probe(`${url}/`, timeout)
          if (status === 'online') {
            results.push({
              type: 'rag',
              location: 'network',
              name: `RAG Server (${ip}:${port})`,
              url,
              status,
            })
          }
        })
      )

      await Promise.allSettled(checks)
    } catch {
      // Network scan failed — non-critical
    }

    return results
  }

  private async discoverNetworkMCP(timeout: number): Promise<DiscoveredService[]> {
    const results: DiscoveredService[] = []

    try {
      const os = require('os')
      const interfaces = os.networkInterfaces()
      const subnets = new Set<string>()

      for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
          if (iface.family === 'IPv4' && !iface.internal) {
            const parts = iface.address.split('.')
            subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`)
          }
        }
      }

      const targets = [...subnets].flatMap((subnet) => [
        `${subnet}.1`,
        `${subnet}.10`,
        `${subnet}.100`,
      ])

      const checks = targets.flatMap((ip) =>
        NETWORK_MCP_PORTS.map(async (port) => {
          const url = `http://${ip}:${port}`
          const status = await this.probe(`${url}/`, timeout)
          if (status === 'online') {
            results.push({
              type: 'mcp',
              location: 'network',
              name: `MCP Server (${ip}:${port})`,
              url,
              status,
            })
          }
        })
      )

      await Promise.allSettled(checks)
    } catch {
      // Network scan failed — non-critical
    }

    return results
  }

  /**
   * Probe a URL with timeout. Returns 'online' or 'offline'.
   */
  private async probe(
    url: string,
    timeout: number,
    check?: (data: any) => boolean
  ): Promise<'online' | 'offline'> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })

      clearTimeout(timer)

      if (!response.ok) return 'offline'

      if (check) {
        try {
          const data = await response.json()
          return check(data) ? 'online' : 'offline'
        } catch {
          return 'online' // Response OK but not JSON — still reachable
        }
      }

      return 'online'
    } catch {
      return 'offline'
    }
  }
}

// Singleton
let instance: ServiceDiscovery | null = null
export function getServiceDiscovery(): ServiceDiscovery {
  if (!instance) instance = new ServiceDiscovery()
  return instance
}
