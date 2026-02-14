/**
 * LicenseActivationService Tests
 * Tests HMAC-signed key validation, legacy format fallback,
 * activation flow, deactivation, and persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { LicenseActivationService } from '../../src/main/services/license-activation'

// Mock electron app
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-license') }
}))

// Mock feature gate manager
const mockSetTier = vi.fn()
vi.mock('../../src/main/services/feature-gate-manager', () => ({
  getFeatureGateManager: vi.fn(() => ({
    setTier: mockSetTier,
    getTier: vi.fn(() => 'free')
  }))
}))

describe('LicenseActivationService', () => {
  const testDir = '/tmp/test-license-' + Date.now()
  let service: LicenseActivationService

  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true })
    fs.mkdirSync(testDir, { recursive: true })
    service = new LicenseActivationService(testDir)
    mockSetTier.mockClear()
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true })
  })

  // ── Default state ──────────────────────────────────────────────

  describe('default state', () => {
    it('should have no license by default', () => {
      expect(service.getLicense()).toBeNull()
    })
  })

  // ── Key generation ─────────────────────────────────────────────

  describe('key generation', () => {
    it('should generate a valid signed PRO key', () => {
      const key = LicenseActivationService.generateKey('pro')
      expect(key).toMatch(/^MINGLY-PRO-[A-F0-9]+-[A-F0-9]{8}$/)
    })

    it('should generate a valid signed TEAM key', () => {
      const key = LicenseActivationService.generateKey('team')
      expect(key).toMatch(/^MINGLY-TEAM-[A-F0-9]+-[A-F0-9]{8}$/)
    })

    it('should generate a valid signed ENTERPRISE key', () => {
      const key = LicenseActivationService.generateKey('enterprise')
      expect(key).toMatch(/^MINGLY-ENTERPRISE-[A-F0-9]+-[A-F0-9]{8}$/)
    })

    it('should accept custom payload', () => {
      const key = LicenseActivationService.generateKey('pro', 'CUSTOM123456')
      expect(key).toContain('CUSTOM123456')
    })

    it('should generate unique keys', () => {
      const key1 = LicenseActivationService.generateKey('pro')
      const key2 = LicenseActivationService.generateKey('pro')
      expect(key1).not.toBe(key2)
    })
  })

  // ── Key format validation ─────────────────────────────────────

  describe('key format validation', () => {
    it('should reject empty key', async () => {
      const result = await service.activate('')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('short')
    })

    it('should reject very short key', async () => {
      const result = await service.activate('ABC')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('short')
    })

    it('should reject key without MINGLY prefix', async () => {
      const result = await service.activate('OTHER-PRO-ABCDEF1234-5678')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('format')
    })

    it('should reject MINGLY-format key with unknown tier', async () => {
      const result = await service.activate('MINGLY-PLATINUM-ABCD1234-5678')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('tier')
    })

    it('should reject MINGLY-format key with too-short segment', async () => {
      const result = await service.activate('MINGLY-PRO-AB-56')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('short')
    })
  })

  // ── HMAC-signed key activation ────────────────────────────────

  describe('signed key activation', () => {
    it('should activate a generated PRO key', async () => {
      const key = LicenseActivationService.generateKey('pro')
      const result = await service.activate(key)
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('pro')
      expect(result.mode).toBe('signed')
      // Signed keys have no expiry
      expect(result.expiresAt).toBeUndefined()
    })

    it('should activate a generated TEAM key', async () => {
      const key = LicenseActivationService.generateKey('team')
      const result = await service.activate(key)
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('team')
      expect(result.mode).toBe('signed')
    })

    it('should activate a generated ENTERPRISE key', async () => {
      const key = LicenseActivationService.generateKey('enterprise')
      const result = await service.activate(key)
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('enterprise')
      expect(result.mode).toBe('signed')
    })

    it('should call setTier on feature gate manager', async () => {
      const key = LicenseActivationService.generateKey('pro')
      await service.activate(key)
      expect(mockSetTier).toHaveBeenCalledWith(
        'pro',
        key.toUpperCase(),
        undefined,
        undefined
      )
    })

    it('should reject a key with forged signature', async () => {
      const result = await service.activate('MINGLY-PRO-ABCDEF123456-DEADBEEF')
      // DEADBEEF is not the correct HMAC → falls through to legacy
      expect(result.mode).toBe('legacy')
      // Legacy keys are still accepted with grace period
      expect(result.valid).toBe(true)
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    })
  })

  // ── Legacy key activation (backward compatible) ────────────────

  describe('legacy key activation', () => {
    it('should accept a legacy MINGLY-PRO key with grace period', async () => {
      const result = await service.activate('MINGLY-PRO-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('pro')
      expect(result.mode).toBe('legacy')
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    })

    it('should accept a legacy TEAM key with grace period', async () => {
      const result = await service.activate('MINGLY-TEAM-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('team')
    })

    it('should accept a legacy ENTERPRISE key with grace period', async () => {
      const result = await service.activate('MINGLY-ENTERPRISE-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('enterprise')
    })

    it('should set grace period expiry (~90 days)', async () => {
      const result = await service.activate('MINGLY-PRO-ABCDEF1234-5678')
      const ninetyDays = 90 * 24 * 60 * 60 * 1000
      expect(result.expiresAt).toBeGreaterThan(Date.now() + ninetyDays - 60_000)
      expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + ninetyDays + 60_000)
    })
  })

  // ── Normalization ──────────────────────────────────────────────

  describe('input normalization', () => {
    it('should normalize key to uppercase', async () => {
      const key = LicenseActivationService.generateKey('pro')
      const result = await service.activate(key.toLowerCase())
      expect(result.valid).toBe(true)
      expect(service.getLicense()!.key).toBe(key.toUpperCase())
    })

    it('should trim whitespace', async () => {
      const key = LicenseActivationService.generateKey('pro')
      const result = await service.activate(`  ${key}  `)
      expect(result.valid).toBe(true)
    })
  })

  // ── Deactivation ──────────────────────────────────────────────

  describe('deactivation', () => {
    beforeEach(async () => {
      const key = LicenseActivationService.generateKey('pro')
      await service.activate(key)
    })

    it('should clear license on deactivate', () => {
      expect(service.getLicense()).not.toBeNull()
      service.deactivate()
      expect(service.getLicense()).toBeNull()
    })

    it('should revert to free tier on deactivate', () => {
      service.deactivate()
      expect(mockSetTier).toHaveBeenLastCalledWith('free')
    })
  })

  // ── Persistence ───────────────────────────────────────────────

  describe('persistence', () => {
    it('should persist license to disk', async () => {
      const key = LicenseActivationService.generateKey('pro')
      await service.activate(key, 'test@example.com')
      const licenseFile = path.join(testDir, 'license.json')
      expect(fs.existsSync(licenseFile)).toBe(true)

      const stored = JSON.parse(fs.readFileSync(licenseFile, 'utf-8'))
      expect(stored.license.key).toBe(key.toUpperCase())
      expect(stored.license.email).toBe('test@example.com')
      expect(stored.license.tier).toBe('pro')
    })

    it('should load license from disk on new instance', async () => {
      const key = LicenseActivationService.generateKey('pro')
      await service.activate(key)

      const service2 = new LicenseActivationService(testDir)
      const license = service2.getLicense()
      expect(license).not.toBeNull()
      expect(license!.tier).toBe('pro')
      expect(license!.key).toBe(key.toUpperCase())
    })

    it('should handle corrupted license file', () => {
      fs.writeFileSync(path.join(testDir, 'license.json'), 'corrupted data')
      const service2 = new LicenseActivationService(testDir)
      expect(service2.getLicense()).toBeNull()
    })
  })

  // ── Checkout URLs ─────────────────────────────────────────────

  describe('checkout URLs', () => {
    it('should return tier-specific Stripe checkout URLs', () => {
      const urlPro = service.getCheckoutUrl('pro')
      const urlTeam = service.getCheckoutUrl('team')
      const urlEnterprise = service.getCheckoutUrl('enterprise')

      expect(urlPro).toContain('buy.stripe.com')
      expect(urlTeam).toContain('buy.stripe.com')
      expect(urlEnterprise).toContain('digital-opua.ch')

      // Pro and Team are different Stripe Payment Links
      expect(urlPro).not.toBe(urlTeam)
      // Enterprise is mailto
      expect(urlEnterprise).toContain('mailto:')
    })
  })
})
