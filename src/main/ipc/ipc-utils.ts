/**
 * IPC Utilities — shared helpers for all IPC handler modules.
 */

import { ipcMain } from 'electron'
import { getRateLimiter } from '../security/rate-limiter'
import { getRBACManager } from '../security/rbac-manager'
import { getFeatureGateManager } from '../services/feature-gate-manager'

/**
 * Wrap an IPC handler with consistent error handling + rate limiting.
 */
export function wrapHandler<T extends any[]>(
  channel: string,
  handler: (...args: T) => Promise<any> | any
): void {
  ipcMain.handle(channel, async (_event, ...args: any[]) => {
    const rateLimiter = getRateLimiter()
    const rateResult = rateLimiter.check(channel)
    if (!rateResult.allowed) {
      console.warn(`[IPC] Rate limit exceeded for ${channel}`)
      return { success: false, error: 'Rate limit exceeded. Please try again later.', retryAfterMs: rateResult.retryAfterMs }
    }

    try {
      return await handler(...(args as unknown as T))
    } catch (error) {
      console.error(`[IPC] ${channel} failed:`, (error as Error).message)
      return { success: false, error: (error as Error).message }
    }
  })
}

/**
 * Enforce RBAC permission check. Throws if denied.
 */
export function requirePermission(permissionId: string): void {
  const rbac = getRBACManager()
  if (!rbac.hasPermission(permissionId)) {
    throw new Error(`Access denied: missing permission '${permissionId}'`)
  }
}

/**
 * Enforce feature gate check. Throws if the current tier doesn't include the feature.
 */
export function requireFeature(feature: string): void {
  const gate = getFeatureGateManager()
  const result = gate.checkFeature(feature as any)
  if (!result.allowed) {
    throw new Error(`Feature '${feature}' requires ${result.requiredTier} plan. Please upgrade.`)
  }
}

/** Validate provider string is valid LLMProvider */
export function validateProvider(provider: string): boolean {
  return ['anthropic', 'openai', 'google', 'local'].includes(provider)
}
