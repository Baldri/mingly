/**
 * Types shared between the orchestrator (main process) and the UI.
 *
 * They live here rather than in `src/main/routing/hybrid-orchestrator.ts`
 * because the renderer needs them: importing them from main pulled the whole
 * main-process module graph into the renderer's type-check, down to the
 * database layer and its untyped `sql.js` dependency. A type the UI renders
 * belongs to neither process in particular.
 */

/** What a request is asking for. Drives both routing and delegation. */
export type RequestCategory = 'code' | 'creative' | 'analysis' | 'general' | 'conversation'

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
