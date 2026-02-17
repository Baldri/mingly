/**
 * Agent Comparison Store — manages parallel model comparison with tool-use.
 *
 * Tracks model slots, comparison sessions, per-slot agent steps,
 * and live event handling for real-time UI updates.
 */

import { create } from 'zustand'
import type {
  AgentModelSlot,
  AgentComparisonSession,
  AgentStep
} from '../../shared/types'

// Agent event from IPC (mirrors AgentEvent from agent-executor.ts)
interface AgentEvent {
  type: 'step_start' | 'step_complete' | 'run_complete'
  runId: string
  step?: AgentStep
  run?: {
    id: string
    status: string
    steps: AgentStep[]
    totalTokens: { input: number; output: number }
    durationMs: number
    error?: string
  }
}

// Access window.electronAPI.agentComparison safely
interface AgentComparisonAPI {
  start: (
    prompt: string,
    slots: AgentModelSlot[],
    systemPrompt?: string,
    conversationHistory?: unknown[]
  ) => Promise<{ success: boolean; session?: AgentComparisonSession; error?: string }>
  cancel: (sessionId: string) => Promise<{ success: boolean; cancelled: boolean }>
  onStep: (callback: (slotIndex: number, event: AgentEvent) => void) => () => void
}

function getAgentComparisonAPI(): AgentComparisonAPI | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).electronAPI
  return api?.agentComparison ?? null
}

interface AgentComparisonState {
  // State
  slots: AgentModelSlot[]
  session: AgentComparisonSession | null
  perSlotSteps: AgentStep[][]
  isRunning: boolean
  error: string | null

  // Actions
  addSlot: (slot: AgentModelSlot) => void
  removeSlot: (index: number) => void
  updateSlot: (index: number, slot: AgentModelSlot) => void
  clearSlots: () => void
  runComparison: (prompt: string, systemPrompt?: string) => Promise<AgentComparisonSession | null>
  cancelComparison: () => Promise<void>
  handleSlotEvent: (slotIndex: number, event: AgentEvent) => void
  clearSession: () => void
  clearError: () => void
}

// Store unsubscribe function to prevent memory leaks (Finding 5)
let unsubCompStep: (() => void) | null = null

export const useAgentComparisonStore = create<AgentComparisonState>((set, get) => {
  // Clean up previous subscription (e.g. HMR reload)
  unsubCompStep?.()
  unsubCompStep = null

  // Subscribe to IPC events on store creation
  const compApi = typeof window !== 'undefined' ? getAgentComparisonAPI() : null
  if (compApi?.onStep) {
    unsubCompStep = compApi.onStep((slotIndex, event) => {
      get().handleSlotEvent(slotIndex, event)
    })
  }

  return {
    // Initial state
    slots: [],
    session: null,
    perSlotSteps: [],
    isRunning: false,
    error: null,

    addSlot: (slot) => {
      const { slots } = get()
      if (slots.length >= 3) return // Max 3 slots
      set({ slots: [...slots, slot] })
    },

    removeSlot: (index) => {
      const { slots } = get()
      set({ slots: slots.filter((_, i) => i !== index) })
    },

    updateSlot: (index, slot) => {
      const { slots } = get()
      const updated = [...slots]
      updated[index] = slot
      set({ slots: updated })
    },

    clearSlots: () => {
      set({ slots: [] })
    },

    runComparison: async (prompt, systemPrompt) => {
      const { slots } = get()
      const compApi = getAgentComparisonAPI()
      if (!compApi) {
        set({ error: 'Agent Comparison API not available' })
        return null
      }
      if (slots.length === 0) {
        set({ error: 'No model slots configured' })
        return null
      }

      // Initialize per-slot steps arrays
      const perSlotSteps: AgentStep[][] = slots.map(() => [])

      set({
        isRunning: true,
        session: null,
        perSlotSteps,
        error: null
      })

      try {
        const result = await compApi.start(prompt, slots, systemPrompt)

        if (!result.success || !result.session) {
          set({
            isRunning: false,
            error: result.error ?? 'Agent comparison failed'
          })
          return null
        }

        set({
          isRunning: false,
          session: result.session
        })

        return result.session
      } catch (error) {
        set({
          isRunning: false,
          error: (error as Error).message
        })
        return null
      }
    },

    cancelComparison: async () => {
      const { session } = get()
      if (!session) return

      const compApi = getAgentComparisonAPI()
      if (!compApi) {
        set({ error: 'Cannot cancel: API not available' })
        return
      }

      try {
        const result = await compApi.cancel(session.id)
        if (result.cancelled) {
          set({ isRunning: false })
        } else {
          set({ error: 'Session not found or already completed' })
        }
      } catch (error) {
        set({ error: `Cancel failed: ${(error as Error).message}` })
      }
    },

    handleSlotEvent: (slotIndex, event) => {
      // Guard: validate slot index (max 3 slots)
      if (slotIndex < 0 || slotIndex > 2) return

      const { perSlotSteps } = get()

      if (event.type === 'step_complete' && event.step) {
        // Ensure the array exists for this slot
        const updated = [...perSlotSteps]
        while (updated.length <= slotIndex) {
          updated.push([])
        }
        updated[slotIndex] = [...(updated[slotIndex] || []), event.step]
        set({ perSlotSteps: updated })
      }
    },

    clearSession: () => {
      set({ session: null, perSlotSteps: [] })
    },

    clearError: () => {
      set({ error: null })
    }
  }
})
