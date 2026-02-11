/**
 * Rate Limiter — Sliding Window Counter for IPC Handlers
 *
 * Prevents abuse through:
 * - Per-handler rate limits (configurable)
 * - Global rate limit across all handlers
 * - Automatic cleanup of expired windows
 *
 * Uses a sliding window counter algorithm (O(1) per check).
 */

// ============================================================
// Types
// ============================================================

export interface RateLimitConfig {
  /** Max requests in the window */
  maxRequests: number
  /** Window size in milliseconds */
  windowMs: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs?: number
}

// ============================================================
// Default Limits
// ============================================================

/** Default rate limits per handler category */
export const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  // LLM calls — expensive, rate-limited by providers too
  'llm:send-message': { maxRequests: 20, windowMs: 60_000 },   // 20/min
  'llm:stream-message': { maxRequests: 20, windowMs: 60_000 },

  // API key operations — low frequency
  'keys:save': { maxRequests: 10, windowMs: 60_000 },
  'keys:delete': { maxRequests: 10, windowMs: 60_000 },

  // RAG operations — can be expensive
  'rag:index-document': { maxRequests: 50, windowMs: 60_000 },  // 50/min
  'rag:index-file': { maxRequests: 30, windowMs: 60_000 },
  'rag:search': { maxRequests: 60, windowMs: 60_000 },

  // MCP tool execution — arbitrary external calls
  'mcp:execute-tool': { maxRequests: 30, windowMs: 60_000 },

  // Integration operations
  'integration:slack-configure': { maxRequests: 5, windowMs: 60_000 },
  'integration:notion-configure': { maxRequests: 5, windowMs: 60_000 },
  'integration:slack-index-to-rag': { maxRequests: 3, windowMs: 300_000 },  // 3 per 5 min

  // File operations
  'file-access:read': { maxRequests: 100, windowMs: 60_000 },
  'file-access:create': { maxRequests: 30, windowMs: 60_000 },

  // Export (can be resource-intensive)
  'export:conversation': { maxRequests: 10, windowMs: 60_000 },
  'export:gdpr-data': { maxRequests: 3, windowMs: 300_000 },

  // RBAC — admin operations
  'rbac:add-user': { maxRequests: 20, windowMs: 60_000 },
  'rbac:remove-user': { maxRequests: 10, windowMs: 60_000 }
}

/** Global limit across all handlers */
const GLOBAL_LIMIT: RateLimitConfig = {
  maxRequests: 500,
  windowMs: 60_000  // 500 total requests/min
}

// ============================================================
// Rate Limiter
// ============================================================

interface WindowEntry {
  count: number
  windowStart: number
}

export class RateLimiter {
  private windows: Map<string, WindowEntry> = new Map()
  private globalWindow: WindowEntry = { count: 0, windowStart: Date.now() }
  private customLimits: Map<string, RateLimitConfig> = new Map()
  private cleanupInterval: ReturnType<typeof setInterval>

  constructor() {
    // Clean up expired windows every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 300_000)
  }

  /**
   * Check if a request to `channel` is allowed.
   * Returns result with remaining quota and retry hint.
   */
  check(channel: string): RateLimitResult {
    const now = Date.now()

    // Global rate check
    if (now - this.globalWindow.windowStart >= GLOBAL_LIMIT.windowMs) {
      this.globalWindow = { count: 0, windowStart: now }
    }
    if (this.globalWindow.count >= GLOBAL_LIMIT.maxRequests) {
      const retryAfterMs = GLOBAL_LIMIT.windowMs - (now - this.globalWindow.windowStart)
      return { allowed: false, remaining: 0, retryAfterMs }
    }

    // Per-handler rate check
    const limit = this.customLimits.get(channel) || DEFAULT_LIMITS[channel]
    if (!limit) {
      // No limit configured — allow but count globally
      this.globalWindow.count++
      return { allowed: true, remaining: GLOBAL_LIMIT.maxRequests - this.globalWindow.count }
    }

    const entry = this.windows.get(channel)
    if (!entry || (now - entry.windowStart >= limit.windowMs)) {
      // New window
      this.windows.set(channel, { count: 1, windowStart: now })
      this.globalWindow.count++
      return { allowed: true, remaining: limit.maxRequests - 1 }
    }

    if (entry.count >= limit.maxRequests) {
      const retryAfterMs = limit.windowMs - (now - entry.windowStart)
      return { allowed: false, remaining: 0, retryAfterMs }
    }

    entry.count++
    this.globalWindow.count++
    return { allowed: true, remaining: limit.maxRequests - entry.count }
  }

  /**
   * Set custom rate limit for a channel
   */
  setLimit(channel: string, config: RateLimitConfig): void {
    this.customLimits.set(channel, config)
  }

  /**
   * Get current usage stats
   */
  getStats(): Record<string, { count: number; limit: number; windowMs: number }> {
    const stats: Record<string, { count: number; limit: number; windowMs: number }> = {}
    const now = Date.now()

    for (const [channel, entry] of this.windows) {
      const limit = this.customLimits.get(channel) || DEFAULT_LIMITS[channel]
      if (limit && (now - entry.windowStart < limit.windowMs)) {
        stats[channel] = {
          count: entry.count,
          limit: limit.maxRequests,
          windowMs: limit.windowMs
        }
      }
    }

    stats['__global__'] = {
      count: this.globalWindow.count,
      limit: GLOBAL_LIMIT.maxRequests,
      windowMs: GLOBAL_LIMIT.windowMs
    }

    return stats
  }

  /**
   * Reset all rate limit windows (for testing)
   */
  reset(): void {
    this.windows.clear()
    this.globalWindow = { count: 0, windowStart: Date.now() }
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [channel, entry] of this.windows) {
      const limit = this.customLimits.get(channel) || DEFAULT_LIMITS[channel]
      const windowMs = limit?.windowMs || 60_000
      if (now - entry.windowStart >= windowMs * 2) {
        this.windows.delete(channel)
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval)
  }
}

// Singleton
let instance: RateLimiter | null = null
export function getRateLimiter(): RateLimiter {
  if (!instance) instance = new RateLimiter()
  return instance
}
