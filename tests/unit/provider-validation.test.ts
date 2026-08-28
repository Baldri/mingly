/**
 * Which providers may hold credentials.
 *
 * `validateProvider` was a hardcoded list of four names. It gates both saving
 * an API key and loading one back at startup, so a provider outside the list
 * could not hold credentials at all — including the Swiss endpoint the user
 * had just configured in the settings. The token field would have failed
 * silently.
 *
 * The rule is now principled rather than enumerated: a provider earns the
 * right to hold a key by being in the provider registry. Built-ins stay
 * explicit so removing a registry entry cannot lock a user out of Anthropic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { validateProvider } from '../../src/main/ipc/ipc-utils'
import { ProviderRegistry, setProviderRegistry } from '../../src/main/routing/provider-registry'

describe('validateProvider', () => {
  let registry: ProviderRegistry

  beforeEach(() => {
    registry = new ProviderRegistry()
    setProviderRegistry(registry)
  })
  afterEach(() => setProviderRegistry(null))

  it('accepts the built-in providers without a registry entry', () => {
    for (const p of ['anthropic', 'openai', 'google', 'local']) {
      expect(validateProvider(p), p).toBe(true)
    }
  })

  it('accepts a provider we registered ourselves', () => {
    registry.registerVerified(
      { id: 'infomaniak', name: 'Infomaniak (CH)', type: 'custom', apiBase: 'https://x.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'CH', operator: 'Infomaniak Network SA, Genf', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
    )
    expect(validateProvider('infomaniak')).toBe(true)
  })

  it('accepts an endpoint the tenant registered — bring-your-own-key is the point', () => {
    registry.registerTenant({
      id: 'own-endpoint', name: 'Eigener Endpunkt', type: 'custom',
      apiBase: 'https://own.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: []
    })
    // I2 governs what residency such an endpoint may CLAIM, not whether the
    // user may store a key for something they configured themselves.
    expect(validateProvider('own-endpoint')).toBe(true)
  })

  it('rejects a provider that is neither built in nor registered', () => {
    // The gate still exists: an arbitrary string must not reach the keychain.
    expect(validateProvider('irgendwas')).toBe(false)
    expect(validateProvider('')).toBe(false)
  })

  it('stops accepting a provider once it is removed from the registry', () => {
    registry.registerVerified(
      { id: 'infomaniak', name: 'I', type: 'custom', apiBase: 'https://x.invalid/v1', apiKeyRequired: true, supportsStreaming: true, models: [] },
      { residency: 'CH', operator: 'I', weightsLicense: 'open', hostingMode: 'rented', dpaStatus: 'signed' },
      { code: 0.5, creative: 0.5, analysis: 0.5, conversation: 0.5 }
    )
    expect(validateProvider('infomaniak')).toBe(true)

    registry.remove('infomaniak')
    expect(validateProvider('infomaniak')).toBe(false)
  })
})
