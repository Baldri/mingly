import { create } from 'zustand'
import type { AppSettings, LLMProvider } from '../../shared/types'

/** Fallback defaults — ensures UI always renders even if backend fails */
const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-3-5-sonnet-20241022',
  enableParallelMode: false,
  enableCostTracking: true,
  enableAuditLog: true,
  wizardCompleted: true,
}

interface SettingsState {
  settings: AppSettings | null
  apiKeysConfigured: Record<string, boolean>
  isLoading: boolean

  // Actions
  loadSettings: () => Promise<void>
  updateSettings: (updates: Partial<AppSettings>) => Promise<void>
  checkAPIKeys: () => Promise<void>
  saveAPIKey: (provider: string, apiKey: string) => Promise<boolean>
  validateAPIKey: (provider: string) => Promise<boolean>
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  apiKeysConfigured: {},
  isLoading: false,

  loadSettings: async () => {
    set({ isLoading: true })
    try {
      const result = await window.electronAPI.settings.get()
      if (result.success && result.settings) {
        // Merge with defaults so missing fields don't break the UI
        set({ settings: { ...DEFAULT_SETTINGS, ...result.settings } })
      } else {
        console.warn('Settings load returned no data, using defaults')
        set({ settings: { ...DEFAULT_SETTINGS } })
      }
    } catch (error) {
      console.error('Failed to load settings:', error)
      // CRITICAL: never leave settings as null — show UI with defaults
      set({ settings: { ...DEFAULT_SETTINGS } })
    } finally {
      set({ isLoading: false })
    }
  },

  updateSettings: async (updates: Partial<AppSettings>) => {
    try {
      const result = await window.electronAPI.settings.update(updates)
      if (result.success) {
        set({ settings: result.settings })
      }
    } catch (error) {
      console.error('Failed to update settings:', error)
    }
  },

  checkAPIKeys: async () => {
    try {
      const result = await window.electronAPI.keys.list()
      if (result.success && result.providers) {
        const configured = result.providers.reduce(
          (acc: Record<string, boolean>, provider: string) => ({ ...acc, [provider]: true }),
          {} as Record<string, boolean>
        )
        set({ apiKeysConfigured: configured })
      }
    } catch (error) {
      console.error('Failed to check API keys:', error)
    }
  },

  saveAPIKey: async (provider: string, apiKey: string) => {
    try {
      const result = await window.electronAPI.keys.save(provider as LLMProvider, apiKey)
      if (result.success) {
        // Update configured status
        await get().checkAPIKeys()
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to save API key:', error)
      return false
    }
  },

  validateAPIKey: async (provider: string) => {
    try {
      const result = await window.electronAPI.llm.validateApiKey(provider as LLMProvider)
      return result.success && result.valid
    } catch (error) {
      console.error('Failed to validate API key:', error)
      return false
    }
  }
}))
