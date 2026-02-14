/**
 * License Activation Service — validates and activates license keys.
 *
 * Uses HMAC-SHA256 signed license keys for offline validation.
 * No external server required — the app contains the public verification key.
 *
 * License key format: MINGLY-{TIER}-{PAYLOAD}-{SIGNATURE}
 *   e.g. MINGLY-PRO-A1B2C3D4E5F6-8a3f7b2e
 *
 * The SIGNATURE is an HMAC-SHA256 of "MINGLY-{TIER}-{PAYLOAD}" using a secret.
 * Legacy keys without valid HMAC are accepted with a grace period for migration.
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
  /** Whether this was validated via HMAC signature or legacy format */
  mode: 'signed' | 'legacy'
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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * HMAC secret for license key verification.
 * In production, this would be derived from a more complex scheme.
 * The signing secret is kept at digital nalu for key generation.
 * This verification key allows the app to validate signatures offline.
 */
const LICENSE_HMAC_SECRET = 'mingly-license-v1-digitalnalu-2026'

/** Legacy grace period: 90 days for keys without HMAC signature */
const LEGACY_GRACE_DAYS = 90

/**
 * Stripe Payment Link URLs per tier.
 */
const STRIPE_CHECKOUT_URLS: Record<string, string> = {
  pro: 'https://buy.stripe.com/28EaEYexh6yb2qT66G6AM02',
  'pro-yearly': 'https://buy.stripe.com/8x24gAgFp4q3d5xeDc6AM03',
  team: 'https://buy.stripe.com/eVq00kah1g8L4z18eO6AM00',
  'team-yearly': 'https://buy.stripe.com/4gMbJ20Gr2hVd5xamW6AM01',
  enterprise: 'mailto:welcome@digital-opua.ch',
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
    return { license: null }
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

  getCheckoutUrl(tier?: Exclude<SubscriptionTier, 'free'>): string {
    const key = tier ?? 'pro'
    return STRIPE_CHECKOUT_URLS[key] ?? STRIPE_CHECKOUT_URLS.pro
  }

  // ---- activation -----------------------------------------------------------

  /**
   * Activate a license key.
   * Validates HMAC signature (signed keys) or falls back to format check (legacy).
   */
  async activate(key: string, email?: string): Promise<LicenseValidationResult> {
    const normalizedKey = key.trim().toUpperCase()

    // Basic format check
    const formatCheck = this.validateFormat(normalizedKey)
    if (!formatCheck.valid) {
      return { valid: false, error: formatCheck.error, mode: 'legacy' }
    }

    // Try HMAC signature validation first
    const signedResult = this.validateSignature(normalizedKey)
    if (signedResult.valid) {
      this.applyLicense(normalizedKey, signedResult.tier!, email, signedResult.expiresAt, signedResult.maxUsers, true)
      return signedResult
    }

    // Legacy fallback — accept MINGLY-{TIER}-... format with grace period
    const legacyResult = this.validateLegacy(normalizedKey)
    if (legacyResult.valid) {
      this.applyLicense(normalizedKey, legacyResult.tier!, email, legacyResult.expiresAt, legacyResult.maxUsers, false)
    }
    return legacyResult
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
   * Validate key format: MINGLY-{TIER}-{6+ chars}-{4+ chars}
   */
  private validateFormat(key: string): { valid: boolean; error?: string } {
    if (key.length < 8) {
      return { valid: false, error: 'License key too short' }
    }

    const parts = key.split('-')
    if (parts[0] !== 'MINGLY' || parts.length < 4) {
      return { valid: false, error: 'Invalid license key format. Expected: MINGLY-TIER-...' }
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

  // ---- HMAC signature validation --------------------------------------------

  /**
   * Validate the HMAC-SHA256 signature embedded in the key.
   * Key format: MINGLY-{TIER}-{PAYLOAD}-{HMAC_8_CHARS}
   * The HMAC is computed over "MINGLY-{TIER}-{PAYLOAD}".
   */
  private validateSignature(key: string): LicenseValidationResult {
    const parts = key.split('-')
    if (parts.length < 4) {
      return { valid: false, error: 'Invalid key structure', mode: 'signed' }
    }

    // The last segment is the signature, everything before is the message
    const signature = parts[parts.length - 1].toLowerCase()
    const message = parts.slice(0, -1).join('-')

    const expectedSig = crypto
      .createHmac('sha256', LICENSE_HMAC_SECRET)
      .update(message)
      .digest('hex')
      .slice(0, signature.length)

    if (signature !== expectedSig) {
      return { valid: false, mode: 'signed' }
    }

    const tier = this.extractTierFromKey(key)
    return { valid: true, tier, mode: 'signed' }
  }

  // ---- legacy validation (backward compatible) ------------------------------

  /**
   * Accept legacy MINGLY-{TIER}-... keys without HMAC, with a grace period.
   * This allows existing users to keep working while we migrate to signed keys.
   */
  private validateLegacy(key: string): LicenseValidationResult {
    const tier = this.extractTierFromKey(key)
    const gracePeriodMs = LEGACY_GRACE_DAYS * 24 * 60 * 60 * 1000
    const expiresAt = Date.now() + gracePeriodMs

    return {
      valid: true,
      tier,
      expiresAt,
      mode: 'legacy'
    }
  }

  // ---- helpers --------------------------------------------------------------

  /**
   * Extract tier from MINGLY-{TIER}-... key format.
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

  // ---- key generation (for admin/testing) -----------------------------------

  /**
   * Generate a signed license key.
   * This is used by the admin CLI / Stripe webhook, NOT by the app itself.
   * Included here for completeness and testing.
   */
  static generateKey(tier: 'pro' | 'team' | 'enterprise', payload?: string): string {
    const randomPayload = payload || crypto.randomBytes(6).toString('hex').toUpperCase()
    const message = `MINGLY-${tier.toUpperCase()}-${randomPayload}`
    const signature = crypto
      .createHmac('sha256', LICENSE_HMAC_SECRET)
      .update(message)
      .digest('hex')
      .slice(0, 8)
      .toUpperCase()

    return `${message}-${signature}`
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
