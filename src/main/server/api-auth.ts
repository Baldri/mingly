// Pure, testable auth + CORS logic for the Mingly HTTP/WS API server.
// Extracted from mingly-api-server.ts so it can be unit-tested without pulling
// in the Electron/service-layer module graph.
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { MinglyServerConfig } from '../../shared/deployment-types'

/** Constant-time string compare — avoids a token timing oracle from `===`. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Authorize a request against the configured API key.
 *
 * Fails CLOSED: when auth is required but no apiKey is configured we DENY.
 * The previous implementation returned true in that case — an operator who
 * turned requireAuth on without setting a key got an unauthenticated open API.
 */
export function checkApiAuth(config: MinglyServerConfig, req: IncomingMessage): boolean {
  if (!config.requireAuth) return true
  if (!config.apiKey) return false
  const authHeader = req.headers['authorization']
  if (!authHeader) return false
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
  return safeEqual(token, config.apiKey)
}

/**
 * Apply CORS headers. Never a wildcard: reflect only a configured, matching
 * Origin (the config already documents "empty = same-origin only"). A
 * localhost API sending Access-Control-Allow-Origin:* lets any web page the
 * user visits read from and drive it.
 */
export function applyCorsHeaders(config: MinglyServerConfig, req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  const allowed = config.corsOrigins ?? []
  if (allowed.length === 0) return
  const origin = req.headers['origin']
  if (typeof origin === 'string' && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
}

/** Startup guard: refuse a required-auth server with no key (fail loud, not open). */
export function assertAuthConfig(config: MinglyServerConfig): void {
  if (config.requireAuth && !config.apiKey) {
    throw new Error(
      'Mingly API: requireAuth is enabled but no apiKey is configured — refusing ' +
        'to start (it would accept unauthenticated requests). Set apiKey or disable requireAuth.',
    )
  }
}
