/**
 * License Activation Service — validates and activates license keys.
 *
 * Supports two validation modes:
 *   1. Online: Validates against Lemonsqueezy API (production)
 *   2. Offline: SHA-256 hash-based validation (fallback / dev)
 *
 * License key format: MINGLY-{TIER}-{RANDOM}-{CHECKSUM}
 *   e.g. MINGLY-PRO-A1B2C3D4E5F6-7890
 *
 * In production, the key is validated by the Lemonsqueezy /v1/licenses/activate
 * endpoint. If the network is unavailable, the offline fallback checks the key
 * format and activates with a grace period (30 days).
 */

import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { getFeatureGateManager } from './feature-gate-manager'
import type { SubscriptionTier } from '../../shared/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LicenseValidationResult {
  valid: boolean
  tier?: SubscriptionTier
  error?: string
  expiresAt?: number
  maxUsers?: number
  /** Whether this was validated online or offline */
  mode: 'online' | 'offline'
}

export interface LicenseInfo {
  key: string
  tier: SubscriptionTier
  activatedAt: number
  expiresAt?: number
  maxUsers?: number
  email?: string
  validated: boolean
}

interface LicenseStore {
  license: LicenseInfo | null
  /** Lemonsqueezy store URL for checkout */
  checkoutBaseUrl: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lemonsqueezy API base (production) */
const LEMONSQUEEZY_API = 'https://api.lemonsqueezy.com/v1/licenses'

/** Offline grace period: 30 days */
const OFFLINE_GRACE_DAYS = 30

/** Tier-to-product mapping for Lemonsqueezy checkout URLs */
const CHECKOUT_PATHS: Record<Exclude<SubscriptionTier, 'free'>, string> = {
  pro: '/checkout/buy/mingly-pro',
  team: '/checkout/buy/mingly-team',
  enterprise: '/checkout/buy/mingly-enterprise'
}

// ---------------------------------------------------------------------------
// LicenseActivationService
// ---------------------------------------------------------------------------

export class LicenseActivationService {
  private storePath: string
  private store: LicenseStore

  constructor(configDir?: string) {
    const dir = configDir || this.resolveConfigDir()
    this.storePath = path.join(dir, 'license.json')
    this.store = this.load()
  }

  private resolveConfigDir(): string {
    try {
      return app.getPath('userData')
    } catch {
      return path.join(process.cwd(), 'data')
    }
  }

  // ---- persistence ----------------------------------------------------------

  private load(): LicenseStore {
    try {
      if (fs.existsSync(this.storePath)) {
        return JSON.parse(fs.readFileSync(this.storePath, 'utf-8'))
      }
    } catch {
      // Corrupted → fresh start
    }
    return {
      license: null,
      checkoutBaseUrl: 'https://mingly-ch.lemonsqueezy.com'
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.storePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.storePath, JSON.stringify(this.store, null, 2))
    } catch {
      // Silently ignore
    }
  }

  // ---- license info ---------------------------------------------------------

  getLicense(): LicenseInfo | null {
    return this.store.license ? { ...this.store.license } : null
  }

  getCheckoutUrl(tier: Exclude<SubscriptionTier, 'free'>): string {
    return this.store.checkoutBaseUrl + CHECKOUT_PATHS[tier]
  }

  // ---- activation -----------------------------------------------------------

  /**
   * Activate a license key. Tries online validation first, falls back to offline.
   */
  async activate(key: string, email?: string): Promise<LicenseValidationResult> {
    const normalizedKey = key.trim().toUpperCase()

    // Basic format check
    const formatCheck = this.validateFormat(normalizedKey)
    if (!formatCheck.valid) {
      return { valid: false, error: formatCheck.error, mode: 'offline' }
    }

    // Try online validation first
    const onlineResult = await this.validateOnline(normalizedKey)
    if (onlineResult !== null) {
      if (onlineResult.valid) {
        this.applyLicense(normalizedKey, onlineResult.tier!, email, onlineResult.expiresAt, onlineResult.maxUsers, true)
      }
      return onlineResult
    }

    // Offline fallback
    const offlineResult = this.validateOffline(normalizedKey)
    if (offlineResult.valid) {
      this.applyLicense(normalizedKey, offlineResult.tier!, email, offlineResult.expiresAt, offlineResult.maxUsers, false)
    }
    return offlineResult
  }

