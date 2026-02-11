import { describe, it, expect, beforeEach } from 'vitest'
import { RateLimiter } from '../../src/main/security/rate-limiter'

describe('RateLimiter', () => {
  let limiter: RateLimiter

  beforeEach(() => {
    limiter = new RateLimiter()
  })

  afterEach(() => {
    limiter.destroy()
  })

  describe('check()', () => {
    it('should allow requests within the rate limit', () => {
      const result = limiter.check('llm:send-message')
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(19) // 20 max - 1
    })

    it('should deny requests exceeding per-handler limit', () => {
      // Set a very low custom limit for testing
      limiter.setLimit('test-channel', { maxRequests: 2, windowMs: 60_000 })

      const r1 = limiter.check('test-channel')
      expect(r1.allowed).toBe(true)
      expect(r1.remaining).toBe(1)

      const r2 = limiter.check('test-channel')
      expect(r2.allowed).toBe(true)
      expect(r2.remaining).toBe(0)

      const r3 = limiter.check('test-channel')
      expect(r3.allowed).toBe(false)
      expect(r3.remaining).toBe(0)
      expect(r3.retryAfterMs).toBeGreaterThan(0)
    })

    it('should allow unknown channels (no per-handler limit) but count globally', () => {
      const result = limiter.check('unknown:channel')
      expect(result.allowed).toBe(true)
    })

    it('should track global rate limit across all handlers', () => {
      // Set global limit very low for testing
      limiter.setLimit('__test_global_sim__', { maxRequests: 1, windowMs: 60_000 })

      // Just verify multiple different channels increment
      limiter.check('llm:send-message')
      limiter.check('rag:search')
      const stats = limiter.getStats()
      expect(stats['__global__'].count).toBeGreaterThanOrEqual(2)
    })
  })

  describe('getStats()', () => {
    it('should return usage stats with global entry', () => {
      limiter.check('llm:send-message')
      limiter.check('llm:send-message')

      const stats = limiter.getStats()
      expect(stats['__global__']).toBeDefined()
      expect(stats['__global__'].count).toBeGreaterThanOrEqual(2)
      expect(stats['llm:send-message']).toBeDefined()
      expect(stats['llm:send-message'].count).toBe(2)
    })
  })

  describe('reset()', () => {
    it('should clear all rate limit windows', () => {
      limiter.setLimit('test', { maxRequests: 1, windowMs: 60_000 })
      limiter.check('test')

      const r1 = limiter.check('test')
      expect(r1.allowed).toBe(false)

      limiter.reset()

      const r2 = limiter.check('test')
      expect(r2.allowed).toBe(true)
    })
  })

  describe('setLimit()', () => {
    it('should override default limits with custom ones', () => {
      limiter.setLimit('llm:send-message', { maxRequests: 1, windowMs: 60_000 })

      const r1 = limiter.check('llm:send-message')
      expect(r1.allowed).toBe(true)

      const r2 = limiter.check('llm:send-message')
      expect(r2.allowed).toBe(false)
    })
  })
})
