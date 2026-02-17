/**
 * Agent Store — manages agentic mode state and agent run lifecycle.
 *
 * Tracks current agent run, step-by-step progress, and agent configuration.
 * Listens to IPC events from AgentExecutor for real-time step updates.
 */

import { create } from 'zustand'
import type {
  AgentConfig,
  AgentRun,
  AgentStep
} from '../../shared/types'

// Agent event from IPC (mirrors AgentEvent from agent-executor.ts)
interface AgentEvent {
  type: 'step_start' | 'step_complete' | 'run_complete'
  runId: string
  step?: AgentStep
  run?: AgentRun
}

interface AgentState {
  // State
  isAgentMode: boolean
  isRunning: boolean
  currentRun: AgentRun | null
  currentSteps: AgentStep[]
  config: AgentConfig | null
  error: string | null

  // History of completed runs (last 10)
  runHistory: AgentRun[]

  // Actions
  setAgentMode: (enabled: boolean) => void
  executeAgent: (
    task: string,
    provider: string,
    model: string,
    conversationId?: string,
    conversationHistory?: unknown[],
    systemPrompt?: string
  ) => Promise<AgentRun | null>
  cancelRun: () => Promise<void>
  loadConfig: () => Promise<void>
  updateConfig: (updates: Partial<AgentConfig>) => Promise<void>
  handleAgentEvent: (event: AgentEvent) => void
  clearCurrentRun: () => void
  clearError: () => void
}

// Access window.electronAPI.agent via safe accessor.
// We avoid `declare global { interface Window }` to prevent overriding
// the global ElectronAPI type from preload/index.ts.
interface AgentAPI {
  execute: (
    task: string,
    provider: string,
    model: string,
    conversationId?: string,
    conversationHistory?: unknown[],
    systemPrompt?: string
  ) => Promise<{ success: boolean; run?: AgentRun; error?: string }>
  cancel: (runId: string) => Promise<{ success: boolean; cancelled: boolean }>
  getConfig: () => Promise<{ success: boolean; config: AgentConfig }>
  updateConfig: (updates: Partial<AgentConfig>) => Promise<{ success: boolean; config: AgentConfig }>
  onStep: (callback: (event: AgentEvent) => void) => () => void
}

function getAgentAPI(): AgentAPI | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).electronAPI
  return api?.agent ?? null
}

export const useAgentStore = create<AgentState>((set, get) => {
  // Auto-subscribe on store creation (if in Electron context)
  const agentApi = typeof window !== 'undefined' ? getAgentAPI() : null
  if (agentApi?.onStep) {
    agentApi.onStep((event) => {
      get().handleAgentEvent(event)
    })
  }

  return {
    // Initial state
    isAgentMode: false,
    isRunning: false,
    currentRun: null,
    currentSteps: [],
    config: null,
    error: null,
    runHistory: [],

    // Toggle agentic mode
    setAgentMode: (enabled) => {
      set({ isAgentMode: enabled })
    },

    // Execute an agent task
    executeAgent: async (task, provider, model, conversationId, conversationHistory, systemPrompt) => {
      const agentApi = getAgentAPI()
      if (!agentApi) {
        set({ error: 'Agent API not available' })
        return null
      }

      set({
        isRunning: true,
        currentSteps: [],
        currentRun: null,
        error: null
      })

      try {
        const result = await agentApi.execute(
          task,
          provider,
          model,
          conversationId,
          conversationHistory,
          systemPrompt
        )

        if (!result.success || !result.run) {
          set({
            isRunning: false,
            error: result.error ?? 'Agent execution failed'
          })
          return null
        }

        const run = result.run

        // Add to history
        const { runHistory } = get()
        const newHistory = [run, ...runHistory].slice(0, 10)

        set({
          isRunning: false,
          currentRun: run,
          runHistory: newHistory
        })

        return run
      } catch (error) {
        set({
          isRunning: false,
          error: (error as Error).message
        })
        return null
      }
    },

    // Cancel the current agent run
    cancelRun: async () => {
      const { currentRun } = get()
      if (!currentRun) return

      const agentApi = getAgentAPI()
      if (!agentApi) return

      try {
        await agentApi.cancel(currentRun.id)
        set({ isRunning: false })
      } catch (error) {
        console.warn('Failed to cancel agent run:', error)
      }
    },

    // Load agent configuration
    loadConfig: async () => {
      const agentApi = getAgentAPI()
      if (!agentApi) return

      try {
        const result = await agentApi.getConfig()
        if (result.success) {
          set({ config: result.config })
        }
      } catch (error) {
        console.warn('Failed to load agent config:', error)
      }
    },

    // Update agent configuration
    updateConfig: async (updates) => {
      const agentApi = getAgentAPI()
      if (!agentApi) return

      try {
        const result = await agentApi.updateConfig(updates)
        if (result.success) {
          set({ config: result.config })
        }
      } catch (error) {
        console.warn('Failed to update agent config:', error)
      }
    },

    // Handle real-time agent events from IPC
    handleAgentEvent: (event) => {
      switch (event.type) {
        case 'step_start':
          if (event.step) {
            // Don't add to steps yet — wait for step_complete
          }
          break

        case 'step_complete':
          if (event.step) {
            const { currentSteps } = get()
            set({ currentSteps: [...currentSteps, event.step] })
          }
          break

        case 'run_complete':
          if (event.run) {
            const { runHistory } = get()
            const newHistory = [event.run, ...runHistory].slice(0, 10)
            set({
              isRunning: false,
              currentRun: event.run,
              runHistory: newHistory
            })
          }
          break
      }
    },

    // Clear current run (after user dismisses)
    clearCurrentRun: () => {
      set({ currentRun: null, currentSteps: [] })
    },

    // Clear error
    clearError: () => {
      set({ error: null })
    }
  }
})
