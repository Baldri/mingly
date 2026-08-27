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
    this.entries.set(config.id, { config, origin, capabilities })
  }

  /**
   * Register a tenant-supplied endpoint. Origin is forced (I2) — any origin
   * on the incoming config is discarded, not merged.
   */
  registerTenant(config: ProviderConfig): void {
    this.entries.set(config.id, {
      config,
      origin: { ...TENANT_ORIGIN },
      capabilities: { ...UNMEASURED_CAPABILITIES }
    })
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id)
  }

  all(): RegistryEntry[] {
    return Array.from(this.entries.values())
  }
}

let registryInstance: ProviderRegistry | null = null

export function getProviderRegistry(): ProviderRegistry {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry()
  }
  return registryInstance
}

/** Test seam — reset the singleton between test cases. */
export function setProviderRegistry(registry: ProviderRegistry | null): void {
  registryInstance = registry
}
