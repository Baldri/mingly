/**
 * IPC Handlers — Agent execution, configuration, and cancellation.
 * Requires 'agentic_mode' feature gate (Pro+ tier).
 */

import { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import { getAgentExecutor } from '../agent/agent-executor'
import { wrapHandler, requireFeature } from './ipc-utils'
import type { AgentConfig, Message } from '../../shared/types'

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
}
