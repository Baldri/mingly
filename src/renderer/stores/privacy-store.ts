/**
 * Privacy Store — Zustand state for Swiss AI Privacy UI.
 * Manages privacy mode, PII detection stats, and session state per conversation.
 */

import { create } from 'zustand'

/** Privacy modes matching backend PrivacyMode */
type PrivacyMode = 'shield' | 'vault' | 'transparent' | 'local_only'

interface PIIDetectionPreview {
  /** Number of PII entities detected in current input */
  entityCount: number
  /** Categories detected (e.g., ['EMAIL', 'PHONE']) */
  categories: string[]
  /** Whether any critical PII was found */
  hasCritical: boolean
}

interface PrivacyState {
  /** Current privacy mode */
  mode: PrivacyMode
  /** Active session ID (usually conversation ID) */
  sessionId: string | null
  /** Last detection preview (for live input feedback) */
  preview: PIIDetectionPreview | null
  /** Whether privacy features are enabled */
  enabled: boolean
  /** Total PII entities anonymized this session */
  sessionAnonymizedCount: number
  /** Loading state */
  loading: boolean
  /** NER model status */
  nerStatus: 'not_downloaded' | 'downloading' | 'ready' | 'error'
  /** NER download progress (0-100) */
  nerProgress: number

  // Actions
  setMode: (sessionId: string, mode: PrivacyMode) => Promise<void>
  loadMode: (sessionId: string) => Promise<void>
  detectPreview: (text: string) => Promise<void>
  clearPreview: () => void
  clearSession: (sessionId: string) => Promise<void>
  setEnabled: (enabled: boolean) => void
  incrementAnonymized: (count: number) => void
  loadNerStatus: () => Promise<void>
  downloadNerModel: () => Promise<void>
  deleteNerModel: () => Promise<void>
}

export const usePrivacyStore = create<PrivacyState>((set, get) => ({
  mode: 'shield',
  sessionId: null,
  preview: null,
  enabled: true,
  sessionAnonymizedCount: 0,
  loading: false,
  nerStatus: 'not_downloaded',
  nerProgress: 0,

  setMode: async (sessionId: string, mode: PrivacyMode) => {
    set({ loading: true })
    try {
      await window.electronAPI.privacy.setMode(sessionId, mode)
      set({ mode, sessionId, loading: false })
    } catch (error) {
      console.error('[Privacy] Failed to set mode:', error)
      set({ loading: false })
    }
  },

  loadMode: async (sessionId: string) => {
    try {
      const result = await window.electronAPI.privacy.getMode(sessionId)
      set({ mode: result?.mode ?? 'shield', sessionId })
    } catch {
      set({ mode: 'shield', sessionId })
    }
  },

  detectPreview: async (text: string) => {
    if (!get().enabled || !text.trim()) {
      set({ preview: null })
      return
    }
    try {
      const result = await window.electronAPI.privacy.detectPII(text)
      if (!result?.entities) {
        set({ preview: null })
        return
      }
      const categorySet = new Set<string>(result.entities.map((e: { category: string }) => e.category))
      const categories = Array.from(categorySet)
      const hasCritical = result.entities.some(
        (e: { sensitivity: string }) => e.sensitivity === 'critical'
      )
      set({
        preview: {
          entityCount: result.entities.length,
          categories,
          hasCritical
        }
      })
    } catch {
      set({ preview: null })
    }
  },

  clearPreview: () => set({ preview: null }),

  clearSession: async (sessionId: string) => {
    try {
      await window.electronAPI.privacy.clearSession(sessionId)
    } catch {
      // non-critical
    }
    set({ sessionAnonymizedCount: 0, preview: null })
  },

  setEnabled: (enabled: boolean) => set({ enabled }),

  incrementAnonymized: (count: number) =>
    set((state) => ({ sessionAnonymizedCount: state.sessionAnonymizedCount + count })),

  loadNerStatus: async () => {
    try {
      const result = await window.electronAPI.privacy.nerStatus()
      set({ nerStatus: result.status, nerProgress: result.progress })
    } catch {
      set({ nerStatus: 'error' })
    }
  },

  downloadNerModel: async () => {
    set({ nerStatus: 'downloading', nerProgress: 0 })
    const cleanup = window.electronAPI.privacy.onNerProgress((percent: number) => {
      set({ nerProgress: percent })
    })
    try {
      const result = await window.electronAPI.privacy.nerDownload()
      if (result.success) {
        set({ nerStatus: 'ready', nerProgress: 100 })
      } else {
        set({ nerStatus: 'error' })
      }
    } catch {
      set({ nerStatus: 'error' })
    } finally {
      cleanup()
    }
  },

  deleteNerModel: async () => {
    await window.electronAPI.privacy.nerDelete()
    set({ nerStatus: 'not_downloaded', nerProgress: 0 })
  },
}))
