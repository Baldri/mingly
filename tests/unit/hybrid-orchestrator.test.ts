/**
 * HybridOrchestrator Tests
 * Tests analyze, approve/deny state machine, execute, cost estimation, and segmentation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing
vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({
    getProvidersWithApiKeys: vi.fn(() => ['anthropic', 'openai', 'google']),
    sendMessageNonStreaming: vi.fn(async () => 'Delegated response content')
  }))
}))

vi.mock('../../src/main/routing/intelligent-router', () => ({
  getRouter: vi.fn(() => ({
    route: vi.fn(async (content: string) => ({
      suggestedProvider: 'anthropic',
      confidence: 0.9,
      category: 'code',
      reasoning: 'Code task detected'
    }))
  }))
}))

vi.mock('../../src/main/utils/id-generator', () => ({
  generateId: vi.fn(() => `test-${Math.random().toString(36).slice(2, 10)}`)
}))

import {
  HybridOrchestrator,
  DEFAULT_ORCHESTRATOR_CONFIG
} from '../../src/main/routing/hybrid-orchestrator'
import type { DelegationProposal, OrchestratorConfig } from '../../src/main/routing/hybrid-orchestrator'

describe('HybridOrchestrator', () => {
  let orchestrator: HybridOrchestrator

  beforeEach(() => {
    orchestrator = new HybridOrchestrator()
    vi.clearAllMocks()
  })

  describe('configuration', () => {
    it('should initialize with default config', () => {
      const config = orchestrator.getConfig()
      expect(config.enabled).toBe(true)
      expect(config.delegationThreshold).toBe(0.75)
      expect(config.autoApproveThreshold).toBe(0)
      expect(config.maxSubTasks).toBe(3)
    })

    it('should accept partial config overrides', () => {
      const custom = new HybridOrchestrator({ delegationThreshold: 0.5, maxSubTasks: 5 })
      const config = custom.getConfig()
      expect(config.delegationThreshold).toBe(0.5)
      expect(config.maxSubTasks).toBe(5)
      expect(config.enabled).toBe(true) // default preserved
    })

    it('should update config', () => {
      orchestrator.updateConfig({ enabled: false })
      expect(orchestrator.getConfig().enabled).toBe(false)
    })

    it('should preserve other config when updating', () => {
      orchestrator.updateConfig({ delegationThreshold: 0.6 })
      const config = orchestrator.getConfig()
      expect(config.delegationThreshold).toBe(0.6)
      expect(config.maxSubTasks).toBe(3) // unchanged
    })
  })

  describe('analyzeForDelegation', () => {
    it('should return null when disabled', async () => {
      orchestrator.updateConfig({ enabled: false })
      const result = await orchestrator.analyzeForDelegation('Write code', 'ollama', 'llama3:8b')
      expect(result).toBeNull()
    })

    it('should return proposal for numbered list message', async () => {
      const message = '1. Write a Python function to sort data\n2. Analyze the performance complexity'
      const result = await orchestrator.analyzeForDelegation(message, 'ollama', 'llama3:8b')
      expect(result).not.toBeNull()
      if (result) {
        expect(result.status).toBe('pending')
        expect(result.originalMessage).toBe(message)
        expect(result.subTasks.length).toBeGreaterThan(0)
        expect(result.estimatedCost).toBeGreaterThanOrEqual(0)
      }
    })

    it('should store proposal in pending map', async () => {
      const message = '1. Write code\n2. Test it'
      const result = await orchestrator.analyzeForDelegation(message, 'ollama', 'llama3:8b')
      expect(result).not.toBeNull()
      if (result) {
        const proposal = orchestrator.getProposal(result.id)
        expect(proposal).toBeDefined()
        expect(proposal?.id).toBe(result.id)
      }
    })

    it('should list pending proposals', async () => {
      const message = '1. Task A\n2. Task B'
      await orchestrator.analyzeForDelegation(message, 'ollama', 'llama3:8b')
      const pending = orchestrator.getPendingProposals()
      expect(pending.length).toBeGreaterThan(0)
      expect(pending[0].status).toBe('pending')
    })
  })

  describe('approve/deny state machine', () => {
    let proposal: DelegationProposal | null

    beforeEach(async () => {
      proposal = await orchestrator.analyzeForDelegation(
        '1. Write code\n2. Review it',
        'ollama',
        'llama3:8b'
      )
    })

    it('should approve a pending proposal', () => {
      expect(proposal).not.toBeNull()
      const result = orchestrator.approveProposal(proposal!.id)
      expect(result).toBe(true)
      expect(orchestrator.getProposal(proposal!.id)?.status).toBe('approved')
    })

    it('should deny a pending proposal', () => {
      expect(proposal).not.toBeNull()
      const result = orchestrator.denyProposal(proposal!.id)
      expect(result).toBe(true)
      expect(orchestrator.getProposal(proposal!.id)?.status).toBe('denied')
    })

    it('should not approve non-pending proposal', () => {
      expect(proposal).not.toBeNull()
      orchestrator.denyProposal(proposal!.id)
      const result = orchestrator.approveProposal(proposal!.id)
      expect(result).toBe(false)
    })

    it('should not deny non-pending proposal', () => {
      expect(proposal).not.toBeNull()
      orchestrator.approveProposal(proposal!.id)
      const result = orchestrator.denyProposal(proposal!.id)
      expect(result).toBe(false)
    })

    it('should return false for unknown proposal id', () => {
      expect(orchestrator.approveProposal('nonexistent')).toBe(false)
      expect(orchestrator.denyProposal('nonexistent')).toBe(false)
    })

    it('should remove from pending list after approval', () => {
      expect(proposal).not.toBeNull()
      orchestrator.approveProposal(proposal!.id)
      const pending = orchestrator.getPendingProposals()
      expect(pending.find((p) => p.id === proposal!.id)).toBeUndefined()
    })
  })

  describe('executeDelegation', () => {
    it('should return null for unapproved proposal', async () => {
      const proposal = await orchestrator.analyzeForDelegation(
        '1. Write code\n2. Test it',
        'ollama',
        'llama3:8b'
      )
      expect(proposal).not.toBeNull()
      const result = await orchestrator.executeDelegation(proposal!.id)
      expect(result).toBeNull()
    })

    it('should execute approved proposal', async () => {
      const proposal = await orchestrator.analyzeForDelegation(
        '1. Write code\n2. Test it',
        'ollama',
        'llama3:8b'
      )
      expect(proposal).not.toBeNull()
      orchestrator.approveProposal(proposal!.id)

      const result = await orchestrator.executeDelegation(proposal!.id)
      expect(result).not.toBeNull()
      if (result) {
        expect(result.proposalId).toBe(proposal!.id)
        expect(result.subTaskResults.length).toBeGreaterThan(0)
        expect(result.composedResponse).toBeTruthy()
        expect(typeof result.totalLatencyMs).toBe('number')
      }
    })

    it('should set proposal to completed after execution', async () => {
      const proposal = await orchestrator.analyzeForDelegation(
        '1. Write code\n2. Test it',
        'ollama',
        'llama3:8b'
      )
      expect(proposal).not.toBeNull()
      orchestrator.approveProposal(proposal!.id)
      await orchestrator.executeDelegation(proposal!.id)
      expect(orchestrator.getProposal(proposal!.id)?.status).toBe('completed')
    })

    it('should return null for unknown proposal id', async () => {
      const result = await orchestrator.executeDelegation('nonexistent')
      expect(result).toBeNull()
    })
  })

  describe('cost estimation', () => {
    it('should estimate cost as a number', async () => {
      const proposal = await orchestrator.analyzeForDelegation(
        '1. Write a function\n2. Add tests',
        'ollama',
        'llama3:8b'
      )
      if (proposal) {
        expect(typeof proposal.estimatedCost).toBe('number')
        expect(proposal.estimatedCost).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe('default config', () => {
    it('should have sensible defaults', () => {
      expect(DEFAULT_ORCHESTRATOR_CONFIG.enabled).toBe(true)
      expect(DEFAULT_ORCHESTRATOR_CONFIG.delegationThreshold).toBe(0.75)
      expect(DEFAULT_ORCHESTRATOR_CONFIG.autoApproveThreshold).toBe(0)
      expect(DEFAULT_ORCHESTRATOR_CONFIG.maxSubTasks).toBe(3)
      expect(DEFAULT_ORCHESTRATOR_CONFIG.preferredModels).toBeDefined()
    })

    it('should have preferred models for common categories', () => {
      const models = DEFAULT_ORCHESTRATOR_CONFIG.preferredModels
      expect(models.code).toBeDefined()
      expect(models.creative).toBeDefined()
      expect(models.analysis).toBeDefined()
    })
  })
})
