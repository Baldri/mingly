/**
 * OllamaLoadBalancer — Round-Robin + Health-based routing across multiple Ollama instances.
 *
 * When several Ollama instances run on THIS machine, this balancer distributes
 * requests across them for throughput on parallel agent runs.
 *
 * It is loopback-only, and that is a residency constraint rather than a
 * technical one: the pool is consulted by the built-in OllamaClient, which the
 * provider registry declares `residency: 'on-device'`. Pooling a machine on
 * the LAN here — which this balancer did until 26.11.2026 — makes that
 * declaration false at the socket while the guards still act on it. Pooling
 * across machines is a product capability that needs its own provider identity
 * and its own residency value before it can come back; see `addBackend`.
 *
 * Strategy:
 * - Round-Robin among healthy backends (weighted by response latency)
 * - Health checks every 30 seconds
 * - Automatic failover when a backend goes offline
 * - Compatible with NetworkAIManager discovery results
 */

import { isLoopbackUrl } from '../../shared/network-ai-types'
import type { NetworkAIServerConfig } from '../../shared/network-ai-types'

/** Validate a backend URL to prevent URL injection */
function validateBackendUrl(protocol: string, host: string, port: number): string {
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error(`Invalid protocol: ${protocol}`)
  }
  // Only allow bare hostnames/IPs (no slashes, no @, no query strings)
  if (!/^[a-zA-Z0-9.\-:]+$/.test(host)) {
    throw new Error(`Invalid host: ${host}`)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`)
  }
  // Use URL constructor for final validation
  const url = new URL(`${protocol}://${host}:${port}`)
  return url.origin
}

export interface OllamaBackend {
  /** Server config from NetworkAIManager */
  server: NetworkAIServerConfig
  /** Current health status */
  healthy: boolean
  /** Average response latency in ms (for weighted routing) */
  avgLatencyMs: number
  /** Number of active requests */
  activeRequests: number
  /** Last health check timestamp */
  lastHealthCheck: number
  /** Consecutive health check failures */
  failureCount: number
}

export interface LoadBalancerStats {
  totalBackends: number
  healthyBackends: number
  totalRequests: number
  activeRequests: number
}

export class OllamaLoadBalancer {
  private backends: Map<string, OllamaBackend> = new Map()
  private roundRobinIndex = 0
  private totalRequests = 0
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null
  /**
   * Backend ids already refused as off-device, so the refusal is logged once
   * instead of once per refresh: LocalAIBridge.refreshAll() re-offers every
   * configured server on a 60s timer.
   */
  private refusedOffDevice: Set<string> = new Set()

  private static readonly HEALTH_CHECK_INTERVAL_MS = 30_000
  private static readonly MAX_FAILURES_BEFORE_UNHEALTHY = 3
  private static readonly HEALTH_CHECK_TIMEOUT_MS = 5_000

  /**
   * Add an Ollama backend to the pool.
   *
   * Loopback only. This pool is consulted by the built-in OllamaClient, the
   * one the provider registry declares `residency: 'on-device'` — so a pool
   * entry IS an on-device claim, and a backend on another machine would make
   * that claim false at the socket while two guards still read it as true
   * (`sensitive-stays-ch` routes confidential content here, and
   * `residencyIsCloud('on-device')` is false, which skips the upload-consent
   * branch in preflightGuard).
   *
   * A LAN Ollama stays a supported deployment — LocalAIBridge registers it as
   * its own `network:{id}` provider, pinned to that machine, and no guard
   * reads that id as on-device. What is refused here is only pooling it behind
   * an id that promises the opposite.
   *
   * Locality is read off the VALIDATED origin, not off `server.isLocal`: that
   * flag is recomputed by `addServer` but restored verbatim by `loadServers`,
   * so a value in `network-ai-servers.json` has never been re-checked.
   */
  addBackend(server: NetworkAIServerConfig): void {
    if (server.type !== 'ollama') return

    // Validate URL components to prevent injection
    let origin: string
    try {
      origin = validateBackendUrl(server.protocol, server.host, server.port)
    } catch (err) {
      console.warn(`[LoadBalancer] Rejected invalid backend: ${(err as Error).message}`)
      return
    }

    if (!isLoopbackUrl(origin)) {
      if (!this.refusedOffDevice.has(server.id)) {
        this.refusedOffDevice.add(server.id)
        console.warn(
          `[LoadBalancer] Rejected off-device backend ${origin}: this pool is read by the ` +
            'on-device provider. Use the network:{id} provider for that server.'
        )
      }
      return
    }

    this.refusedOffDevice.delete(server.id)

    this.backends.set(server.id, {
      server,
      healthy: true,
      avgLatencyMs: 0,
      activeRequests: 0,
      lastHealthCheck: Date.now(),
      failureCount: 0
    })
  }

  /**
   * Remove a backend from the pool.
   */
  removeBackend(serverId: string): void {
    this.backends.delete(serverId)
    this.refusedOffDevice.delete(serverId)
  }

