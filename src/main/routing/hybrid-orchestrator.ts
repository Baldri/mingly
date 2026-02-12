/**
 * Hybrid LLM Orchestrator
 *
 * Enables intelligent task delegation across local, network, and cloud LLMs.
 * The primary LLM (local or network) can detect when a sub-task would be
 * better handled by a different model and request delegation — with user
 * approval.
 *
 * Flow:
 * 1. User sends message to primary (local/network) LLM
 * 2. Orchestrator analyzes the response for delegation opportunities
 * 3. If delegation is beneficial, creates a DelegationProposal
 * 4. User approves/denies the proposal
 * 5. If approved, sub-task is sent to the optimal cloud model
 * 6. Results are composed back into the conversation
 */

import { getClientManager } from '../llm-clients/client-manager'
import { getRouter, type RequestCategory } from './intelligent-router'
import { generateId } from '../utils/id-generator'
import type { Message } from '../../shared/types'

// ── Types ───────────────────────────────────────────────────────

export interface SubTask {
  id: string
  description: string
  category: RequestCategory
  content: string
  suggestedProvider: string
  suggestedModel: string
  confidence: number
  reasoning: string
}

export interface DelegationProposal {
  id: string
  /** The original user message */
  originalMessage: string
  /** The primary LLM's analysis of why delegation helps */
  analysis: string
  /** Sub-tasks to delegate */
  subTasks: SubTask[]
  /** Total estimated cost if delegated */
  estimatedCost: number
  /** Status */
  status: 'pending' | 'approved' | 'denied' | 'completed' | 'failed'
  /** Timestamp */
  createdAt: number
}

export interface DelegationResult {
  proposalId: string
  subTaskResults: Array<{
    subTaskId: string
    provider: string
    model: string
    response: string
    tokens?: number
    cost?: number
    latencyMs: number
  }>
  composedResponse: string
  totalCost: number
  totalLatencyMs: number
}

export interface OrchestratorConfig {
  /** Enable hybrid orchestration */
  enabled: boolean
  /** Minimum confidence to suggest delegation (0-1) */
  delegationThreshold: number
  /** Auto-delegate below this cost threshold (USD) without user approval */
  autoApproveThreshold: number
  /** Maximum sub-tasks per delegation */
  maxSubTasks: number
  /** Preferred models for each category */
  preferredModels: Partial<Record<RequestCategory, { provider: string; model: string }>>
}

export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  enabled: true,
  delegationThreshold: 0.75,
  autoApproveThreshold: 0, // Always require approval by default
  maxSubTasks: 3,
  preferredModels: {
    code: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
    creative: { provider: 'openai', model: 'gpt-4-turbo' },
    analysis: { provider: 'google', model: 'gemini-1.5-flash' }
  }
}

// ── Cost Estimates (per 1K tokens) ──────────────────────────────

const COST_PER_1K: Record<string, { input: number; output: number }> = {
  'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
  'claude-3-sonnet': { input: 0.003, output: 0.015 },
  'claude-3-haiku': { input: 0.00025, output: 0.00125 },
  'gpt-4-turbo': { input: 0.01, output: 0.03 },
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 },
  'gemini-1.5-flash': { input: 0.000075, output: 0.0003 },
  'gemini-pro': { input: 0.00025, output: 0.0005 }
}

// ── Orchestrator ────────────────────────────────────────────────

