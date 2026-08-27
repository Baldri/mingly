/**
 * Chaining the two routing guards.
 *
 * Mingly already had a routing guard: DataClassifier decides whether a
 * provider is TRUSTED enough for the content. The policy core added a second
 * question — whether the provider sits in an acceptable JURISDICTION. Both
 * must pass, and neither may quietly answer for the other.
 */

import { describe, it, expect } from 'vitest'
import { DataSensitivity } from '../../src/main/security/data-classifier'
import type { RoutingDecision } from '../../src/main/security/data-classifier'
import type { RegistryEntry } from '../../src/main/routing/provider-registry'
import type { Residency } from '../../src/shared/provider-types'
import { DEFAULT_POLICY } from '../../src/main/policy/policy-engine'
import {
  DATA_SENSITIVITY_TO_PII,
  applyResidencyPolicy
} from '../../src/main/policy/residency-guard'

function candidate(id: string, residency: Residency): RegistryEntry {
  return {
    config: { id, name: id, type: 'custom', apiKeyRequired: true, supportsStreaming: true, models: [] },
    origin: {
      residency,
      operator: 'test',
      weightsLicense: 'open',
      hostingMode: residency === 'on-device' ? 'local' : 'rented',
      dpaStatus: residency === 'on-device' ? 'not-applicable' : 'signed'
    },
    capabilities: { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
  }
}

function trustAllows(sensitivity: DataSensitivity): RoutingDecision {
  return {
    allowed: true,
    classification: { sensitivity, reasons: [], scanResult: {} as never, allowedProviders: [] }
  }
}

const ALL = [candidate('ch', 'CH'), candidate('ollama', 'on-device'), candidate('us', 'US')]
const everythingTrusted = () => true

describe('DATA_SENSITIVITY_TO_PII', () => {
  it('maps the four trust levels onto the four protection levels in order', () => {
    expect(DATA_SENSITIVITY_TO_PII[DataSensitivity.PUBLIC]).toBe('low')
    expect(DATA_SENSITIVITY_TO_PII[DataSensitivity.INTERNAL]).toBe('medium')
    expect(DATA_SENSITIVITY_TO_PII[DataSensitivity.CONFIDENTIAL]).toBe('high')
    expect(DATA_SENSITIVITY_TO_PII[DataSensitivity.RESTRICTED]).toBe('critical')
  })
})

describe('applyResidencyPolicy', () => {
  it('leaves an existing trust block untouched', () => {
    // The trust guard already said no and carries its own reason and
    // suggestion. Re-deciding here would overwrite an answer that was given
    // on evidence this function does not have.
    const blocked: RoutingDecision = {
      allowed: false,
      reason: 'trust says no',
      suggestedProvider: 'ollama',
      classification: { sensitivity: DataSensitivity.CONFIDENTIAL, reasons: [], scanResult: {} as never, allowedProviders: [] }
    }

    expect(applyResidencyPolicy(blocked, 'us', ALL, DEFAULT_POLICY, everythingTrusted)).toBe(blocked)
  })

  it('allows a provider that both guards accept', () => {
    const result = applyResidencyPolicy(
      trustAllows(DataSensitivity.CONFIDENTIAL), 'ch', ALL, DEFAULT_POLICY, everythingTrusted
    )
    expect(result.allowed).toBe(true)
  })

  it('blocks a trusted provider that the residency policy excludes', () => {
    // This is the whole point: the trust guard is happy, the jurisdiction is not.
    const result = applyResidencyPolicy(
      trustAllows(DataSensitivity.CONFIDENTIAL), 'us', ALL, DEFAULT_POLICY, everythingTrusted
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/residency|jurisdiction|Schweiz|CH/i)
  })

  it('suggests an alternative only when that alternative is ALSO trusted', () => {
    // guardDispatch switches to a suggestion without re-running the trust
    // check, so a suggestion this function makes must already satisfy it.
    const onlyOllamaTrusted = (provider: string) => provider === 'ollama'

    const result = applyResidencyPolicy(
      trustAllows(DataSensitivity.CONFIDENTIAL), 'us', ALL, DEFAULT_POLICY, onlyOllamaTrusted
    )
    expect(result.allowed).toBe(false)
    expect(result.suggestedProvider).toBe('ollama')
  })

  it('fails closed when no permitted provider is also trusted', () => {
    const nothingTrusted = () => false

    const result = applyResidencyPolicy(
      trustAllows(DataSensitivity.CONFIDENTIAL), 'us', ALL, DEFAULT_POLICY, nothingTrusted
    )
    expect(result.allowed).toBe(false)
    expect(result.suggestedProvider).toBeUndefined()
  })

  it('does not restrict a public request to Swiss endpoints', () => {
    const result = applyResidencyPolicy(
      trustAllows(DataSensitivity.PUBLIC), 'us', ALL, DEFAULT_POLICY, everythingTrusted
    )
    expect(result.allowed).toBe(true)
  })

  it('permits on-device execution for the most sensitive content', () => {
    const result = applyResidencyPolicy(
      trustAllows(DataSensitivity.RESTRICTED), 'ollama', ALL, DEFAULT_POLICY, everythingTrusted
    )
    expect(result.allowed).toBe(true)
  })
})
