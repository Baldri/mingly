/**
 * ProviderRegistry Tests
 * Deckt Invariante I2 ab: Residenz setzen wir, nie der Mandant.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ProviderRegistry } from '../../src/main/routing/provider-registry'
import type { ProviderConfig } from '../../src/shared/provider-types'

const chConfig: ProviderConfig = {
  id: 'infomaniak',
  name: 'Infomaniak AI Tools',
  type: 'custom',
  apiBase: 'https://api.infomaniak.com/1/ai/v1',
  apiKeyRequired: true,
  supportsStreaming: true,
  models: [{ id: 'apertus', name: 'Apertus' }]
}

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
  })

  it('keeps the origin we declare for a verified provider', () => {
    registry.registerVerified(
      chConfig,
      {
        residency: 'CH',
        operator: 'Infomaniak SA',
        weightsLicense: 'open',
        hostingMode: 'rented',
        dpaStatus: 'signed'
      },
      { code: 0.7, creative: 0.6, analysis: 0.7, conversation: 0.7 }
    )

    expect(registry.get('infomaniak')?.origin.residency).toBe('CH')
    expect(registry.get('infomaniak')?.origin.operator).toBe('Infomaniak SA')
  })

  it('forces residency to unknown for a tenant-registered provider (I2)', () => {
    registry.registerTenant({ ...chConfig, id: 'tenant-endpoint' })

    const entry = registry.get('tenant-endpoint')
    expect(entry?.origin.residency).toBe('unknown')
    expect(entry?.origin.dpaStatus).toBe('none')
  })

  it('cannot be tricked by a tenant config that claims CH residency (I2)', () => {
    const claiming = { ...chConfig, id: 'liar' } as ProviderConfig & {
      origin: { residency: string }
    }
    claiming.origin = { residency: 'CH' }

    registry.registerTenant(claiming)

    expect(registry.get('liar')?.origin.residency).toBe('unknown')
  })

  it('returns undefined for an unregistered id', () => {
    expect(registry.get('nope')).toBeUndefined()
  })

  it('lists every registered entry', () => {
    registry.registerTenant({ ...chConfig, id: 'a' })
    registry.registerTenant({ ...chConfig, id: 'b' })

    expect(registry.all().map((e) => e.config.id).sort()).toEqual(['a', 'b'])
  })
})
