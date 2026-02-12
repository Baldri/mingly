/**
 * Subscription Store — manages tier state, upgrade UI visibility, and license info.
 */

import { create } from 'zustand'
import type { SubscriptionTier, GatedFeature, FeatureGateResult, TierLimits } from '../../shared/types'

interface LicenseInfo {
  key: string
  tier: SubscriptionTier
  activatedAt: number
  expiresAt?: number
  email?: string
  validated: boolean
}

interface SubscriptionState {
  // State
  tier: SubscriptionTier
  limits: TierLimits | null
  license: LicenseInfo | null
  features: Record<string, FeatureGateResult>
  isLoading: boolean
  error: string | null

  // UI state
  showUpgradeDialog: boolean
  showLicenseDialog: boolean
  /** The feature that triggered the upgrade prompt */
  upgradePromptFeature: GatedFeature | null

  // Actions
  loadTier: () => Promise<void>
  loadAllFeatures: () => Promise<void>
  checkFeature: (feature: GatedFeature) => Promise<FeatureGateResult>
  activateLicense: (key: string, email?: string) => Promise<{ valid: boolean; error?: string }>
  deactivateLicense: () => Promise<void>
  getCheckoutUrl: (tier: Exclude<SubscriptionTier, 'free'>) => Promise<string>

  // UI actions
  openUpgradeDialog: (feature?: GatedFeature) => void
  closeUpgradeDialog: () => void
  openLicenseDialog: () => void
  closeLicenseDialog: () => void
}

export const useSubscriptionStore = create<SubscriptionState>((set, get) => ({
  tier: 'free',
  limits: null,
  license: null,
  features: {},
  isLoading: false,
  error: null,
  showUpgradeDialog: false,
  showLicenseDialog: false,
  upgradePromptFeature: null,

  loadTier: async () => {
    try {
      const result = await window.electronAPI.featureGate.getTier()
      set({
        tier: result.tier,
        limits: result.limits
      })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  loadAllFeatures: async () => {
    try {
      const features = await window.electronAPI.featureGate.getAllFeatures()
      set({ features })
    } catch (err) {
      set({ error: (err as Error).message })
    }
  },

  checkFeature: async (feature: GatedFeature) => {
    const result = await window.electronAPI.featureGate.check(feature)
    if (!result.allowed) {
      // Auto-show upgrade dialog when a feature is blocked
      set({ showUpgradeDialog: true, upgradePromptFeature: feature })
    }
    return result
  },

  activateLicense: async (key: string, email?: string) => {
    set({ isLoading: true, error: null })
    try {
      const result = await window.electronAPI.license.activate(key, email)
      if (result.success && result.valid) {
        // Reload tier info
        const licenseInfo = await window.electronAPI.license.getInfo()
        const tierInfo = await window.electronAPI.featureGate.getTier()
        const features = await window.electronAPI.featureGate.getAllFeatures()
        set({
          tier: tierInfo.tier,
          limits: tierInfo.limits,
          license: licenseInfo.license,
          features,
          isLoading: false,
          showLicenseDialog: false,
          showUpgradeDialog: false
        })
        return { valid: true }
      }
      set({ isLoading: false, error: result.error })
      return { valid: false, error: result.error }
    } catch (err) {
      const error = (err as Error).message
      set({ isLoading: false, error })
      return { valid: false, error }
    }
  },

  deactivateLicense: async () => {
    set({ isLoading: true })
    try {
      await window.electronAPI.license.deactivate()
      set({
        tier: 'free',
        license: null,
        limits: null,
        isLoading: false
      })
      // Reload features
      get().loadAllFeatures()
    } catch (err) {
      set({ isLoading: false, error: (err as Error).message })
    }
  },

  getCheckoutUrl: async (tier) => {
    const result = await window.electronAPI.license.getCheckoutUrl(tier)
    return result.url
  },

  openUpgradeDialog: (feature) => set({ showUpgradeDialog: true, upgradePromptFeature: feature || null }),
  closeUpgradeDialog: () => set({ showUpgradeDialog: false, upgradePromptFeature: null }),
  openLicenseDialog: () => set({ showLicenseDialog: true }),
  closeLicenseDialog: () => set({ showLicenseDialog: false })
}))
