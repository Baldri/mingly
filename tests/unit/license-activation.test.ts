/**
 * LicenseActivationService Tests
 * Tests key format validation, activation flow, deactivation, and persistence.
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

// Mock global fetch
const mockFetch = vi.fn()
global.fetch = mockFetch as any

describe('LicenseActivationService', () => {
  const testDir = '/tmp/test-license-' + Date.now()
  let service: LicenseActivationService

  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true })
    fs.mkdirSync(testDir, { recursive: true })
    service = new LicenseActivationService(testDir)
    mockSetTier.mockClear()
    mockFetch.mockReset()
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

  // ── Key format validation ─────────────────────────────────────

  describe('key format validation', () => {
    it('should reject empty key', async () => {
      mockFetch.mockRejectedValue(new Error('network'))
      const result = await service.activate('')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('short')
    })

    it('should reject very short key', async () => {
      mockFetch.mockRejectedValue(new Error('network'))
      const result = await service.activate('ABC')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('short')
    })

    it('should reject MINGLY-format key with unknown tier', async () => {
      mockFetch.mockRejectedValue(new Error('network'))
      const result = await service.activate('MINGLY-PLATINUM-ABCD1234-5678')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('tier')
    })

    it('should reject MINGLY-format key with too-short segment', async () => {
      mockFetch.mockRejectedValue(new Error('network'))
      const result = await service.activate('MINGLY-PRO-AB-56')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('short')
    })

    it('should accept Lemonsqueezy UUID-style keys for online validation', async () => {
      // Lemonsqueezy keys like "38b1460a-5104-4067-a91d-77b872934d51"
      // are accepted for format validation but need online check
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          activated: true,
          valid: true,
          license_key: {},
          meta: { product_name: 'Mingly Pro' }
        })
      })
      const result = await service.activate('38b1460a-5104-4067-a91d-77b872934d51')
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('pro')
      expect(result.mode).toBe('online')
    })

    it('should reject Lemonsqueezy key when offline (no MINGLY prefix)', async () => {
      mockFetch.mockRejectedValue(new Error('network'))
      const result = await service.activate('38b1460a-5104-4067-a91d-77b872934d51')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('internet')
    })
  })

  // ── Offline activation (when network unavailable) ─────────────

  describe('offline activation', () => {
    beforeEach(() => {
      // Simulate network failure → falls through to offline
      mockFetch.mockRejectedValue(new Error('Network unavailable'))
    })

    it('should activate a valid PRO key offline', async () => {
      const result = await service.activate('MINGLY-PRO-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('pro')
      expect(result.mode).toBe('offline')
      expect(result.expiresAt).toBeGreaterThan(Date.now())
    })

    it('should activate a valid TEAM key offline', async () => {
      const result = await service.activate('MINGLY-TEAM-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('team')
    })

    it('should activate a valid ENTERPRISE key offline', async () => {
      const result = await service.activate('MINGLY-ENTERPRISE-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('enterprise')
    })

    it('should call setTier on feature gate manager', async () => {
      await service.activate('MINGLY-PRO-ABCDEF1234-5678')
      expect(mockSetTier).toHaveBeenCalledWith(
        'pro',
        'MINGLY-PRO-ABCDEF1234-5678',
        expect.any(Number),
        undefined
      )
    })

    it('should persist license to disk', async () => {
      await service.activate('MINGLY-PRO-ABCDEF1234-5678', 'test@example.com')
      const licenseFile = path.join(testDir, 'license.json')
      expect(fs.existsSync(licenseFile)).toBe(true)

      const stored = JSON.parse(fs.readFileSync(licenseFile, 'utf-8'))
      expect(stored.license.key).toBe('MINGLY-PRO-ABCDEF1234-5678')
      expect(stored.license.email).toBe('test@example.com')
      expect(stored.license.tier).toBe('pro')
    })

    it('should normalize key to uppercase', async () => {
      const result = await service.activate('mingly-pro-abcdef1234-5678')
      expect(result.valid).toBe(true)
      expect(service.getLicense()!.key).toBe('MINGLY-PRO-ABCDEF1234-5678')
    })

    it('should trim whitespace', async () => {
      const result = await service.activate('  MINGLY-PRO-ABCDEF1234-5678  ')
      expect(result.valid).toBe(true)
    })
  })

  // ── Online activation (mocked Lemonsqueezy) ───────────────────

  describe('online activation', () => {
    it('should activate when Lemonsqueezy returns valid', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ activated: true, valid: true, license_key: {}, meta: { product_name: 'Mingly Pro' } })
      })

      const result = await service.activate('MINGLY-PRO-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.mode).toBe('online')
      expect(result.tier).toBe('pro')
    })

    it('should extract tier from Lemonsqueezy product_name', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          activated: true,
          valid: true,
          license_key: {},
          meta: { product_name: 'Mingly Team' }
        })
      })

      // Even though the key says PRO, the API says Team → Team wins
      const result = await service.activate('MINGLY-PRO-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('team')
    })

    it('should extract tier from Lemonsqueezy variant_name', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          activated: true,
          valid: true,
          license_key: {},
          meta: { product_name: 'Mingly License', variant_name: 'Enterprise Annual' }
        })
      })

      const result = await service.activate('MINGLY-PRO-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('enterprise')
    })

    it('should fall back to key-based tier if API has no product name', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ activated: true, valid: true, license_key: {} })
      })

      const result = await service.activate('MINGLY-TEAM-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.tier).toBe('team')
    })

    it('should reject when Lemonsqueezy returns 422', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ error: 'Invalid license key' })
      })

      const result = await service.activate('MINGLY-PRO-ABCDEF1234-5678')
      expect(result.valid).toBe(false)
      expect(result.mode).toBe('online')
      expect(result.error).toContain('Invalid')
    })

    it('should fall back to offline on 500 server error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Server error' })
      })

      const result = await service.activate('MINGLY-PRO-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.mode).toBe('offline')
    })

    it('should extract expiry from Lemonsqueezy response', async () => {
      const expiresDate = '2027-02-11T00:00:00Z'
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          activated: true,
          valid: true,
          license_key: { expires_at: expiresDate },
          meta: { product_name: 'Mingly Pro' }
        })
      })

      const result = await service.activate('MINGLY-PRO-ABCDEF1234-5678')
      expect(result.valid).toBe(true)
      expect(result.expiresAt).toBe(new Date(expiresDate).getTime())
    })
  })

  // ── Deactivation ──────────────────────────────────────────────

  describe('deactivation', () => {
    beforeEach(async () => {
      mockFetch.mockRejectedValue(new Error('network'))
      await service.activate('MINGLY-PRO-ABCDEF1234-5678')
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
    it('should load license from disk on new instance', async () => {
      mockFetch.mockRejectedValue(new Error('network'))
      await service.activate('MINGLY-PRO-ABCDEF1234-5678')

      const service2 = new LicenseActivationService(testDir)
      const license = service2.getLicense()
      expect(license).not.toBeNull()
      expect(license!.tier).toBe('pro')
      expect(license!.key).toBe('MINGLY-PRO-ABCDEF1234-5678')
    })

    it('should handle corrupted license file', () => {
      fs.writeFileSync(path.join(testDir, 'license.json'), 'corrupted data')
      const service2 = new LicenseActivationService(testDir)
      expect(service2.getLicense()).toBeNull()
    })
  })

  // ── Checkout URLs ─────────────────────────────────────────────

  describe('checkout URLs', () => {
    it('should return the same checkout URL for all tiers', () => {
      const urlPro = service.getCheckoutUrl('pro')
      const urlTeam = service.getCheckoutUrl('team')
      const urlEnterprise = service.getCheckoutUrl('enterprise')

      // All tiers share one Lemonsqueezy checkout (customer picks variant)
      expect(urlPro).toContain('mingly-ch.lemonsqueezy.com')
      expect(urlPro).toContain('d1cc0e68-cc65-4a89-9bc4-680ea6983db5')
      expect(urlPro).toBe(urlTeam)
      expect(urlTeam).toBe(urlEnterprise)
    })
  })
})
