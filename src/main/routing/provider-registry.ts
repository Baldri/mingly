/**
 * ProviderRegistry — providers with their origin and task fitness.
 *
 * Invariant I2: residency is ours to declare. A tenant may register an
 * endpoint, but never its origin — registerTenant overwrites whatever the
 * config claims. Without that, one mislabelled endpoint defeats the whole
 * residency promise while the audit trail records the breach as compliant.
 */

import type {
  ProviderConfig,
  ProviderOrigin,
  ProviderCapabilities
} from '../../shared/provider-types'
import { BUILT_IN_PROVIDERS } from '../../shared/provider-types'

export interface RegistryEntry {
  config: ProviderConfig
  origin: ProviderOrigin
  capabilities: ProviderCapabilities
}

/** Fitness assumed for an endpoint we have not measured. */
const UNMEASURED_CAPABILITIES: ProviderCapabilities = {
  code: 0.5,
  creative: 0.5,
  analysis: 0.5,
  conversation: 0.5
}

/** Origin forced onto anything a tenant registers itself. */
const TENANT_ORIGIN: ProviderOrigin = {
  residency: 'unknown',
  operator: 'tenant-supplied',
  weightsLicense: 'closed',
  hostingMode: 'rented',
  dpaStatus: 'none'
}

export class ProviderRegistry {
  private entries: Map<string, RegistryEntry> = new Map()

  /** Register a provider whose origin we have verified ourselves. */
  registerVerified(
    config: ProviderConfig,
    origin: ProviderOrigin,
    capabilities: ProviderCapabilities
  ): void {
    const frozenOrigin = Object.freeze({ ...origin })
    const frozenCapabilities = Object.freeze({ ...capabilities })
    const entry: RegistryEntry = { config, origin: frozenOrigin, capabilities: frozenCapabilities }
    this.entries.set(config.id, Object.freeze(entry))
  }

  /**
   * Register a tenant-supplied endpoint. Origin is forced (I2) — any origin
   * on the incoming config is discarded, not merged.
   */
  registerTenant(config: ProviderConfig): void {
    const frozenOrigin = Object.freeze({ ...TENANT_ORIGIN })
    const frozenCapabilities = Object.freeze({ ...UNMEASURED_CAPABILITIES })
    const entry: RegistryEntry = { config, origin: frozenOrigin, capabilities: frozenCapabilities }
    this.entries.set(config.id, Object.freeze(entry))
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id)
  }

  all(): RegistryEntry[] {
    return Array.from(this.entries.values())
  }
}

/** Origin and measured fitness of the providers we ship with. */
export function seedBuiltInProviders(registry: ProviderRegistry): void {
  const closedUs = {
    weightsLicense: 'closed' as const,
    hostingMode: 'rented' as const,
    dpaStatus: 'signed' as const,
    residency: 'US' as const
  }

  registry.registerVerified(
    BUILT_IN_PROVIDERS.anthropic,
    { ...closedUs, operator: 'Anthropic PBC' },
    { code: 0.95, creative: 0.85, analysis: 0.9, conversation: 0.95 }
  )
  registry.registerVerified(
    BUILT_IN_PROVIDERS.openai,
    { ...closedUs, operator: 'OpenAI' },
    { code: 0.85, creative: 0.95, analysis: 0.85, conversation: 0.9 }
  )
  registry.registerVerified(
    BUILT_IN_PROVIDERS.google,
    { ...closedUs, operator: 'Google LLC' },
    { code: 0.8, creative: 0.75, analysis: 0.95, conversation: 0.8 }
  )
  registry.registerVerified(
    BUILT_IN_PROVIDERS.ollama,
    {
      residency: 'CH',
      operator: 'on-device',
      weightsLicense: 'open',
      hostingMode: 'local',
      dpaStatus: 'signed'
    },
    { code: 0.6, creative: 0.6, analysis: 0.6, conversation: 0.65 }
  )
}

let registryInstance: ProviderRegistry | null = null

export function getProviderRegistry(): ProviderRegistry {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry()
    seedBuiltInProviders(registryInstance)
  }
  return registryInstance
}

/** Test seam — reset the singleton between test cases. */
export function setProviderRegistry(registry: ProviderRegistry | null): void {
  registryInstance = registry
}
