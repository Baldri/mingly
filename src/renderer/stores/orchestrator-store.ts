import { create } from 'zustand'
import type { DelegationProposal, DelegationResult, OrchestratorConfig } from '../../main/routing/hybrid-orchestrator'

interface OrchestratorState {
  /** Whether orchestrator is enabled */
  enabled: boolean
  /** Current orchestrator config */
  config: OrchestratorConfig | null
  /** Active proposal awaiting user decision */
  activeProposal: DelegationProposal | null
  /** All pending proposals */
  proposals: DelegationProposal[]
  /** Result of the last executed delegation */
  lastResult: DelegationResult | null
  /** Whether a delegation is currently executing */
  isExecuting: boolean
  /** Whether analysis is in progress */
  isAnalyzing: boolean
  /** Error message */
  error: string | null
  /** Whether to auto-approve similar requests */
  autoApproveEnabled: boolean

  // Actions
  loadConfig: () => Promise<void>
  updateConfig: (config: Partial<OrchestratorConfig>) => Promise<void>
  analyzeMessage: (message: string, provider: string, model: string) => Promise<DelegationProposal | null>
  approveProposal: (proposalId: string) => Promise<void>
  denyProposal: (proposalId: string) => Promise<void>
  executeProposal: (proposalId: string) => Promise<DelegationResult | null>
  loadProposals: () => Promise<void>
  dismissProposal: () => void
  clearError: () => void
}

export const useOrchestratorStore = create<OrchestratorState>((set, get) => ({
  enabled: false,
  config: null,
  activeProposal: null,
  proposals: [],
  lastResult: null,
  isExecuting: false,
  isAnalyzing: false,
  error: null,
  autoApproveEnabled: false,

  loadConfig: async () => {
    try {
      const result = await window.electronAPI.orchestrator.getConfig()
      if (result.success && result.config) {
        set({ config: result.config, enabled: result.config.enabled })
      }
    } catch (error) {
      console.error('Failed to load orchestrator config:', error)
    }
  },

  updateConfig: async (config: Partial<OrchestratorConfig>) => {
    try {
      const result = await window.electronAPI.orchestrator.updateConfig(config)
      if (result.success && result.config) {
        set({ config: result.config, enabled: result.config.enabled })
      }
    } catch (error) {
      console.error('Failed to update orchestrator config:', error)
      set({ error: 'Failed to update orchestrator configuration' })
    }
  },

  analyzeMessage: async (message: string, provider: string, model: string) => {
    const { enabled } = get()
    if (!enabled) return null

    set({ isAnalyzing: true, error: null })

    try {
      const result = await window.electronAPI.orchestrator.analyze(message, provider, model)
      if (result.success && result.proposal) {
        set({
          activeProposal: result.proposal,
          proposals: [...get().proposals, result.proposal],
          isAnalyzing: false
        })
        return result.proposal
      }
      set({ isAnalyzing: false })
      return null
    } catch (error) {
      console.error('Failed to analyze message:', error)
      set({ isAnalyzing: false, error: 'Failed to analyze message for delegation' })
      return null
    }
  },

  approveProposal: async (proposalId: string) => {
    try {
      const result = await window.electronAPI.orchestrator.approve(proposalId)
      if (result.success) {
        set((state) => ({
          activeProposal: state.activeProposal?.id === proposalId
            ? { ...state.activeProposal, status: 'approved' }
            : state.activeProposal,
          proposals: state.proposals.map((p) =>
            p.id === proposalId ? { ...p, status: 'approved' as const } : p
          )
        }))

        // Auto-execute after approval
        await get().executeProposal(proposalId)
      }
    } catch (error) {
      console.error('Failed to approve proposal:', error)
      set({ error: 'Failed to approve delegation proposal' })
    }
  },

  denyProposal: async (proposalId: string) => {
    try {
      const result = await window.electronAPI.orchestrator.deny(proposalId)
      if (result.success) {
        set((state) => ({
          activeProposal: state.activeProposal?.id === proposalId ? null : state.activeProposal,
          proposals: state.proposals.map((p) =>
            p.id === proposalId ? { ...p, status: 'denied' as const } : p
          )
        }))
      }
    } catch (error) {
      console.error('Failed to deny proposal:', error)
      set({ error: 'Failed to deny delegation proposal' })
    }
  },

  executeProposal: async (proposalId: string) => {
    set({ isExecuting: true, error: null })

    try {
      const result = await window.electronAPI.orchestrator.execute(proposalId)
      if (result.success && result.result) {
        set({
          lastResult: result.result,
          activeProposal: null,
          isExecuting: false,
          proposals: get().proposals.map((p) =>
            p.id === proposalId ? { ...p, status: 'completed' as const } : p
          )
        })
        return result.result
      }
      set({ isExecuting: false, error: 'Delegation execution returned no result' })
      return null
    } catch (error) {
      console.error('Failed to execute delegation:', error)
      set({ isExecuting: false, error: 'Failed to execute delegation' })
      return null
    }
  },

  loadProposals: async () => {
    try {
      const result = await window.electronAPI.orchestrator.getProposals()
      if (result.success && result.proposals) {
        set({ proposals: result.proposals })
      }
    } catch (error) {
      console.error('Failed to load proposals:', error)
    }
  },

  dismissProposal: () => {
    set({ activeProposal: null })
  },

  clearError: () => {
    set({ error: null })
  }
}))
