/**
 * A text comparison must not send content to a provider the routing guard
 * refused for it.
 *
 * comparison-service.ts:91-93 says of its own preflight call: "any block OR a
 * routing/budget switch means this model must not receive the content — fail
 * closed". The code only ever checked `!preflight.ok`. A routing refusal that
 * comes WITH a suggested provider is not a block — guardDispatch returns
 * `ok: true` with the provider replaced — and `runSingleModel` then called
 * `sendMessageNonStreaming(modelConfig.provider, ...)`, the provider the policy
 * had just refused. `preflight.provider` was computed and dropped.
 *
 * So for a comparison slot the residency verdict had no effect at all. Measured
 * here against the CALL the client manager received, not against the guard's
 * return value: what the guard concluded and what went over the wire are two
 * different questions, and only the second one is the defect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

/** Provider -> model pairs the client manager was actually asked to call. */
const sentTo: { provider: string; model: string }[] = []

vi.mock('../../src/main/database/models/comparison', () => ({
  ComparisonModel: {
    createSession: vi.fn(() => ({ id: 'session-1', prompt: '', models: [], createdAt: Date.now() })),
    addResult: vi.fn((data: Record<string, unknown>) => ({ id: 'result-1', ...data })),
    getHistory: vi.fn(() => []),
    markWinner: vi.fn(() => true),
    getSessionResults: vi.fn(() => [])
  }
}))

vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({
    sendMessageNonStreaming: vi.fn(async (provider: string, _msgs: unknown[], model: string) => {
      sentTo.push({ provider, model })
      return `Response from ${provider}/${model}`
    })
  }))
}))

vi.mock('../../src/main/utils/id-generator', () => ({
  generateId: vi.fn(() => 'id-1')
}))

/** Rewired per test. */
let routingVerdict: { allowed: boolean; suggestedProvider?: string; reason?: string } = { allowed: true }

vi.mock('../../src/main/security/request-guard-deps', () => ({
  getGuardDeps: () => ({
    sanitize: () => ({ safe: true, riskScore: 0, warnings: [] }),
    scanSensitive: () => ({ hasSensitiveData: false, matches: [], overallRiskLevel: 'none' }),
    checkUploadPermission: async () => ({ decision: 'allowed', requiresUserConsent: false }),
    checkBudget: () => ({ allowed: true }),
    checkRouting: () => routingVerdict,
    isCloudProvider: (provider: string) => provider !== 'ollama',
    scanOutput: () => ({ violations: [] })
  })
}))

const { ComparisonService } = await import('../../src/main/services/comparison-service')

describe('a comparison slot the routing guard refused', () => {
  let service: InstanceType<typeof ComparisonService>

  beforeEach(() => {
    sentTo.length = 0
    routingVerdict = { allowed: true }
    service = new ComparisonService()
  })

  it('positive control: an allowed slot is sent to the provider it names', async () => {
    const out = await service.runComparison('Hallo', [{ provider: 'anthropic', model: 'claude-3-5-sonnet' }])

    expect(sentTo).toEqual([{ provider: 'anthropic', model: 'claude-3-5-sonnet' }])
    expect(out.errors).toHaveLength(0)
  })

  it('is not sent to that provider, even though a fallback was suggested', async () => {
    routingVerdict = { allowed: false, suggestedProvider: 'ollama', reason: 'residency' }

    await service.runComparison('Der Patient hat Diagnose X.', [
      { provider: 'anthropic', model: 'claude-3-5-sonnet' }
    ])

    expect(sentTo).toEqual([])
  })

  it('is reported as an error for that slot, not silently dropped', async () => {
    routingVerdict = { allowed: false, suggestedProvider: 'ollama', reason: 'residency' }

    const out = await service.runComparison('Der Patient hat Diagnose X.', [
      { provider: 'anthropic', model: 'claude-3-5-sonnet' }
    ])

    expect(out.errors).toHaveLength(1)
    expect(out.errors[0].provider).toBe('anthropic')
    expect(out.errors[0].error).toContain('anthropic')
  })

  it('does not quietly substitute the suggested provider either — a comparison means THIS model', async () => {
    routingVerdict = { allowed: false, suggestedProvider: 'ollama', reason: 'residency' }

    await service.runComparison('Der Patient hat Diagnose X.', [
      { provider: 'anthropic', model: 'claude-3-5-sonnet' }
    ])

    // Sending `claude-3-5-sonnet` to ollama would be a different, nonsensical
    // run; the slot is refused instead.
    expect(sentTo.some((c) => c.provider === 'ollama')).toBe(false)
  })

  it('one refused slot does not take the allowed ones down with it', async () => {
    routingVerdict = { allowed: false, suggestedProvider: 'ollama', reason: 'residency' }

    const out = await service.runComparison('Der Patient hat Diagnose X.', [
      { provider: 'anthropic', model: 'claude-3-5-sonnet' },
      { provider: 'anthropic', model: 'claude-3-opus' }
    ])

    expect(out.errors).toHaveLength(2)
    expect(sentTo).toEqual([])
  })
})