export class HybridOrchestrator {
  private config: OrchestratorConfig
  private pendingProposals: Map<string, DelegationProposal> = new Map()

  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = { ...DEFAULT_ORCHESTRATOR_CONFIG, ...config }
  }

  /**
   * Analyze a user message and determine if sub-task delegation would help.
   * Returns a DelegationProposal if delegation is recommended.
   */
  async analyzeForDelegation(
    userMessage: string,
    currentProvider: string,
    _currentModel: string
  ): Promise<DelegationProposal | null> {
    if (!this.config.enabled) return null

    const clientManager = getClientManager()

    // Get available cloud providers
    const availableProviders = clientManager.getProvidersWithApiKeys()
      .filter(p => p !== 'ollama' && p !== 'local' && p !== currentProvider)

    if (availableProviders.length === 0) return null

    // Analyze the message for complexity and potential sub-tasks
    const subTasks = await this.decomposeMessage(userMessage, availableProviders)

    if (subTasks.length === 0) return null

    // Filter sub-tasks that exceed the delegation threshold
    const worthDelegating = subTasks.filter(st => st.confidence >= this.config.delegationThreshold)

    if (worthDelegating.length === 0) return null

    // Estimate cost
    const estimatedCost = this.estimateCost(worthDelegating)

    const proposal: DelegationProposal = {
      id: generateId(),
      originalMessage: userMessage,
      analysis: this.buildAnalysis(worthDelegating, currentProvider),
      subTasks: worthDelegating.slice(0, this.config.maxSubTasks),
      estimatedCost,
      status: 'pending',
      createdAt: Date.now()
    }

    this.pendingProposals.set(proposal.id, proposal)
    return proposal
  }

  /**
   * Decompose a message into potential sub-tasks using heuristics.
   */
  private async decomposeMessage(
    userMessage: string,
    availableProviders: string[]
  ): Promise<SubTask[]> {
    const router = getRouter()
    const subTasks: SubTask[] = []

    // Check if message contains multiple distinct requests
    const segments = this.segmentMessage(userMessage)

    for (const segment of segments) {
      // Route each segment to find the best provider
      const routing = await router.route(segment.content, availableProviders)

      if (routing.confidence >= this.config.delegationThreshold) {
        const preferredModel = this.config.preferredModels[routing.category]

        subTasks.push({
          id: generateId(),
          description: segment.description,
          category: routing.category,
          content: segment.content,
          suggestedProvider: preferredModel?.provider || routing.suggestedProvider,
          suggestedModel: preferredModel?.model || this.getDefaultModel(routing.suggestedProvider),
          confidence: routing.confidence,
          reasoning: routing.reasoning
        })
      }
    }

    return subTasks
  }

  /**
   * Segment a complex message into distinct sub-requests.
   */
  private segmentMessage(message: string): Array<{ content: string; description: string }> {
    const segments: Array<{ content: string; description: string }> = []

    // Pattern 1: Numbered lists ("1. Do this 2. Do that")
    const numberedPattern = /(?:^|\n)\s*\d+[.)]\s+(.+?)(?=(?:\n\s*\d+[.)]\s+)|$)/gs
    const numberedMatches = [...message.matchAll(numberedPattern)]

    if (numberedMatches.length >= 2) {
      for (const match of numberedMatches) {
        segments.push({
          content: match[1].trim(),
          description: match[1].trim().substring(0, 80)
        })
      }
      return segments
    }

    // Pattern 2: "and" / "also" / "then" connectors splitting distinct tasks
    const connectorPattern = /\b(?:and also|and then|also|additionally|furthermore|then)\b/i
    if (connectorPattern.test(message) && message.length > 200) {
      const parts = message.split(connectorPattern).map(p => p.trim()).filter(p => p.length > 20)
      if (parts.length >= 2) {
        for (const part of parts) {
          segments.push({
            content: part,
            description: part.substring(0, 80)
          })
        }
        return segments
      }
    }

    // Pattern 3: Complex single request (code + analysis, etc.)
    const hasCodeRequest = /(?:write|implement|code|function|class|debug|fix)\b/i.test(message)
    const hasAnalysisRequest = /(?:analyze|explain|compare|evaluate|summarize)\b/i.test(message)
    const hasCreativeRequest = /(?:write.*story|create.*content|brainstorm|imagine)\b/i.test(message)

    const requestTypes = [hasCodeRequest, hasAnalysisRequest, hasCreativeRequest].filter(Boolean).length

    if (requestTypes >= 2) {
      // Complex mixed request — treat whole message as a single delegation candidate
      segments.push({
        content: message,
        description: 'Complex multi-domain request'
      })
    }

    return segments
  }

  /**
   * Execute approved delegation
   */
  async executeDelegation(proposalId: string): Promise<DelegationResult | null> {
    const proposal = this.pendingProposals.get(proposalId)
    if (!proposal || proposal.status !== 'approved') return null

    const clientManager = getClientManager()
    const results: DelegationResult['subTaskResults'] = []
    const startTime = Date.now()

    // Execute each sub-task
    for (const subTask of proposal.subTasks) {
      const taskStartTime = Date.now()

      try {
        const messages: Message[] = [
          {
            id: generateId(),
            role: 'system',
            content: `You are handling a delegated sub-task. Category: ${subTask.category}. Be concise and focused.`
          },
          {
            id: generateId(),
            role: 'user',
            content: subTask.content
          }
        ]

        const response = await clientManager.sendMessageNonStreaming(
          subTask.suggestedProvider,
          messages,
          subTask.suggestedModel,
          0.7
        )

        results.push({
          subTaskId: subTask.id,
          provider: subTask.suggestedProvider,
          model: subTask.suggestedModel,
          response,
          latencyMs: Date.now() - taskStartTime
        })
      } catch (error) {
        results.push({
          subTaskId: subTask.id,
          provider: subTask.suggestedProvider,
          model: subTask.suggestedModel,
          response: `[Delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}]`,
          latencyMs: Date.now() - taskStartTime
        })
      }
    }

    // Compose results
    const composedResponse = this.composeResults(proposal, results)
    const totalCost = results.reduce((sum, r) => sum + (r.cost || 0), 0)

    proposal.status = 'completed'

    return {
      proposalId,
      subTaskResults: results,
      composedResponse,
      totalCost,
      totalLatencyMs: Date.now() - startTime
    }
  }

  /**
   * Approve a pending delegation proposal
   */
  approveProposal(proposalId: string): boolean {
    const proposal = this.pendingProposals.get(proposalId)
    if (!proposal || proposal.status !== 'pending') return false
    proposal.status = 'approved'
    return true
  }

  /**
   * Deny a pending delegation proposal
   */
  denyProposal(proposalId: string): boolean {
    const proposal = this.pendingProposals.get(proposalId)
    if (!proposal || proposal.status !== 'pending') return false
    proposal.status = 'denied'
    return true
  }

  /**
   * Get a pending proposal
   */
  getProposal(proposalId: string): DelegationProposal | undefined {
    return this.pendingProposals.get(proposalId)
  }

  /**
   * Get all pending proposals
   */
  getPendingProposals(): DelegationProposal[] {
    return Array.from(this.pendingProposals.values())
      .filter(p => p.status === 'pending')
  }

  /**
   * Update orchestrator configuration
   */
  updateConfig(partial: Partial<OrchestratorConfig>): void {
    this.config = { ...this.config, ...partial }
  }

  /**
   * Get current config
   */
  getConfig(): OrchestratorConfig {
    return { ...this.config }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private buildAnalysis(subTasks: SubTask[], _currentProvider: string): string {
    if (subTasks.length === 1) {
      const st = subTasks[0]
      return `This ${st.category} task would benefit from ${st.suggestedProvider}/${st.suggestedModel} ` +
        `(confidence: ${Math.round(st.confidence * 100)}%). ${st.reasoning}`
    }

    const taskList = subTasks
      .map(st => `- ${st.description}: ${st.suggestedProvider}/${st.suggestedModel} (${st.category})`)
      .join('\n')

    return `This request contains ${subTasks.length} sub-tasks that could be delegated to specialized models:\n${taskList}`
  }

  private estimateCost(subTasks: SubTask[]): number {
    let totalCost = 0

    for (const subTask of subTasks) {
      const pricing = COST_PER_1K[subTask.suggestedModel]
      if (pricing) {
        // Rough estimate: ~500 input tokens, ~1000 output tokens per sub-task
        totalCost += (0.5 * pricing.input) + (1.0 * pricing.output)
      }
    }

    return Math.round(totalCost * 10000) / 10000 // Round to 4 decimals
  }

  private getDefaultModel(provider: string): string {
    switch (provider) {
      case 'anthropic': return 'claude-3-5-sonnet-20241022'
      case 'openai': return 'gpt-4-turbo'
      case 'google': return 'gemini-1.5-flash'
      default: return 'gpt-3.5-turbo'
    }
  }

  private composeResults(
    proposal: DelegationProposal,
    results: DelegationResult['subTaskResults']
  ): string {
    if (results.length === 1) {
      return results[0].response
    }

    const sections = results.map((r, i) => {
      const subTask = proposal.subTasks[i]
      return `### ${subTask?.description || `Part ${i + 1}`}\n*via ${r.provider}/${r.model}*\n\n${r.response}`
    })

    return `# Delegated Results\n\n${sections.join('\n\n---\n\n')}`
  }
}

// ── Singleton ───────────────────────────────────────────────────

let orchestratorInstance: HybridOrchestrator | null = null

export function getHybridOrchestrator(): HybridOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new HybridOrchestrator()
  }
  return orchestratorInstance
}
