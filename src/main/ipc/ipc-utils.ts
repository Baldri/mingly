/**
 * IPC Utilities — shared helpers for all IPC handler modules.
 */

import { ipcMain } from 'electron'
import { getRateLimiter } from '../security/rate-limiter'
import { getRBACManager } from '../security/rbac-manager'
import { getFeatureGateManager } from '../services/feature-gate-manager'
import { getProviderRegistry } from '../routing/provider-registry'

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
/** Built-ins are explicit so a registry change cannot lock a user out of them. */
const BUILT_IN_PROVIDERS = ['anthropic', 'openai', 'google', 'local']

/**
 * May this provider hold credentials?
 *
 * This gates both saving an API key and loading one back at startup. It used
 * to be the four names above and nothing else, so a provider the user had
 * just configured — the Swiss endpoint, say — could not hold a token, and the
 * settings field for it failed silently.
 *
 * The rule is now earned rather than enumerated: a provider qualifies by
 * being in the provider registry. That covers endpoints we registered and
 * endpoints a tenant added (bring-your-own-key is the point of those), while
 * an arbitrary string still cannot reach the keychain. Invariant I2 governs
 * what such an endpoint may CLAIM about its residency — a separate question
 * from whether the user may store a key for it.
 */
export function validateProvider(provider: string): boolean {
  if (BUILT_IN_PROVIDERS.includes(provider)) return true
  if (!provider) return false
  return getProviderRegistry().get(provider) !== undefined
}
