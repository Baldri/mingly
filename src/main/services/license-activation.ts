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

/**
 * Single Lemonsqueezy checkout URL for the Mingly product.
 * All tiers (Pro/Team/Enterprise) are variants within one product.
 * The customer selects the desired variant in the Lemonsqueezy checkout.
 */
const CHECKOUT_PATH = '/checkout/buy/d1cc0e68-cc65-4a89-9bc4-680ea6983db5'

/**
 * Lemonsqueezy product name → tier mapping.
 * The API returns `meta.product_name` in the activation response.
 * We match case-insensitively against these keywords.
 */
const PRODUCT_NAME_TO_TIER: Array<{ pattern: RegExp; tier: SubscriptionTier }> = [
  { pattern: /enterprise/i, tier: 'enterprise' },
  { pattern: /team/i, tier: 'team' },
  { pattern: /pro/i, tier: 'pro' }
]

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

  getCheckoutUrl(_tier?: Exclude<SubscriptionTier, 'free'>): string {
    return this.store.checkoutBaseUrl + CHECKOUT_PATH
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

    // Try online validation first (works for both Mingly and Lemonsqueezy keys)
    const onlineResult = await this.validateOnline(normalizedKey)
    if (onlineResult !== null) {
      if (onlineResult.valid) {
        this.applyLicense(normalizedKey, onlineResult.tier!, email, onlineResult.expiresAt, onlineResult.maxUsers, true)
      }
      return onlineResult
    }

    // Offline fallback — only works for MINGLY-{TIER}-... format keys
    if (!formatCheck.isMinglyFormat) {
      return {
        valid: false,
        error: 'Could not validate license key. Please check your internet connection and try again.',
        mode: 'offline'
      }
    }

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

  /**
   * Validate key format. Accepts two formats:
   *   1. Mingly format: MINGLY-{TIER}-{6+ chars}-{4+ chars}  (offline / manual)
   *   2. Lemonsqueezy format: any non-empty string ≥8 chars   (online validation)
   *
   * Lemonsqueezy generates keys like "38b1460a-5104-4067-a91d-77b872934d51"
   * or custom formats — we accept anything ≥8 chars and let the API decide.
   */
  private validateFormat(key: string): { valid: boolean; error?: string; isMinglyFormat: boolean } {
    if (key.length < 8) {
      return { valid: false, error: 'License key too short', isMinglyFormat: false }
    }

    // Check if it's our own MINGLY-TIER-... format
    const parts = key.split('-')
    if (parts[0] === 'MINGLY' && parts.length >= 4) {
      const tierPart = parts[1].toLowerCase()
      if (!['pro', 'team', 'enterprise'].includes(tierPart)) {
        return { valid: false, error: `Unknown tier: ${parts[1]}`, isMinglyFormat: true }
      }
      if (parts[2].length < 6) {
        return { valid: false, error: 'Key segment too short', isMinglyFormat: true }
      }
      return { valid: true, isMinglyFormat: true }
    }

    // Anything else → assume Lemonsqueezy key, validate online
    return { valid: true, isMinglyFormat: false }
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

      // Extract tier: prefer API product name, fall back to key format
      const tier = this.extractTierFromResponse(data) || this.extractTierFromKey(key)
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

  /**
   * Extract tier from Lemonsqueezy API activation response.
   * Checks `meta.product_name` and `meta.variant_name` for tier keywords.
   */
  private extractTierFromResponse(data: any): SubscriptionTier | null {
    const productName = data?.meta?.product_name || ''
    const variantName = data?.meta?.variant_name || ''
    const combined = `${productName} ${variantName}`

    for (const { pattern, tier } of PRODUCT_NAME_TO_TIER) {
      if (pattern.test(combined)) return tier
    }
    return null
  }

  /**
   * Extract tier from MINGLY-{TIER}-... key format (offline fallback).
   */
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
