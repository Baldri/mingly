/**
 * Proves the residency policy is actually WIRED into the guard every request
 * passes through — not merely implemented next to it.
 *
 * The unit above (residency-guard.test.ts) shows the chaining logic is right.
 * This one shows getGuardDeps() uses it, which is the part a later refactor
 * could quietly drop while every other test stays green.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/main/database/index', () => ({
  dbRun: vi.fn(),
  dbAll: vi.fn(() => []),
  dbGet: vi.fn()
}))

import { getGuardDeps } from '../../src/main/security/request-guard-deps'
import { ProviderRegistry, setProviderRegistry } from '../../src/main/routing/provider-registry'

const CONFIDENTIAL = 'Der Patient hat Diagnose X und braucht eine Therapie.'

describe('residency policy is wired into the request guard', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
    registry.registerVerified(
      { id: 'anthropic', name: 'A', type: 'built-in', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'US', operator: 'Anthropic PBC', weightsLicense: 'closed', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.9, creative: 0.9, analysis: 0.9, conversation: 0.9 }
    )
    registry.registerVerified(
      { id: 'ollama', name: 'O', type: 'ollama', apiKeyRequired: false, supportsStreaming: true, models: [] },
      { residency: 'on-device', operator: 'on-device', weightsLicense: 'open', hostingMode: 'local', dpaStatus: 'not-applicable' },
      { code: 0.6, creative: 0.6, analysis: 0.6, conversation: 0.65 }
    )
    setProviderRegistry(registry)
  })

  afterEach(() => {
    setProviderRegistry(null)
  })

  it('refuses a US provider for confidential content and points at the on-device one', () => {
    const decision = getGuardDeps().checkRouting(CONFIDENTIAL, 'anthropic', 'conv_1')

    expect(decision.allowed).toBe(false)
    expect(decision.suggestedProvider).toBe('ollama')
  })

  it('accepts the on-device provider for the same content', () => {
    const decision = getGuardDeps().checkRouting(CONFIDENTIAL, 'ollama', 'conv_1')

    expect(decision.allowed).toBe(true)
  })

  it('leaves harmless content alone', () => {
    const decision = getGuardDeps().checkRouting('Wie ist das Wetter?', 'anthropic', 'conv_1')

    expect(decision.allowed).toBe(true)
  })

  it('lets the verified Swiss endpoint receive confidential content', () => {
    // The product's whole point. Before the trust resolver consulted the
    // registry, `infomaniak` was unknown to the hardcoded table, fell to the
    // LOWEST trust level, and was refused exactly this content — measured
    // 2026-08-27, its decision was identical to an invented provider name.
    registry.registerVerified(
      { id: 'infomaniak', name: 'Infomaniak (CH)', type: 'custom', apiBase: 'https://x.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'CH', operator: 'Infomaniak Network SA, Genf', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
    )

    expect(getGuardDeps().checkRouting(CONFIDENTIAL, 'infomaniak', 'conv_1').allowed).toBe(true)
  })

  it('still refuses an endpoint a tenant registered itself (I2)', () => {
    // Same Swiss claim, but registered by a tenant: registerTenant forces
    // residency to unknown, so no trust can be earned from it.
    registry.registerTenant({
      id: 'claims-to-be-swiss', name: 'Angeblich Schweiz', type: 'custom',
      apiBase: 'https://somewhere.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: []
    })

    expect(getGuardDeps().checkRouting(CONFIDENTIAL, 'claims-to-be-swiss', 'conv_1').allowed).toBe(false)
  })

  it('does not let an explicit trust rating override the jurisdiction rule', () => {
    // This is the one place the two guards can disagree, and therefore the
    // only thing the chaining actually enforces.
    //
    // `ollama` carries an explicit CONFIDENTIAL trust rating — a judgement
    // about the vendor, which wins over anything the registry says. Register
    // it with a US origin and the trust guard is satisfied while the
    // jurisdiction is not. The residency policy has to be what stops it;
    // remove the chaining from getGuardDeps and this test goes red.
    const usOllama = new ProviderRegistry()
    usOllama.registerVerified(
      { id: 'ollama', name: 'O', type: 'ollama', apiKeyRequired: false, supportsStreaming: true, models: [] },
      { residency: 'US', operator: 'Somewhere Inc', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.6, creative: 0.6, analysis: 0.6, conversation: 0.6 }
    )
    setProviderRegistry(usOllama)

    const decision = getGuardDeps().checkRouting(CONFIDENTIAL, 'ollama', 'conv_1')

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/residency/i)
  })
})
