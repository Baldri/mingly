/**
 * RetryService
 * Provides exponential backoff retry logic for LLM API calls.
 * Retryable errors: 429 (rate limit), 503 (service unavailable), timeout, ECONNRESET
 */

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  multiplier?: number
  onRetry?: (attempt: number, error: Error, delayMs: number) => void
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2
}

const RETRYABLE_PATTERNS = [
  /429/,           // Rate limit
  /503/,           // Service unavailable
  /timeout/i,      // Timeout
  /ECONNRESET/,    // Connection reset
  /ECONNREFUSED/,  // Connection refused (Ollama not running etc.)
  /overloaded/i,   // "overloaded" in error message
  /too many requests/i
]

export function isRetryableError(error: Error): boolean {
  const message = error.message || ''
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries, baseDelayMs, maxDelayMs, multiplier } = {
    ...DEFAULT_OPTIONS,
    ...options
  }

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error as Error

      // Don't retry if not a retryable error
      if (!isRetryableError(lastError)) {
        throw lastError
      }

      // Don't retry if we've exhausted all retries
      if (attempt >= maxRetries) {
        throw lastError
      }

      // Calculate delay with exponential backoff + jitter
      const exponentialDelay = baseDelayMs * Math.pow(multiplier, attempt)
      const jitter = Math.random() * baseDelayMs * 0.5
      const delayMs = Math.min(exponentialDelay + jitter, maxDelayMs)

      options.onRetry?.(attempt + 1, lastError, delayMs)

      await delay(delayMs)
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError || new Error('Retry exhausted')
}

export class RetryService {
  private options: RetryOptions

  constructor(options: RetryOptions = {}) {
    this.options = options
  }

  async execute<T>(fn: () => Promise<T>, overrides?: RetryOptions): Promise<T> {
    return executeWithRetry(fn, { ...this.options, ...overrides })
  }
}

let instance: RetryService | null = null

export function getRetryService(): RetryService {
  if (!instance) {
    instance = new RetryService()
  }
  return instance
}