  /**
   * Get the next healthy backend for request routing.
   * Uses weighted round-robin: prefers backends with lower latency and fewer active requests.
   */
  getNextBackend(): OllamaBackend | null {
    const healthy = Array.from(this.backends.values()).filter((b) => b.healthy)
    if (healthy.length === 0) return null

    // Sort by: fewest active requests, then lowest latency
    healthy.sort((a, b) => {
      const loadDiff = a.activeRequests - b.activeRequests
      if (loadDiff !== 0) return loadDiff
      return a.avgLatencyMs - b.avgLatencyMs
    })

    // Pick least-loaded backend (with round-robin tie-breaking)
    const index = this.roundRobinIndex % healthy.length
    this.roundRobinIndex++
    return healthy[index]
  }

  /**
   * Get the API URL for the next available backend.
   * Returns null if no healthy backends are available.
   */
  getNextUrl(): string | null {
    const backend = this.getNextBackend()
    if (!backend) return null

    const { server } = backend
    return validateBackendUrl(server.protocol, server.host, server.port)
  }

  /**
   * Mark a request as started (for active request tracking).
   */
  markRequestStart(serverId: string): void {
    const backend = this.backends.get(serverId)
    if (backend) {
      backend.activeRequests++
      this.totalRequests++
    }
  }

  /**
   * Mark a request as completed (with latency for adaptive routing).
   */
  markRequestEnd(serverId: string, latencyMs: number, success: boolean): void {
    const backend = this.backends.get(serverId)
    if (!backend) return

    backend.activeRequests = Math.max(0, backend.activeRequests - 1)

    if (success) {
      // Exponential moving average for latency
      backend.avgLatencyMs = backend.avgLatencyMs === 0
        ? latencyMs
        : backend.avgLatencyMs * 0.7 + latencyMs * 0.3
      backend.failureCount = 0
    } else {
      backend.failureCount++
      if (backend.failureCount >= OllamaLoadBalancer.MAX_FAILURES_BEFORE_UNHEALTHY) {
        backend.healthy = false
      }
    }
  }

  /**
   * Run health checks on all backends.
   */
  async healthCheck(): Promise<void> {
    const checks = Array.from(this.backends.values()).map(async (backend) => {
      const baseUrl = validateBackendUrl(backend.server.protocol, backend.server.host, backend.server.port)
      const url = `${baseUrl}/api/version`
      try {
        const controller = new AbortController()
        const timeout = setTimeout(
          () => controller.abort(),
          OllamaLoadBalancer.HEALTH_CHECK_TIMEOUT_MS
        )

        const response = await fetch(url, { signal: controller.signal })
        clearTimeout(timeout)

        if (response.ok) {
          backend.healthy = true
          backend.failureCount = 0
        } else {
          backend.failureCount++
          if (backend.failureCount >= OllamaLoadBalancer.MAX_FAILURES_BEFORE_UNHEALTHY) {
            backend.healthy = false
          }
        }
      } catch {
        backend.failureCount++
        if (backend.failureCount >= OllamaLoadBalancer.MAX_FAILURES_BEFORE_UNHEALTHY) {
          backend.healthy = false
        }
      }
      backend.lastHealthCheck = Date.now()
    })

    await Promise.allSettled(checks)
  }

  /**
   * Start periodic health checks.
   */
  startHealthChecks(): void {
    if (this.healthCheckInterval) return

    this.healthCheckInterval = setInterval(() => {
      this.healthCheck().catch((err) => {
        console.warn(`[LoadBalancer] health check failed: ${(err as Error).message}`)
      })
    }, OllamaLoadBalancer.HEALTH_CHECK_INTERVAL_MS)

    // Run initial check
    this.healthCheck().catch((err) => {
      console.warn(`[LoadBalancer] initial health check failed: ${(err as Error).message}`)
    })
  }

  /**
   * Stop periodic health checks.
   */
  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
  }

  /**
   * Get all backends with their status.
   */
  getBackends(): OllamaBackend[] {
    return Array.from(this.backends.values())
  }

  /**
   * Get load balancer statistics.
   */
  getStats(): LoadBalancerStats {
    const all = Array.from(this.backends.values())
    return {
      totalBackends: all.length,
      healthyBackends: all.filter((b) => b.healthy).length,
      totalRequests: this.totalRequests,
      activeRequests: all.reduce((sum, b) => sum + b.activeRequests, 0)
    }
  }

  /**
   * Check if load balancing is available (2+ healthy backends).
   */
  isBalancingAvailable(): boolean {
    return Array.from(this.backends.values()).filter((b) => b.healthy).length >= 2
  }

  /**
   * Shutdown the load balancer.
   */
  shutdown(): void {
    this.stopHealthChecks()
    this.backends.clear()
    this.refusedOffDevice.clear()
  }
}

// Singleton
let balancerInstance: OllamaLoadBalancer | null = null

export function getOllamaLoadBalancer(): OllamaLoadBalancer {
  if (!balancerInstance) {
    balancerInstance = new OllamaLoadBalancer()
  }
  return balancerInstance
}
