/**
 * Where the Infomaniak product id comes from, and what happens when it changes.
 *
 * Until now it was read from process.env only, which meant a packaged app
 * never had it and the Swiss endpoint silently failed to register. It belongs
 * in the settings, where a user can actually put it.
 *
 * The case that matters most is REMOVAL: clearing the setting has to take the
 * endpoint out of the registry. A leftover entry would keep claiming Swiss
 * residency, and the policy would keep routing sensitive requests to a URL
 * the user has disowned.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveInfomaniakProductId, applyInfomaniakConfig } from '../../src/main/config/infomaniak-config'
import { ProviderRegistry, setProviderRegistry, getProviderRegistry } from '../../src/main/routing/provider-registry'

const ENV = 'INFOMANIAK_PRODUCT_ID'

describe('resolveInfomaniakProductId', () => {
  const original = process.env[ENV]

  beforeEach(() => { delete process.env[ENV] })
  afterEach(() => {
    if (original === undefined) delete process.env[ENV]
    else process.env[ENV] = original
  })

  it('prefers the configured setting over the environment', () => {
    process.env[ENV] = 'from-env'
    expect(resolveInfomaniakProductId(() => 'from-settings')).toBe('from-settings')
  })

  it('falls back to the environment when nothing is configured', () => {
    process.env[ENV] = 'from-env'
    expect(resolveInfomaniakProductId(() => undefined)).toBe('from-env')
  })

  it('returns undefined when neither is set', () => {
    expect(resolveInfomaniakProductId(() => undefined)).toBeUndefined()
  })

  it('treats blank and whitespace-only values as unset', () => {
    process.env[ENV] = '  '
    expect(resolveInfomaniakProductId(() => '   ')).toBeUndefined()
  })

  it('trims a pasted value', () => {
    expect(resolveInfomaniakProductId(() => '  110908\n')).toBe('110908')
  })
})

describe('applyInfomaniakConfig', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
    setProviderRegistry(registry)
  })
  afterEach(() => setProviderRegistry(null))

  it('registers the Swiss endpoint with the configured id', () => {
    applyInfomaniakConfig('110908')

    expect(getProviderRegistry().get('infomaniak')?.config.apiBase).toBe(
      'https://api.infomaniak.com/2/ai/110908/openai/v1'
    )
    expect(getProviderRegistry().get('infomaniak')?.origin.residency).toBe('CH')
  })

  it('picks up a changed id without a restart', () => {
    applyInfomaniakConfig('110908')
    applyInfomaniakConfig('222333')

    expect(getProviderRegistry().get('infomaniak')?.config.apiBase).toBe(
      'https://api.infomaniak.com/2/ai/222333/openai/v1'
    )
  })

  it('REMOVES the endpoint when the id is cleared', () => {
    applyInfomaniakConfig('110908')
    expect(getProviderRegistry().get('infomaniak')).toBeDefined()

    applyInfomaniakConfig(undefined)

    // A leftover entry would keep claiming Swiss residency for a URL the user
    // has disowned — and the policy would keep routing sensitive requests to it.
    expect(getProviderRegistry().get('infomaniak')).toBeUndefined()
  })

  it('leaves other providers alone when clearing', () => {
    registry.registerVerified(
      { id: 'anthropic', name: 'A', type: 'built-in', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'US', operator: 'Anthropic PBC', weightsLicense: 'closed', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.9, creative: 0.9, analysis: 0.9, conversation: 0.9 }
    )
    applyInfomaniakConfig('110908')
    applyInfomaniakConfig(undefined)

    expect(getProviderRegistry().get('anthropic')).toBeDefined()
  })

  it('is a no-op when clearing something that was never registered', () => {
    expect(() => applyInfomaniakConfig(undefined)).not.toThrow()
    expect(getProviderRegistry().get('infomaniak')).toBeUndefined()
  })
})
