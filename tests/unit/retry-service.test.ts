/**
 * RetryService Tests
 * Tests exponential backoff, max retries, retryable vs non-retryable errors, and callbacks.
 */

import { describe, it, expect, vi } from 'vitest'
import { executeWithRetry, isRetryableError, RetryService } from '../../src/main/services/retry-service'

describe('RetryService', () => {
  describe('isRetryableError', () => {
    it('should identify 429 rate limit errors', () => {
      expect(isRetryableError(new Error('HTTP 429 Too Many Requests'))).toBe(true)
    })

    it('should identify 503 service unavailable', () => {
      expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true)
    })

    it('should identify timeout errors', () => {
      expect(isRetryableError(new Error('Request timeout'))).toBe(true)
      expect(isRetryableError(new Error('TIMEOUT'))).toBe(true)
    })

    it('should identify ECONNRESET', () => {
      expect(isRetryableError(new Error('read ECONNRESET'))).toBe(true)
    })

    it('should identify ECONNREFUSED', () => {
      expect(isRetryableError(new Error('connect ECONNREFUSED'))).toBe(true)
    })

    it('should identify overloaded errors', () => {
      expect(isRetryableError(new Error('API is overloaded'))).toBe(true)
    })

    it('should not retry 400 bad request', () => {
      expect(isRetryableError(new Error('400 Bad Request'))).toBe(false)
    })

    it('should not retry 401 unauthorized', () => {
      expect(isRetryableError(new Error('401 Unauthorized - Invalid API key'))).toBe(false)
    })

    it('should not retry generic errors', () => {
      expect(isRetryableError(new Error('Something went wrong'))).toBe(false)
    })
  })

  describe('executeWithRetry', () => {
    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('success')
      const result = await executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
      expect(result).toBe('success')
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('should retry on retryable error and succeed', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('429 Rate Limited'))
        .mockResolvedValue('success after retry')

      const result = await executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
      expect(result).toBe('success after retry')
      expect(fn).toHaveBeenCalledTimes(2)
    })

    it('should throw after max retries exhausted', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'))

      await expect(
        executeWithRetry(fn, { maxRetries: 2, baseDelayMs: 10 })
      ).rejects.toThrow('503')

      expect(fn).toHaveBeenCalledTimes(3) // initial + 2 retries
    })

    it('should not retry non-retryable errors', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('401 Unauthorized'))

      await expect(
        executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
      ).rejects.toThrow('401')

      expect(fn).toHaveBeenCalledTimes(1) // no retries
    })

    it('should call onRetry callback', async () => {
      const onRetry = vi.fn()
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('429 Rate Limited'))
        .mockResolvedValue('ok')

      await executeWithRetry(fn, { maxRetries: 3, baseDelayMs: 10, onRetry })

      expect(onRetry).toHaveBeenCalledOnce()
      expect(onRetry).toHaveBeenCalledWith(
        1, // attempt number
        expect.objectContaining({ message: '429 Rate Limited' }),
        expect.any(Number) // delay ms
      )
    })

    it('should respect maxDelayMs cap', async () => {
      const onRetry = vi.fn()
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('429'))
        .mockRejectedValueOnce(new Error('429'))
        .mockRejectedValueOnce(new Error('429'))
        .mockResolvedValue('ok')

      await executeWithRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 10000,
        maxDelayMs: 100,
        multiplier: 10,
        onRetry
      })

      // All delays should be capped at maxDelayMs
      for (const call of onRetry.mock.calls) {
        expect(call[2]).toBeLessThanOrEqual(100)
      }
    })
  })

  describe('RetryService class', () => {
    it('should execute with configured options', async () => {
      const service = new RetryService({ maxRetries: 1, baseDelayMs: 10 })
      const fn = vi.fn().mockResolvedValue(42)

      const result = await service.execute(fn)
      expect(result).toBe(42)
    })

    it('should allow per-call overrides', async () => {
      const service = new RetryService({ maxRetries: 0, baseDelayMs: 10 })
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error('429'))
        .mockResolvedValue('ok')

      // Override maxRetries for this call
      const result = await service.execute(fn, { maxRetries: 1 })
      expect(result).toBe('ok')
      expect(fn).toHaveBeenCalledTimes(2)
    })
  })
})
