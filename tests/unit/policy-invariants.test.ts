/**
 * Invarianten I1 und I2 als Umgehungstests, nicht als Randfaelle.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ProviderRegistry, setProviderRegistry } from '../../src/main/routing/provider-registry'
import { classify } from '../../src/main/policy/sensitivity-classifier'
import { evaluate, DEFAULT_POLICY } from '../../src/main/policy/policy-engine'
import { IntelligentRouter } from '../../src/main/routing/intelligent-router'
import type { PIIEntity } from '../../src/main/privacy/pii-types'

const ahv: PIIEntity = {
  category: 'AHV',
  original: '756.1234.5678.90',
  start: 0,
  end: 16,
  confidence: 1,
  source: 'swiss',
  sensitivity: 'critical'
}

describe('policy invariants', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
    registry.registerVerified(
      { id: 'ch', name: 'CH', type: 'custom', apiBase: 'https://x.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'CH', operator: 'Infomaniak SA', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
    )
    registry.registerVerified(
      { id: 'us', name: 'US', type: 'custom', apiBase: 'https://y.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'US', operator: 'Frontier Inc', weightsLicense: 'closed', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.99, creative: 0.99, analysis: 0.99, conversation: 0.99 }
    )
    setProviderRegistry(registry)
  })

  it('I1: the best-scoring provider loses to the policy', async () => {
    const classification = classify([ahv], 'low')
    const decision = evaluate(DEFAULT_POLICY, classification, registry.all())

    expect(decision.allowed).toEqual(['ch'])

    const router = new IntelligentRouter()
    const result = await router.route('Bitte diesen Code refactoren', decision.allowed)

    expect(result.suggestedProvider).toBe('ch')
  })

  it('I1: a permitted set of zero does not resolve to a provider', async () => {
    const onlyUs = new ProviderRegistry()
    onlyUs.registerVerified(
      { id: 'us', name: 'US', type: 'custom', apiBase: 'https://y.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'US', operator: 'Frontier Inc', weightsLicense: 'closed', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.99, creative: 0.99, analysis: 0.99, conversation: 0.99 }
    )
    setProviderRegistry(onlyUs)

    const decision = evaluate(DEFAULT_POLICY, classify([ahv], 'low'), onlyUs.all())
    expect(decision.allowed).toEqual([])

    const router = new IntelligentRouter()
    const result = await router.route('Egal was', decision.allowed)
    expect(result.suggestedProvider).toBe('')
    expect(result.confidence).toBe(0)
  })

  it('I2: a tenant endpoint claiming CH cannot receive a sensitive request', () => {
    registry.registerTenant({
      id: 'liar',
      name: 'Angeblich Schweiz',
      type: 'custom',
      apiBase: 'https://somewhere.invalid/v1',
      apiKeyRequired: true,
      supportsStreaming: true,
      models: []
    })

    const decision = evaluate(DEFAULT_POLICY, classify([ahv], 'low'), registry.all())

    expect(decision.allowed).not.toContain('liar')
    expect(decision.allowed).toEqual(['ch'])
  })
})
