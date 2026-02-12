import { create } from 'zustand'
import type { ComparisonModelConfig, ComparisonSession, ComparisonResult } from '../../shared/types'

interface ComparisonState {
  /** Selected models for comparison */
  selectedModels: ComparisonModelConfig[]
  /** Current session being viewed */
  currentSession: ComparisonSession | null
  /** Results for current session */
  results: ComparisonResult[]
  /** Per-model streaming content (for future streaming support) */
  streamingContent: Record<string, string>
  /** Whether a comparison is running */
  isRunning: boolean
  /** Errors from the run */
  errors: Array<{ provider: string; model: string; error: string }>
  /** History of past sessions */
  history: Array<ComparisonSession & { results: ComparisonResult[] }>
  /** Error message */
  error: string | null

  // Actions
  addModel: (config: ComparisonModelConfig) => void
  removeModel: (index: number) => void
  clearModels: () => void
  runComparison: (prompt: string) => Promise<void>
  markWinner: (resultId: string) => Promise<void>
  loadHistory: () => Promise<void>
  clearError: () => void
}

export const useComparisonStore = create<ComparisonState>((set, get) => ({
  selectedModels: [],
  currentSession: null,
  results: [],
  streamingContent: {},
  isRunning: false,
  errors: [],
  history: [],
  error: null,

  addModel: (config: ComparisonModelConfig) => {
    const { selectedModels } = get()
    if (selectedModels.length >= 3) return // max 3 models
    set({ selectedModels: [...selectedModels, config] })
  },

  removeModel: (index: number) => {
    set((state) => ({
      selectedModels: state.selectedModels.filter((_, i) => i !== index)
    }))
  },

  clearModels: () => {
    set({ selectedModels: [] })
  },

  runComparison: async (prompt: string) => {
    const { selectedModels } = get()
    if (selectedModels.length < 2) {
      set({ error: 'Select at least 2 models to compare' })
      return
    }

    set({ isRunning: true, error: null, errors: [], results: [], currentSession: null })

    try {
      const result = await window.electronAPI.comparison.start(prompt, selectedModels)
      if (result.success) {
        set({
          currentSession: result.session,
          results: result.results,
          errors: result.errors || [],
          isRunning: false
        })
      } else {
        set({ error: result.error || 'Comparison failed', isRunning: false })
      }
    } catch (error) {
      console.error('Comparison failed:', error)
      set({ error: 'Failed to run comparison', isRunning: false })
    }
  },

  markWinner: async (resultId: string) => {
    const { currentSession } = get()
    if (!currentSession) return

    try {
      const result = await window.electronAPI.comparison.markWinner(currentSession.id, resultId)
      if (result.success) {
        set((state) => ({
          results: state.results.map((r) => ({
            ...r,
            isWinner: r.id === resultId
          }))
        }))
      }
    } catch (error) {
      console.error('Failed to mark winner:', error)
    }
  },

  loadHistory: async () => {
    try {
      const result = await window.electronAPI.comparison.getHistory()
      if (result.success) {
        set({ history: result.history })
      }
    } catch (error) {
      console.error('Failed to load history:', error)
    }
  },

  clearError: () => set({ error: null })
}))
