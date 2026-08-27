/**
 * Trust for providers the hardcoded table does not know.
 *
 * PROVIDER_TRUST lists five names. Everything else fell to PUBLIC — the
 * LOWEST level — so a verified Swiss endpoint was treated exactly like a
 * provider name someone invented, and was refused the confidential content it
 * exists to handle. Measured 2026-08-27: `infomaniak` and `irgendwas` got
 * identical decisions.
 *
 * A provider we registered ourselves, with an origin we verified, must be
 * able to earn trust from that origin. A tenant-supplied one must not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DataSensitivity } from '../../src/main/security/data-classifier'
import { ProviderRegistry, setProviderRegistry } from '../../src/main/routing/provider-registry'
import { trustForProvider } from '../../src/main/security/provider-trust'

describe('trustForProvider', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
    setProviderRegistry(registry)
  })

  afterEach(() => setProviderRegistry(null))

  it('keeps the explicit levels for the providers the table names', () => {
    // Google is deliberately rated below Anthropic/OpenAI even though all
    // three are US — that distinction is not expressible as residency and
    // must survive.
    expect(trustForProvider('anthropic')).toBe(DataSensitivity.INTERNAL)
    expect(trustForProvider('openai')).toBe(DataSensitivity.INTERNAL)
    expect(trustForProvider('google')).toBe(DataSensitivity.PUBLIC)
    expect(trustForProvider('ollama')).toBe(DataSensitivity.CONFIDENTIAL)
  })

  it('does not let a registry entry override an explicit level', () => {
    registry.registerVerified(
      { id: 'google', name: 'G', type: 'built-in', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'CH', operator: 'nope', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
    )
    expect(trustForProvider('google')).toBe(DataSensitivity.PUBLIC)
  })

  it('grants a verified Swiss endpoint the trust its origin earns', () => {
    registry.registerVerified(
      { id: 'infomaniak', name: 'Infomaniak (CH)', type: 'custom', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'CH', operator: 'Infomaniak Network SA, Genf', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
    )
    expect(trustForProvider('infomaniak')).toBe(DataSensitivity.CONFIDENTIAL)
  })

  it('grants on-device execution the highest trust', () => {
    registry.registerVerified(
      { id: 'local-llm', name: 'L', type: 'custom', apiKeyRequired: false, supportsStreaming: true, models: [] },
      { residency: 'on-device', operator: 'on-device', weightsLicense: 'open', hostingMode: 'local', dpaStatus: 'not-applicable' },
      { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
    )
    expect(trustForProvider('local-llm')).toBe(DataSensitivity.CONFIDENTIAL)
  })

  it('does NOT trust a tenant-registered endpoint (I2)', () => {
    // registerTenant forces residency to unknown, so no trust can be earned —
    // otherwise a tenant could talk itself into confidential content.
    registry.registerTenant({
      id: 'claims-to-be-swiss', name: 'X', type: 'custom',
      apiBase: 'https://somewhere.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: []
    })
    expect(trustForProvider('claims-to-be-swiss')).toBe(DataSensitivity.PUBLIC)
  })

  it('gives an entirely unknown provider the lowest trust', () => {
    expect(trustForProvider('irgendwas')).toBe(DataSensitivity.PUBLIC)
  })

  it('rates a verified EU endpoint as internal, not confidential', () => {
    registry.registerVerified(
      { id: 'eu-host', name: 'E', type: 'custom', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'EU', operator: 'Someone GmbH', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
    )
    expect(trustForProvider('eu-host')).toBe(DataSensitivity.INTERNAL)
  })

  it('does not trust a verified endpoint without a data processing agreement', () => {
    registry.registerVerified(
      { id: 'ch-no-dpa', name: 'N', type: 'custom', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'CH', operator: 'Someone AG', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'none' },
      { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
    )
    // Swiss soil is not enough on its own — a processor without an agreement
    // is exactly what the DPA field exists to record.
    expect(trustForProvider('ch-no-dpa')).toBe(DataSensitivity.PUBLIC)
  })
})
