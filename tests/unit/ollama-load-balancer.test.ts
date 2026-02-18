/**
 * Tests for OllamaLoadBalancer — Multi-backend routing for local network Ollama instances.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { OllamaLoadBalancer } from '../../src/main/network/ollama-load-balancer'
import type { NetworkAIServerConfig } from '../../src/shared/network-ai-types'

// ── Test helpers ───────────────────────────────────────────────

function makeServer(overrides: Partial<NetworkAIServerConfig> = {}): NetworkAIServerConfig {
  return {
    id: `server-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Test Ollama',
    type: 'ollama',
    protocol: 'http',
    host: 'localhost',
    port: 11434,
    apiKeyRequired: false,
    isLocal: true,
    isLAN: false,
    tlsVerify: false,
    allowSelfSigned: false,
    ...overrides
  } as NetworkAIServerConfig
}

// ── Tests ──────────────────────────────────────────────────────

describe('OllamaLoadBalancer', () => {
  let balancer: OllamaLoadBalancer

  beforeEach(() => {
    balancer = new OllamaLoadBalancer()
  })

  afterEach(() => {
    balancer.shutdown()
  })

  describe('addBackend / removeBackend', () => {
    it('should add an Ollama backend', () => {
      const server = makeServer()
      balancer.addBackend(server)

      expect(balancer.getBackends()).toHaveLength(1)
      expect(balancer.getBackends()[0].server.id).toBe(server.id)
      expect(balancer.getBackends()[0].healthy).toBe(true)
    })

    it('should ignore non-ollama servers', () => {
      const server = makeServer({ type: 'openai-compatible' })
      balancer.addBackend(server)

      expect(balancer.getBackends()).toHaveLength(0)
    })

    it('should remove a backend by serverId', () => {
      const server = makeServer()
      balancer.addBackend(server)
      expect(balancer.getBackends()).toHaveLength(1)

      balancer.removeBackend(server.id)
      expect(balancer.getBackends()).toHaveLength(0)
    })

    it('should handle removing non-existent backend gracefully', () => {
      expect(() => balancer.removeBackend('non-existent')).not.toThrow()
    })
  })

  describe('getNextBackend', () => {
    it('should return null when no backends exist', () => {
      expect(balancer.getNextBackend()).toBeNull()
    })

    it('should return the only backend when one exists', () => {
      const server = makeServer()
      balancer.addBackend(server)

      const backend = balancer.getNextBackend()
      expect(backend).not.toBeNull()
      expect(backend!.server.id).toBe(server.id)
    })

    it('should skip unhealthy backends', () => {
      const server1 = makeServer({ id: 'healthy-1' })
      const server2 = makeServer({ id: 'unhealthy-1' })
      balancer.addBackend(server1)
      balancer.addBackend(server2)

      // Mark server2 as unhealthy via repeated failures
      for (let i = 0; i < 3; i++) {
        balancer.markRequestEnd('unhealthy-1', 0, false)
      }

      // Should only return the healthy one
      const backend = balancer.getNextBackend()
      expect(backend!.server.id).toBe('healthy-1')
    })

    it('should prefer backends with fewer active requests', () => {
      const server1 = makeServer({ id: 'busy', host: '192.168.1.10' })
      const server2 = makeServer({ id: 'idle', host: '192.168.1.11' })
      balancer.addBackend(server1)
      balancer.addBackend(server2)

      // Make server1 busy
      balancer.markRequestStart('busy')
      balancer.markRequestStart('busy')
      balancer.markRequestStart('busy')

      // First pick should be the idle server
      const backend = balancer.getNextBackend()
      expect(backend!.server.id).toBe('idle')
    })

    it('should prefer lower latency backends when load is equal', () => {
      const server1 = makeServer({ id: 'slow' })
      const server2 = makeServer({ id: 'fast' })
      balancer.addBackend(server1)
      balancer.addBackend(server2)

      // Give server1 high latency
      balancer.markRequestStart('slow')
      balancer.markRequestEnd('slow', 500, true)
      // Give server2 low latency
      balancer.markRequestStart('fast')
      balancer.markRequestEnd('fast', 50, true)

      const backend = balancer.getNextBackend()
      expect(backend!.server.id).toBe('fast')
    })

    it('should return null when all backends are unhealthy', () => {
      const server = makeServer({ id: 'down' })
      balancer.addBackend(server)

      // Fail 3 times to mark unhealthy
      for (let i = 0; i < 3; i++) {
        balancer.markRequestEnd('down', 0, false)
      }

      expect(balancer.getNextBackend()).toBeNull()
    })
  })

  describe('getNextUrl', () => {
    it('should return null when no backends exist', () => {
      expect(balancer.getNextUrl()).toBeNull()
    })

    it('should return the formatted URL', () => {
      const server = makeServer({ protocol: 'http', host: '192.168.1.42', port: 11434 })
      balancer.addBackend(server)

      expect(balancer.getNextUrl()).toBe('http://192.168.1.42:11434')
    })
  })

  describe('markRequestStart / markRequestEnd', () => {
    it('should track active requests', () => {
      const server = makeServer({ id: 'tracker' })
      balancer.addBackend(server)

      balancer.markRequestStart('tracker')
      expect(balancer.getBackends()[0].activeRequests).toBe(1)

      balancer.markRequestStart('tracker')
      expect(balancer.getBackends()[0].activeRequests).toBe(2)

      balancer.markRequestEnd('tracker', 100, true)
      expect(balancer.getBackends()[0].activeRequests).toBe(1)
    })

    it('should not go below 0 active requests', () => {
      const server = makeServer({ id: 'edge' })
      balancer.addBackend(server)

      balancer.markRequestEnd('edge', 100, true)
      expect(balancer.getBackends()[0].activeRequests).toBe(0)
    })

    it('should track latency with exponential moving average', () => {
      const server = makeServer({ id: 'latency' })
      balancer.addBackend(server)

      // First request sets latency directly
      balancer.markRequestStart('latency')
      balancer.markRequestEnd('latency', 100, true)
      expect(balancer.getBackends()[0].avgLatencyMs).toBe(100)

      // Second request blends: 100*0.7 + 200*0.3 = 130
      balancer.markRequestStart('latency')
      balancer.markRequestEnd('latency', 200, true)
      expect(balancer.getBackends()[0].avgLatencyMs).toBeCloseTo(130, 0)
    })

    it('should increment failure count on failed requests', () => {
      const server = makeServer({ id: 'failing' })
      balancer.addBackend(server)

      balancer.markRequestEnd('failing', 0, false)
      expect(balancer.getBackends()[0].failureCount).toBe(1)
      expect(balancer.getBackends()[0].healthy).toBe(true) // Not yet unhealthy

      balancer.markRequestEnd('failing', 0, false)
      balancer.markRequestEnd('failing', 0, false)
      expect(balancer.getBackends()[0].healthy).toBe(false) // 3 failures → unhealthy
    })

    it('should reset failure count on success', () => {
      const server = makeServer({ id: 'recovering' })
      balancer.addBackend(server)

      balancer.markRequestEnd('recovering', 0, false)
      balancer.markRequestEnd('recovering', 0, false)
      expect(balancer.getBackends()[0].failureCount).toBe(2)

      // Successful request resets count
      balancer.markRequestStart('recovering')
      balancer.markRequestEnd('recovering', 100, true)
      expect(balancer.getBackends()[0].failureCount).toBe(0)
    })

    it('should track total requests', () => {
      const server = makeServer({ id: 'total' })
      balancer.addBackend(server)

      balancer.markRequestStart('total')
      balancer.markRequestStart('total')
      balancer.markRequestStart('total')

      expect(balancer.getStats().totalRequests).toBe(3)
    })

    it('should handle marking unknown serverId gracefully', () => {
      expect(() => balancer.markRequestStart('unknown')).not.toThrow()
      expect(() => balancer.markRequestEnd('unknown', 100, true)).not.toThrow()
    })
  })

  describe('healthCheck', () => {
    it('should mark healthy backends on successful fetch', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

      const server = makeServer({ id: 'health-ok' })
      balancer.addBackend(server)

      await balancer.healthCheck()

      expect(balancer.getBackends()[0].healthy).toBe(true)
      expect(balancer.getBackends()[0].failureCount).toBe(0)

      vi.unstubAllGlobals()
    })

    it('should increment failure count on non-ok response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))

      const server = makeServer({ id: 'health-fail' })
      balancer.addBackend(server)

      await balancer.healthCheck()
      expect(balancer.getBackends()[0].failureCount).toBe(1)
      expect(balancer.getBackends()[0].healthy).toBe(true) // Still healthy after 1 failure

      vi.unstubAllGlobals()
    })

    it('should increment failure count on fetch error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')))

      const server = makeServer({ id: 'health-error' })
      balancer.addBackend(server)

      await balancer.healthCheck()
      expect(balancer.getBackends()[0].failureCount).toBe(1)

      vi.unstubAllGlobals()
    })

    it('should mark backend unhealthy after 3 consecutive failures', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Down')))

      const server = makeServer({ id: 'health-down' })
      balancer.addBackend(server)

      await balancer.healthCheck()
      await balancer.healthCheck()
      await balancer.healthCheck()

      expect(balancer.getBackends()[0].healthy).toBe(false)
      expect(balancer.getBackends()[0].failureCount).toBe(3)

      vi.unstubAllGlobals()
    })

    it('should recover a backend when health check succeeds', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const server = makeServer({ id: 'health-recover' })
      balancer.addBackend(server)

      // 3 failures → unhealthy
      fetchMock.mockRejectedValue(new Error('Down'))
      await balancer.healthCheck()
      await balancer.healthCheck()
      await balancer.healthCheck()
      expect(balancer.getBackends()[0].healthy).toBe(false)

      // Recovery
      fetchMock.mockResolvedValue({ ok: true })
      await balancer.healthCheck()
      expect(balancer.getBackends()[0].healthy).toBe(true)
      expect(balancer.getBackends()[0].failureCount).toBe(0)

      vi.unstubAllGlobals()
    })

    it('should update lastHealthCheck timestamp', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

      const server = makeServer({ id: 'health-ts' })
      balancer.addBackend(server)

      const before = Date.now()
      await balancer.healthCheck()
      const after = Date.now()

      expect(balancer.getBackends()[0].lastHealthCheck).toBeGreaterThanOrEqual(before)
      expect(balancer.getBackends()[0].lastHealthCheck).toBeLessThanOrEqual(after)

      vi.unstubAllGlobals()
    })
  })

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const server1 = makeServer({ id: 'stat-1' })
      const server2 = makeServer({ id: 'stat-2' })
      balancer.addBackend(server1)
      balancer.addBackend(server2)

      balancer.markRequestStart('stat-1')
      balancer.markRequestStart('stat-1')
      balancer.markRequestStart('stat-2')

      const stats = balancer.getStats()
      expect(stats.totalBackends).toBe(2)
      expect(stats.healthyBackends).toBe(2)
      expect(stats.totalRequests).toBe(3)
      expect(stats.activeRequests).toBe(3)
    })

    it('should count unhealthy backends correctly', () => {
      const server1 = makeServer({ id: 'stat-healthy' })
      const server2 = makeServer({ id: 'stat-unhealthy' })
      balancer.addBackend(server1)
      balancer.addBackend(server2)

      // Make server2 unhealthy
      for (let i = 0; i < 3; i++) {
        balancer.markRequestEnd('stat-unhealthy', 0, false)
      }

      const stats = balancer.getStats()
      expect(stats.totalBackends).toBe(2)
      expect(stats.healthyBackends).toBe(1)
    })
  })

  describe('isBalancingAvailable', () => {
    it('should return false with 0 backends', () => {
      expect(balancer.isBalancingAvailable()).toBe(false)
    })

    it('should return false with 1 healthy backend', () => {
      balancer.addBackend(makeServer())
      expect(balancer.isBalancingAvailable()).toBe(false)
    })

    it('should return true with 2+ healthy backends', () => {
      balancer.addBackend(makeServer({ id: 'lb-1' }))
      balancer.addBackend(makeServer({ id: 'lb-2' }))
      expect(balancer.isBalancingAvailable()).toBe(true)
    })

    it('should return false if only 1 of 2 is healthy', () => {
      balancer.addBackend(makeServer({ id: 'lb-healthy' }))
      balancer.addBackend(makeServer({ id: 'lb-down' }))

      for (let i = 0; i < 3; i++) {
        balancer.markRequestEnd('lb-down', 0, false)
      }

      expect(balancer.isBalancingAvailable()).toBe(false)
    })
  })

  describe('startHealthChecks / stopHealthChecks', () => {
    it('should not crash when starting/stopping', () => {
      balancer.addBackend(makeServer())

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

      expect(() => balancer.startHealthChecks()).not.toThrow()
      expect(() => balancer.stopHealthChecks()).not.toThrow()

      vi.unstubAllGlobals()
    })

    it('should not start multiple intervals', () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

      balancer.startHealthChecks()
      balancer.startHealthChecks() // Should be a no-op

      balancer.stopHealthChecks()

      vi.unstubAllGlobals()
    })
  })

  describe('shutdown', () => {
    it('should clear all backends and stop health checks', () => {
      balancer.addBackend(makeServer({ id: 'shutdown-1' }))
      balancer.addBackend(makeServer({ id: 'shutdown-2' }))
      expect(balancer.getBackends()).toHaveLength(2)

      balancer.shutdown()

      expect(balancer.getBackends()).toHaveLength(0)
      expect(balancer.getStats().totalBackends).toBe(0)
    })
  })
})
