import { getClientManager } from '../llm-clients/client-manager'
import { preflightGuard } from '../security/request-guard'
import { getGuardDeps } from '../security/request-guard-deps'
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
    const promises = models.map((modelConfig) => {
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

    // Pre-flight security guard for this specific model. A comparison targets a
    // chosen provider/model, so any block OR a routing/budget switch means this
    // model must not receive the content — fail closed (allSettled records it).
    const preflight = await preflightGuard(
      { texts: messages.map((m) => m.content), provider: modelConfig.provider, model: modelConfig.model },
      getGuardDeps(),
    )
    if (!preflight.ok) {
      throw new Error(preflight.reason ?? 'Blocked by security guard for this model')
    }
    // The switch half of the comment above, which the code did not have: a
    // routing refusal that comes WITH a suggested provider leaves `ok` true,
    // and the call below sends to `modelConfig.provider` — the provider the
    // policy had just refused. `preflight.provider` was computed and dropped,
    // so the residency verdict had no effect on a comparison slot at all.
    //
    // Substituting the suggested provider is not the fix: a comparison asks
    // what THIS model answers, and `modelConfig.model` means nothing to
    // another provider. The slot is refused, and allSettled records it next to
    // the slots that ran.
    if (preflight.switched) {
      throw new Error(
        `The routing guard refused ${modelConfig.provider} for this content ` +
          `(${preflight.switched.causes.join(' and ')} fallback). A comparison cannot ` +
          `substitute another provider for it, so this model is skipped.`
      )
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
