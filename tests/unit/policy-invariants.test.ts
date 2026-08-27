/**
 * Invarianten I1 und I2 als Umgehungstests, nicht als Randfaelle.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the database layer — logRoutingDecision (called from
// ServiceLayer.routeWithPolicy) must not require a real sql.js database in a
// unit test. Same pattern as tests/unit/policy-audit-writer.test.ts.
vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbAll: vi.fn(() => []),
  dbGet: vi.fn()
}))

// Mock Ollama — ServiceLayer's `router` field constructs a real
// IntelligentRouter, which must not make a real network call during a unit
// test. Same pattern as tests/unit/intelligent-router.test.ts.
vi.mock('ollama', () => ({
  Ollama: vi.fn().mockImplementation(function () {
    this.list = vi.fn().mockRejectedValue(new Error('Not available'))
    this.generate = vi.fn()
  })
}))

// Neutralise ServiceLayer's other constructor dependencies. None of them run
// during routeWithPolicy — they exist only so `new ServiceLayer()` does not
// throw while pulling in Electron's `app`, disk-backed SimpleStore instances,
// and managers unrelated to the invariant under test. The router field is
// deliberately left real (see IntelligentRouter import below): it is what
// carries out the order this test exists to lock down.
vi.mock('../../src/main/llm-clients/client-manager', () => ({
  getClientManager: vi.fn(() => ({}))
}))
vi.mock('../../src/main/network/network-ai-manager', () => ({
  getNetworkAIManager: vi.fn(() => ({}))
}))
vi.mock('../../src/main/prompts/system-prompt-manager', () => ({
  getSystemPromptManager: vi.fn(() => ({}))
}))
vi.mock('../../src/main/commands/command-handler', () => ({
  getCommandHandler: vi.fn(() => ({}))
}))
vi.mock('../../src/main/rag/context-injector', () => ({
  getContextInjector: vi.fn(() => ({}))
}))
vi.mock('../../src/main/tracking/tracking-engine', () => ({
  getTrackingEngine: vi.fn(() => ({}))
}))

import { ProviderRegistry, setProviderRegistry } from '../../src/main/routing/provider-registry'
import { classify } from '../../src/main/policy/sensitivity-classifier'
import { evaluate, DEFAULT_POLICY } from '../../src/main/policy/policy-engine'
import { IntelligentRouter } from '../../src/main/routing/intelligent-router'
import { ServiceLayer } from '../../src/main/services/service-layer'
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

  it('I1: ServiceLayer.routeWithPolicy resolves the CH provider, not the best-scoring one', async () => {
    const scored = new ProviderRegistry()
    scored.registerVerified(
      { id: 'ch', name: 'CH', type: 'custom', apiBase: 'https://x.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'CH', operator: 'Infomaniak SA', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.01, creative: 0.01, analysis: 0.01, conversation: 0.01 }
    )
    scored.registerVerified(
      { id: 'us', name: 'US', type: 'custom', apiBase: 'https://y.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'US', operator: 'Frontier Inc', weightsLicense: 'closed', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 1, creative: 1, analysis: 1, conversation: 1 }
    )
    setProviderRegistry(scored)

    // If the router ran over the unfiltered registry, 'us' would win on
    // score alone — it is the best possible provider on every axis, 'ch'
    // the worst. Only the policy running first, and handing the router an
    // already-narrowed set, can make 'ch' the answer.
    const serviceLayer = new ServiceLayer()
    const result = await serviceLayer.routeWithPolicy(
      'Bitte diesen Code refactoren',
      [ahv],
      'low',
      'actor_1',
      'conv_1'
    )

    expect(result.suggestedProvider).toBe('ch')
  })
})
