/**
 * IPC Handlers — Agent execution, configuration, comparison, and subagent orchestration.
 * Requires 'agentic_mode' feature gate (Pro+ tier).
 */

import { BrowserWindow } from 'electron'
import { nanoid } from 'nanoid'
import { IPC_CHANNELS } from '../../shared/types'
import { getAgentExecutor } from '../agent/agent-executor'
import { getAgentComparisonService } from '../services/agent-comparison-service'
import { getSubagentOrchestrator } from '../agent/subagent-orchestrator'
import { wrapHandler, requireFeature } from './ipc-utils'
import type {
  AgentConfig,
  AgentModelSlot,
  Message,
  SubagentTask,
  SubagentSession
} from '../../shared/types'

export function registerAgentHandlers(): void {
  const executor = getAgentExecutor()

  // ========================================
  // Agent Execution — Pro+ tier
  // ========================================

  wrapHandler(
    IPC_CHANNELS.AGENT_EXECUTE,
    async (
      task: string,
      provider: string,
      model: string,
      conversationId?: string,
      conversationHistory?: Message[],
      systemPrompt?: string
    ) => {
      requireFeature('agentic_mode')

      // Set up event forwarding to renderer
      const mainWindow = BrowserWindow.getAllWindows()[0]
      const unsubscribe = executor.onEvent((event) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.AGENT_STEP, event)
        }
      })

      try {
        const run = await executor.execute(
          task,
          provider,
          model,
          conversationHistory ?? [],
          systemPrompt
        )

        return { success: true, run }
      } finally {
        unsubscribe()
      }
    }
  )

  // ========================================
  // Agent Cancellation
  // ========================================

  wrapHandler(
    IPC_CHANNELS.AGENT_CANCEL,
    (runId: string) => {
      const cancelled = executor.cancelRun(runId)
      return { success: true, cancelled }
    }
  )

  // ========================================
  // Agent Configuration
  // ========================================

  wrapHandler(
    IPC_CHANNELS.AGENT_GET_CONFIG,
    () => {
      return { success: true, config: executor.getConfig() }
    }
  )

  wrapHandler(
    IPC_CHANNELS.AGENT_UPDATE_CONFIG,
    (updates: Partial<AgentConfig>) => {
      requireFeature('agentic_mode')
      executor.updateConfig(updates)
      return { success: true, config: executor.getConfig() }
    }
  )

  // ========================================
  // Agent Comparison — Pro+ tier
  // ========================================

  const comparisonService = getAgentComparisonService()

  wrapHandler(
    IPC_CHANNELS.AGENT_COMPARISON_START,
    async (
      prompt: string,
      slots: AgentModelSlot[],
      systemPrompt?: string,
      conversationHistory?: Message[]
    ) => {
      requireFeature('agent_comparison')

      // Input validation
      if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new Error('Prompt is required and must be a non-empty string')
      }
      if (!Array.isArray(slots) || slots.length === 0) {
        throw new Error('At least one model slot is required')
      }
      for (const slot of slots) {
        if (!slot?.provider || !slot?.model) {
          throw new Error('Each slot must include provider and model')
        }
      }

      const mainWindow = BrowserWindow.getAllWindows()[0]

      const session = await comparisonService.runAgentComparison(
        prompt,
        slots,
        (slotIndex, event) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(
              IPC_CHANNELS.AGENT_COMPARISON_STEP,
              slotIndex,
              event
            )
          }
        },
        systemPrompt,
        conversationHistory
      )

      return { success: true, session }
    }
  )

  wrapHandler(
    IPC_CHANNELS.AGENT_COMPARISON_CANCEL,
    (sessionId: string) => {
      const cancelled = comparisonService.cancelComparison(sessionId)
      return { success: true, cancelled }
    }
  )

  // ========================================
  // Subagent Orchestration — Pro+ tier
  // ========================================

  const orchestrator = getSubagentOrchestrator()

  wrapHandler(
    IPC_CHANNELS.SUBAGENT_DECOMPOSE,
    async (
      task: string,
      masterSlot: AgentModelSlot,
      conversationHistory?: Message[],
      systemPrompt?: string
    ) => {
      requireFeature('subagent_mode')

      // Input validation
      if (!task || typeof task !== 'string' || task.trim().length === 0) {
        throw new Error('Task description is required and must be a non-empty string')
      }
      if (!masterSlot?.provider || !masterSlot?.model) {
        throw new Error('Master slot must include provider and model')
      }

      const decomposition = await orchestrator.decompose(
        task,
        masterSlot,
        conversationHistory,
        systemPrompt
      )

      return { success: true, decomposition }
    }
  )

  wrapHandler(
    IPC_CHANNELS.SUBAGENT_START,
    async (
      sessionId: string,
      tasks: SubagentTask[],
      originalTask: string,
      masterSlot: AgentModelSlot
    ) => {
      requireFeature('subagent_mode')

      // Input validation
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error('At least one subtask is required')
      }
      if (!originalTask || typeof originalTask !== 'string') {
        throw new Error('Original task description is required')
      }
      if (!masterSlot?.provider || !masterSlot?.model) {
        throw new Error('Master slot must include provider and model')
      }
      for (const task of tasks) {
        if (!task?.id || !task?.slot?.provider || !task?.slot?.model) {
          throw new Error('Each subtask must have an id and a valid slot (provider + model)')
        }
      }

      const mainWindow = BrowserWindow.getAllWindows()[0]

      // Build initial session
      const session: SubagentSession = {
        id: sessionId || nanoid(),
        masterTask: originalTask,
        masterSlot,
        decomposition: null,
        subtaskResults: [],
        synthesis: null,
        status: 'running_subtasks',
        totalTokens: { input: 0, output: 0 },
        durationMs: 0,
        createdAt: Date.now()
      }

      // Phase 2: Execute subtasks in parallel
      const results = await orchestrator.executeSubtasks(
        session.id,
        tasks,
        originalTask,
        (taskId, event) => {
          // Forward subtask events with taskId to renderer
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.SUBAGENT_STEP, taskId, event)
          }
        },
        (updatedSession) => {
          // Forward status changes to renderer
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.SUBAGENT_STATUS, updatedSession)
          }
        },
        session
      )

      session.subtaskResults = results
      session.status = 'synthesizing'

      // Forward synthesizing status
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.SUBAGENT_STATUS, session)
      }

      // Phase 3: Synthesize results
      try {
        const synthesis = await orchestrator.synthesize(
          originalTask,
          masterSlot,
          results
        )
        session.synthesis = synthesis
        session.status = 'completed'
      } catch (synthError) {
        const errorMsg = synthError instanceof Error ? synthError.message : String(synthError)
        console.error('[Subagent] Synthesis failed:', errorMsg)
        session.synthesis = null
        // Don't mask failure as 'completed' — use 'partial' when subtasks succeeded but synthesis failed
        session.status = results.some((r) => r.run.status === 'completed')
          ? 'partial'
          : 'failed'
      }

      // Calculate totals
      const endTime = Date.now()
      session.durationMs = endTime - session.createdAt
      session.totalTokens = results.reduce(
        (acc, r) => ({
          input: acc.input + r.run.totalTokens.input,
          output: acc.output + r.run.totalTokens.output
        }),
        { input: 0, output: 0 }
      )

      // Forward final status
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.SUBAGENT_STATUS, session)
      }

      return { success: true, session }
    }
  )

  wrapHandler(
    IPC_CHANNELS.SUBAGENT_CANCEL,
    (sessionId: string) => {
      const cancelled = orchestrator.cancelSession(sessionId)
      return { success: true, cancelled }
    }
  )
}
