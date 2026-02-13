/**
 * Subscription Store — Tests for tier management, license activation, and feature gating
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electronAPI before importing store
const mockElectronAPI = {
  featureGate: {
    getTier: vi.fn(),
    getAllFeatures: vi.fn(),
    check: vi.fn()
  },
  license: {
    activate: vi.fn(),
    deactivate: vi.fn(),
    getInfo: vi.fn(),
    getCheckoutUrl: vi.fn()
  }
}

vi.stubGlobal('window', { electronAPI: mockElectronAPI })

// Dynamic import to pick up the mocked global
const { useSubscriptionStore } = await import('../../src/renderer/stores/subscription-store')

describe('SubscriptionStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset store to defaults
    useSubscriptionStore.setState({
      tier: 'free',
      limits: null,
      license: null,
      features: {},
      isLoading: false,
      error: null,
      showUpgradeDialog: false,
      showLicenseDialog: false,
      upgradePromptFeature: null
    })
  })

  describe('initial state', () => {
    it('should start as free tier', () => {
      const state = useSubscriptionStore.getState()
      expect(state.tier).toBe('free')
      expect(state.license).toBeNull()
      expect(state.limits).toBeNull()
      expect(state.showUpgradeDialog).toBe(false)
      expect(state.showLicenseDialog).toBe(false)
    })
  })

  describe('loadTier', () => {
    it('should load tier and limits from electronAPI', async () => {
      const mockTier = { tier: 'pro' as const, limits: { maxConversations: 100, maxModels: 10 } }
      mockElectronAPI.featureGate.getTier.mockResolvedValue(mockTier)

      await useSubscriptionStore.getState().loadTier()

      const state = useSubscriptionStore.getState()
      expect(state.tier).toBe('pro')
      expect(state.limits).toEqual(mockTier.limits)
    })

    it('should set error on failure', async () => {
      mockElectronAPI.featureGate.getTier.mockRejectedValue(new Error('Network error'))

      await useSubscriptionStore.getState().loadTier()

      expect(useSubscriptionStore.getState().error).toBe('Network error')
    })
  })

  describe('loadAllFeatures', () => {
    it('should load all feature gates', async () => {
      const mockFeatures = {
        'unlimited-models': { allowed: true, tier: 'pro' },
        'custom-prompts': { allowed: false, tier: 'pro', requiredTier: 'pro' }
      }
      mockElectronAPI.featureGate.getAllFeatures.mockResolvedValue(mockFeatures)

      await useSubscriptionStore.getState().loadAllFeatures()

      expect(useSubscriptionStore.getState().features).toEqual(mockFeatures)
    })

    it('should handle errors gracefully', async () => {
      mockElectronAPI.featureGate.getAllFeatures.mockRejectedValue(new Error('Failed'))

      await useSubscriptionStore.getState().loadAllFeatures()

      expect(useSubscriptionStore.getState().error).toBe('Failed')
    })
  })

  describe('checkFeature', () => {
    it('should return allowed for permitted features', async () => {
      mockElectronAPI.featureGate.check.mockResolvedValue({ allowed: true })

      const result = await useSubscriptionStore.getState().checkFeature('unlimited-models' as any)

      expect(result.allowed).toBe(true)
      expect(useSubscriptionStore.getState().showUpgradeDialog).toBe(false)
    })

    it('should open upgrade dialog for blocked features', async () => {
      mockElectronAPI.featureGate.check.mockResolvedValue({ allowed: false, requiredTier: 'pro' })

      const result = await useSubscriptionStore.getState().checkFeature('custom-prompts' as any)

      expect(result.allowed).toBe(false)
      expect(useSubscriptionStore.getState().showUpgradeDialog).toBe(true)
      expect(useSubscriptionStore.getState().upgradePromptFeature).toBe('custom-prompts')
    })
  })

  describe('activateLicense', () => {
    it('should activate a valid license and reload tier', async () => {
      mockElectronAPI.license.activate.mockResolvedValue({ success: true, valid: true })
      mockElectronAPI.license.getInfo.mockResolvedValue({
        license: { key: 'MINGLY-PRO-ABC123-XY', tier: 'pro', activated: true }
      })
      mockElectronAPI.featureGate.getTier.mockResolvedValue({
        tier: 'pro',
        limits: { maxConversations: 100 }
      })
      mockElectronAPI.featureGate.getAllFeatures.mockResolvedValue({})

      const result = await useSubscriptionStore.getState().activateLicense('MINGLY-PRO-ABC123-XY')

      expect(result.valid).toBe(true)
      expect(useSubscriptionStore.getState().tier).toBe('pro')
      expect(useSubscriptionStore.getState().isLoading).toBe(false)
      expect(useSubscriptionStore.getState().showLicenseDialog).toBe(false)
    })

    it('should return error for invalid license', async () => {
      mockElectronAPI.license.activate.mockResolvedValue({ success: false, valid: false, error: 'Invalid key' })

      const result = await useSubscriptionStore.getState().activateLicense('INVALID-KEY')

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Invalid key')
      expect(useSubscriptionStore.getState().error).toBe('Invalid key')
    })

    it('should handle network errors during activation', async () => {
      mockElectronAPI.license.activate.mockRejectedValue(new Error('Connection refused'))

      const result = await useSubscriptionStore.getState().activateLicense('MINGLY-PRO-ABC123-XY')

      expect(result.valid).toBe(false)
      expect(result.error).toBe('Connection refused')
      expect(useSubscriptionStore.getState().isLoading).toBe(false)
    })
  })

  describe('deactivateLicense', () => {
    it('should deactivate and reset to free tier', async () => {
      // Start with pro tier
      useSubscriptionStore.setState({ tier: 'pro', license: { key: 'X', tier: 'pro', activatedAt: Date.now(), validated: true } })
      mockElectronAPI.license.deactivate.mockResolvedValue(undefined)
      mockElectronAPI.featureGate.getAllFeatures.mockResolvedValue({})

      await useSubscriptionStore.getState().deactivateLicense()

      const state = useSubscriptionStore.getState()
      expect(state.tier).toBe('free')
      expect(state.license).toBeNull()
      expect(state.limits).toBeNull()
    })

    it('should handle deactivation errors', async () => {
      mockElectronAPI.license.deactivate.mockRejectedValue(new Error('Cannot deactivate'))

      await useSubscriptionStore.getState().deactivateLicense()

      expect(useSubscriptionStore.getState().error).toBe('Cannot deactivate')
    })
  })

  describe('getCheckoutUrl', () => {
    it('should return Stripe checkout URL for tier', async () => {
      mockElectronAPI.license.getCheckoutUrl.mockResolvedValue({
        url: 'https://buy.stripe.com/test-pro'
      })

      const url = await useSubscriptionStore.getState().getCheckoutUrl('pro')

      expect(url).toBe('https://buy.stripe.com/test-pro')
    })
  })

  describe('UI actions', () => {
    it('should open and close upgrade dialog', () => {
      const { openUpgradeDialog, closeUpgradeDialog } = useSubscriptionStore.getState()

      openUpgradeDialog('custom-prompts' as any)
      expect(useSubscriptionStore.getState().showUpgradeDialog).toBe(true)
      expect(useSubscriptionStore.getState().upgradePromptFeature).toBe('custom-prompts')

      closeUpgradeDialog()
      expect(useSubscriptionStore.getState().showUpgradeDialog).toBe(false)
      expect(useSubscriptionStore.getState().upgradePromptFeature).toBeNull()
    })

    it('should open and close license dialog', () => {
      const { openLicenseDialog, closeLicenseDialog } = useSubscriptionStore.getState()

      openLicenseDialog()
      expect(useSubscriptionStore.getState().showLicenseDialog).toBe(true)

      closeLicenseDialog()
      expect(useSubscriptionStore.getState().showLicenseDialog).toBe(false)
    })

    it('should open upgrade dialog without feature', () => {
      useSubscriptionStore.getState().openUpgradeDialog()
      expect(useSubscriptionStore.getState().showUpgradeDialog).toBe(true)
      expect(useSubscriptionStore.getState().upgradePromptFeature).toBeNull()
    })
  })
})
