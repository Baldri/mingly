import { describe, it, expect } from 'vitest'
import { evaluate, DEFAULT_POLICY } from '../../src/main/policy/policy-engine'
import type { RegistryEntry } from '../../src/main/routing/provider-registry'
import type { Classification } from '../../src/main/policy/policy-types'
import type { Residency } from '../../src/shared/provider-types'

function candidate(id: string, residency: Residency): RegistryEntry {
  return {
    config: {
      id,
      name: id,
      type: 'custom',
      apiKeyRequired: true,
      supportsStreaming: true,
      models: []
    },
    origin: {
      residency,
      operator: 'test',
      weightsLicense: 'open',
      hostingMode: 'rented',
      dpaStatus: 'signed'
    },
    capabilities: { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
  }
}

function classification(level: Classification['level']): Classification {
  return {
    level,
    reason: 'test',
    bySource: { regex: 0, ner: 0, swiss: 0, custom: 0 }
  }
}

const CANDIDATES = [
  candidate('infomaniak', 'CH'),
  candidate('anthropic', 'US'),
  candidate('tenant', 'unknown')
]

describe('evaluate', () => {
  it('restricts a high-sensitivity request to Swiss endpoints', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('high'), CANDIDATES)
    expect(decision.allowed).toEqual(['infomaniak'])
  })

  it('restricts a critical request to Swiss endpoints too', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('critical'), CANDIDATES)
    expect(decision.allowed).toEqual(['infomaniak'])
  })

  it('excludes unknown residency above the lowest level (I2)', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('medium'), CANDIDATES)
    expect(decision.allowed).not.toContain('tenant')
  })

  it('permits every verified residency at the lowest level', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('low'), CANDIDATES)
    expect(decision.allowed).toContain('infomaniak')
    expect(decision.allowed).toContain('anthropic')
  })

  it('names the rule that applied', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('high'), CANDIDATES)
    expect(decision.appliedRule).toBe('sensitive-stays-ch')
  })

  it('carries the policy version into the decision', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('low'), CANDIDATES)
    expect(decision.policyVersion).toBe(DEFAULT_POLICY.version)
  })

  it('returns an empty set rather than falling back when nothing qualifies', () => {
    const decision = evaluate(DEFAULT_POLICY, classification('critical'), [
      candidate('anthropic', 'US')
    ])
    expect(decision.allowed).toEqual([])
  })
})
