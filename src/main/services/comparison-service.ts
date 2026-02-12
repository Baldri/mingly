import { getClientManager } from '../llm-clients/client-manager'
import { ComparisonModel } from '../database/models/comparison'
import { generateId } from '../utils/id-generator'
import type { Message } from '../../shared/types'
import type { ComparisonModelConfig, ComparisonSession, ComparisonResult } from '../../shared/types'

export interface ComparisonRunResult {
  session: ComparisonSession
  results: ComparisonResult[]
  errors: Array<{ provider: string; model: string; error: string }>
}

export class ComparisonService {
  /**
   * Run a comparison: send the same prompt to multiple models in parallel.
   * Uses Promise.allSettled so one failure doesn't cancel others.
   */
  async runComparison(
    prompt: string,
    models: ComparisonModelConfig[],
    temperature: number = 0.7
  ): Promise<ComparisonRunResult> {
    const clientManager = getClientManager()
    const session = ComparisonModel.createSession(prompt, models)

    const messages: Message[] = [
      { id: generateId(), role: 'user', content: prompt }
    ]

    // Run all models in parallel with Promise.allSettled
    // Stagger by 100ms if same provider to avoid rate limits
    const providerCounts = new Map<string, number>()
    const promises = models.map((modelConfig, index) => {
      const prevCount = providerCounts.get(modelConfig.provider) || 0
      providerCounts.set(modelConfig.provider, prevCount + 1)
      const delay = prevCount * 100 // Stagger same-provider requests

      return this.runSingleModel(
        clientManager,
        session.id,
        messages,
        modelConfig,
        temperature,
        delay
      )
    })

    const settled = await Promise.allSettled(promises)

    const results: ComparisonResult[] = []
    const errors: ComparisonRunResult['errors'] = []

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]
      const modelConfig = models[i]

      if (outcome.status === 'fulfilled') {
        results.push(outcome.value)
      } else {
        const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        errors.push({
          provider: modelConfig.provider,
          model: modelConfig.model,
          error: errorMsg
        })

        // Store failed result
        results.push(
          ComparisonModel.addResult({
            sessionId: session.id,
            provider: modelConfig.provider,
            model: modelConfig.model,
            response: `[Error: ${errorMsg}]`,
            latencyMs: 0,
            isWinner: false
          })
        )
      }
    }

    return { session, results, errors }
  }

  private async runSingleModel(
    clientManager: ReturnType<typeof getClientManager>,
    sessionId: string,
    messages: Message[],
    modelConfig: ComparisonModelConfig,
    temperature: number,
    delayMs: number
  ): Promise<ComparisonResult> {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    const startTime = Date.now()

    const response = await clientManager.sendMessageNonStreaming(
      modelConfig.provider,
      messages,
      modelConfig.model,
      temperature
    )

    const latencyMs = Date.now() - startTime

    return ComparisonModel.addResult({
      sessionId,
      provider: modelConfig.provider,
      model: modelConfig.model,
      response,
      latencyMs,
      isWinner: false
    })
  }

  /**
   * Get comparison history.
   */
  getHistory(limit: number = 20) {
    return ComparisonModel.getHistory(limit)
  }

  /**
   * Mark a result as the winner for a session.
   */
  markWinner(sessionId: string, resultId: string): boolean {
    return ComparisonModel.markWinner(sessionId, resultId)
  }
}

// Singleton
let comparisonServiceInstance: ComparisonService | null = null

export function getComparisonService(): ComparisonService {
  if (!comparisonServiceInstance) {
    comparisonServiceInstance = new ComparisonService()
  }
  return comparisonServiceInstance
}
