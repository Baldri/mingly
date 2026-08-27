/**
 * ProviderRegistry Tests
 * Deckt Invariante I2 ab: Residenz setzen wir, nie der Mandant.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { ProviderRegistry, seedSwissProviders } from '../../src/main/routing/provider-registry'
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

  it('protects tenant origin from mutation through read reference', () => {
    registry.registerTenant({ ...chConfig, id: 'tenant' })

    const entry = registry.get('tenant')
    expect(entry).toBeDefined()

    // Attempt to mutate the origin. In strict mode this throws; in sloppy mode it
    // silently no-ops on a frozen object. Either way, the mutation must not stick.
    try {
      entry!.origin.residency = 'CH'
    } catch {
      // Silent no-op in sloppy mode, or throws in strict mode. Both are ok.
    }

    // Fresh read proves the mutation did not stick.
    const fresh = registry.get('tenant')
    expect(fresh?.origin.residency).toBe('unknown')
  })
})

describe('Swiss providers', () => {
  it('builds the account-specific base URL from the product id', () => {
    const registry = new ProviderRegistry()
    seedSwissProviders(registry, '12345')

    expect(registry.get('infomaniak')?.config.apiBase).toBe(
      'https://api.infomaniak.com/2/ai/12345/openai/v1'
    )
  })

  it('registers Infomaniak with Swiss residency and open weights', () => {
    const registry = new ProviderRegistry()
    seedSwissProviders(registry, '12345')

    const entry = registry.get('infomaniak')
    expect(entry?.origin.residency).toBe('CH')
    expect(entry?.origin.weightsLicense).toBe('open')
    expect(entry?.origin.hostingMode).toBe('rented')
  })

  it('registers nothing when no product id is configured', () => {
    const registry = new ProviderRegistry()
    seedSwissProviders(registry, undefined)

    expect(registry.get('infomaniak')).toBeUndefined()
  })

  it('does not claim a task-fitness score it has not measured', () => {
    const registry = new ProviderRegistry()
    seedSwissProviders(registry, '12345')

    const caps = registry.get('infomaniak')?.capabilities
    expect(caps).toEqual({ code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 })
  })
})
