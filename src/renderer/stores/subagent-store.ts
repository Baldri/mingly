/**
 * Subagent Store — manages parallel subagent orchestration state.
 *
 * Tracks the 4-phase lifecycle:
 * 1. Decomposition (master LLM splits task into subtasks)
 * 2. Configuration (user picks provider/model per subtask)
 * 3. Execution (parallel ReAct loops with live events)
 * 4. Synthesis (master LLM merges results)
 *
 * Listens to IPC events from SubagentOrchestrator for real-time updates.
 */

import { create } from 'zustand'
import type {
  AgentModelSlot,
  AgentStep,
  SubagentTask,
  TaskDecomposition,
  SubagentSession
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

// Access window.electronAPI.subagent safely
interface SubagentAPI {
  decompose: (
    task: string,
    masterSlot: AgentModelSlot,
    conversationHistory?: unknown[],
    systemPrompt?: string
  ) => Promise<{ success: boolean; decomposition?: TaskDecomposition; error?: string }>
  start: (
    sessionId: string,
    tasks: SubagentTask[],
    originalTask: string,
    masterSlot: AgentModelSlot
  ) => Promise<{ success: boolean; session?: SubagentSession; error?: string }>
  cancel: (sessionId: string) => Promise<{ success: boolean; cancelled: boolean }>
  onStep: (callback: (taskId: string, event: AgentEvent) => void) => () => void
  onStatus: (callback: (session: SubagentSession) => void) => () => void
}

function getSubagentAPI(): SubagentAPI | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (window as any).electronAPI
  return api?.subagent ?? null
}

interface SubagentState {
  // State
  session: SubagentSession | null
  decomposition: TaskDecomposition | null
  perTaskSteps: Record<string, AgentStep[]>
  isDecomposing: boolean
  isRunning: boolean
  isSynthesizing: boolean
  error: string | null

  // Original task for re-use
  originalTask: string | null
  masterSlot: AgentModelSlot | null

  // Actions
  decompose: (
    task: string,
    masterSlot: AgentModelSlot,
    conversationHistory?: unknown[],
    systemPrompt?: string
  ) => Promise<TaskDecomposition | null>
  updateSubtaskSlot: (taskId: string, slot: AgentModelSlot) => void
  startSubtasks: () => Promise<SubagentSession | null>
  cancelSession: () => Promise<void>
  handleSubtaskEvent: (taskId: string, event: AgentEvent) => void
  handleStatusChange: (session: SubagentSession) => void
  clearSession: () => void
  clearError: () => void
}

// Store unsubscribe functions to prevent memory leaks (Finding 5)
let unsubStep: (() => void) | null = null
let unsubStatus: (() => void) | null = null

export const useSubagentStore = create<SubagentState>((set, get) => {
  // Clean up previous subscriptions (e.g. HMR reload)
  unsubStep?.()
  unsubStatus?.()
  unsubStep = null
  unsubStatus = null

  // Auto-subscribe on store creation (if in Electron context)
  const subagentApi = typeof window !== 'undefined' ? getSubagentAPI() : null

  if (subagentApi?.onStep) {
    unsubStep = subagentApi.onStep((taskId, event) => {
      get().handleSubtaskEvent(taskId, event)
    })
  }

  if (subagentApi?.onStatus) {
    unsubStatus = subagentApi.onStatus((session) => {
      get().handleStatusChange(session)
    })
  }

  return {
    // Initial state
    session: null,
    decomposition: null,
    perTaskSteps: {},
    isDecomposing: false,
    isRunning: false,
    isSynthesizing: false,
    error: null,
    originalTask: null,
    masterSlot: null,

    // Phase 1: Decompose task into subtasks
    decompose: async (task, masterSlot, conversationHistory, systemPrompt) => {
      const api = getSubagentAPI()
      if (!api) {
        set({ error: 'Subagent API not available' })
        return null
      }

      set({
        isDecomposing: true,
        decomposition: null,
        session: null,
        perTaskSteps: {},
        error: null,
        originalTask: task,
        masterSlot
      })

      try {
        const result = await api.decompose(task, masterSlot, conversationHistory, systemPrompt)

        if (!result.success || !result.decomposition) {
          set({
            isDecomposing: false,
            error: result.error ?? 'Decomposition failed'
          })
          return null
        }

        set({
          isDecomposing: false,
          decomposition: result.decomposition
        })

        return result.decomposition
      } catch (error) {
        set({
          isDecomposing: false,
          error: (error as Error).message
        })
        return null
      }
    },

    // Phase 1.5: User configures provider/model per subtask
    updateSubtaskSlot: (taskId, slot) => {
      const { decomposition } = get()
      if (!decomposition) return

      const updatedSubtasks = decomposition.subtasks.map((st) =>
        st.id === taskId ? { ...st, slot } : st
      )

      set({
        decomposition: {
          ...decomposition,
          subtasks: updatedSubtasks
        }
      })
    },

    // Phase 2+3: Execute subtasks in parallel, then synthesize
    startSubtasks: async () => {
      const { decomposition, originalTask, masterSlot } = get()
      const api = getSubagentAPI()

      if (!api || !decomposition || !originalTask || !masterSlot) {
        set({ error: 'Missing decomposition, task, or master slot' })
        return null
      }

      // Initialize per-task step tracking
      const perTaskSteps: Record<string, AgentStep[]> = {}
      for (const task of decomposition.subtasks) {
        perTaskSteps[task.id] = []
      }

      set({
        isRunning: true,
        isSynthesizing: false,
        perTaskSteps,
        session: null,
        error: null
      })

      try {
        // sessionId will be generated by the handler
        const result = await api.start(
          '', // empty = handler generates ID
          decomposition.subtasks,
          originalTask,
          masterSlot
        )

        if (!result.success || !result.session) {
          set({
            isRunning: false,
            error: result.error ?? 'Subagent execution failed'
          })
          return null
        }

        set({
          isRunning: false,
          isSynthesizing: false,
          session: result.session
        })

        return result.session
      } catch (error) {
        set({
          isRunning: false,
          isSynthesizing: false,
          error: (error as Error).message
        })
        return null
      }
    },

    // Cancel running session
    cancelSession: async () => {
      const { session } = get()
      if (!session) return

      const api = getSubagentAPI()
      if (!api) {
        set({ error: 'Cannot cancel: API not available' })
        return
      }

      try {
        const result = await api.cancel(session.id)
        if (result.cancelled) {
          set({ isRunning: false, isSynthesizing: false })
        } else {
          set({ error: 'Session not found or already completed' })
        }
      } catch (error) {
        set({ error: `Cancel failed: ${(error as Error).message}` })
      }
    },

    // Handle real-time subtask step events from IPC
    handleSubtaskEvent: (taskId, event) => {
      if (event.type === 'step_complete' && event.step) {
        const { perTaskSteps } = get()
        const existingSteps = perTaskSteps[taskId] || []
        set({
          perTaskSteps: {
            ...perTaskSteps,
            [taskId]: [...existingSteps, event.step]
          }
        })
      }
    },

    // Handle session status changes from IPC
    handleStatusChange: (session) => {
      set({
        session,
        isSynthesizing: session.status === 'synthesizing',
        isRunning: session.status === 'running_subtasks'
      })
    },

    // Clear everything
    clearSession: () => {
      set({
        session: null,
        decomposition: null,
        perTaskSteps: {},
        isDecomposing: false,
        isRunning: false,
        isSynthesizing: false,
        error: null,
        originalTask: null,
        masterSlot: null
      })
    },

    // Clear error
    clearError: () => {
      set({ error: null })
    }
  }
})