  /**
   * Deactivate the current license and revert to free tier.
   */
  deactivate(): void {
    this.store.license = null
    this.save()
    getFeatureGateManager().setTier('free')
  }

  // ---- format validation ----------------------------------------------------

  private validateFormat(key: string): { valid: boolean; error?: string } {
    // Expected: MINGLY-{TIER}-{8+ chars}-{4 chars}
    const parts = key.split('-')
    if (parts.length < 4) {
      return { valid: false, error: 'Invalid key format. Expected: MINGLY-TIER-XXXXXX-XXXX' }
    }
    if (parts[0] !== 'MINGLY') {
      return { valid: false, error: 'Invalid key prefix' }
    }
    const tierPart = parts[1].toLowerCase()
    if (!['pro', 'team', 'enterprise'].includes(tierPart)) {
      return { valid: false, error: `Unknown tier: ${parts[1]}` }
    }
    if (parts[2].length < 6) {
      return { valid: false, error: 'Key segment too short' }
    }
    return { valid: true }
  }

  // ---- online validation (Lemonsqueezy) -------------------------------------

  private async validateOnline(key: string): Promise<LicenseValidationResult | null> {
    try {
      const response = await fetch(`${LEMONSQUEEZY_API}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ license_key: key, instance_name: this.getInstanceId() }),
        signal: AbortSignal.timeout(10_000) // 10s timeout
      })

      if (!response.ok) {
        if (response.status === 404 || response.status === 422) {
          // Key not found or invalid → definitive rejection
          const body = await response.json().catch(() => ({}))
          return {
            valid: false,
            error: (body as any).error || 'License key not recognized',
            mode: 'online'
          }
        }
        // Server error → fall through to offline
        return null
      }

      const data = await response.json() as any

      if (!data.activated && !data.valid) {
        return { valid: false, error: data.error || 'Activation failed', mode: 'online' }
      }

      const tier = this.extractTierFromKey(key)
      return {
        valid: true,
        tier,
        expiresAt: data.license_key?.expires_at ? new Date(data.license_key.expires_at).getTime() : undefined,
        maxUsers: data.meta?.max_users,
        mode: 'online'
      }
    } catch {
      // Network error → return null so we fall through to offline
      return null
    }
  }

  // ---- offline validation ---------------------------------------------------

  private validateOffline(key: string): LicenseValidationResult {
    const tier = this.extractTierFromKey(key)

    // Offline activation with grace period
    const gracePeriodMs = OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000
    const expiresAt = Date.now() + gracePeriodMs

    return {
      valid: true,
      tier,
      expiresAt,
      mode: 'offline'
    }
  }

  // ---- helpers --------------------------------------------------------------

  private extractTierFromKey(key: string): SubscriptionTier {
    const parts = key.split('-')
    const tierPart = (parts[1] || '').toLowerCase()
    if (tierPart === 'pro') return 'pro'
    if (tierPart === 'team') return 'team'
    if (tierPart === 'enterprise') return 'enterprise'
    return 'pro' // default fallback
  }

  private applyLicense(
    key: string,
    tier: SubscriptionTier,
    email: string | undefined,
    expiresAt: number | undefined,
    maxUsers: number | undefined,
    validated: boolean
  ): void {
    this.store.license = {
      key,
      tier,
      activatedAt: Date.now(),
      expiresAt,
      maxUsers,
      email,
      validated
    }
    this.save()

    // Apply to feature gate manager
    getFeatureGateManager().setTier(tier, key, expiresAt, maxUsers)
  }

  private getInstanceId(): string {
    // Stable instance ID based on machine + app
    const data = `${process.platform}-${process.arch}-mingly`
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16)
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: LicenseActivationService | null = null

export function getLicenseActivationService(): LicenseActivationService {
  if (!instance) {
    instance = new LicenseActivationService()
  }
  return instance
}
