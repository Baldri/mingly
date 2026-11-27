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
import { createLogger } from '../../shared/logger'

const logger = createLogger('ProviderRegistry')

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

/**
 * Origin forced onto a server on the user's own network.
 *
 * Same residency as a tenant endpoint, for the same reason, but the other
 * three fields are not the same statement and the audit log should not say
 * they are: the user typed this machine's address, so they host it, and no
 * third party rented it to them.
 *
 * `residency: 'unknown'` is the honest value, not a placeholder. The app sees
 * an address on a private network; it cannot tell who operates that machine
 * or which country it stands in. That buys ordinary content a route to it and
 * keeps confidential content away — and it still counts as cloud
 * (`residencyIsCloud`), so the sensitive-data scan and the upload consent run.
 *
 * `dpaStatus: 'none'` rather than `'not-applicable'`: an agreement is missing,
 * which is a different statement from there being no processor at all. If a
 * later reading of `trustFromOrigin` treats `not-applicable` as covered — the
 * type's own comment invites it, since on-device execution needs no agreement
 * — this entry must not quietly earn trust from it.
 *
 * `weightsLicense: 'closed'` is the no-claim direction: an
 * `openai-compatible` server on the LAN can proxy anything, open weights or
 * not. Neither this field nor `hostingMode` is read by a guard (measured
 * 27.11.2026: only `residency` and `dpaStatus` are), so both carry the
 * cautious reading rather than a guess.
 */
const LOCAL_NETWORK_ORIGIN: ProviderOrigin = {
  residency: 'unknown',
  operator: 'user-operated (local network)',
  weightsLicense: 'closed',
  hostingMode: 'self-hosted',
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
   * Register with an origin WE choose, discarding anything the config claims.
   *
   * The single place invariant I2 is enforced, so the two registrations that
   * accept an endpoint from outside cannot drift apart in how strictly they
   * apply it.
   */
  private registerWithForcedOrigin(config: ProviderConfig, origin: ProviderOrigin): void {
    const entry: RegistryEntry = {
      config,
      origin: Object.freeze({ ...origin }),
      capabilities: Object.freeze({ ...UNMEASURED_CAPABILITIES })
    }
    this.entries.set(config.id, Object.freeze(entry))
  }

  /**
   * Register a tenant-supplied endpoint. Origin is forced (I2) — any origin
   * on the incoming config is discarded, not merged.
   */
  registerTenant(config: ProviderConfig): void {
    this.registerWithForcedOrigin(config, TENANT_ORIGIN)
  }

  /**
   * Register a server the user runs on their own network. Origin is forced
   * exactly as for a tenant endpoint — the configuration names an endpoint,
   * never its residency.
   */
  registerLocalNetwork(config: ProviderConfig): void {
    this.registerWithForcedOrigin(config, LOCAL_NETWORK_ORIGIN)
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id)
  }

  /**
   * Forget a provider.
   *
   * Needed because configuration can be withdrawn: when a user clears the
   * Infomaniak product id, the entry must go. Leaving it would keep an
   * endpoint claiming Swiss residency for a URL nobody stands behind any
   * more, and the policy would keep routing sensitive requests to it.
   */
  remove(id: string): void {
    this.entries.delete(id)
  }

  all(): RegistryEntry[] {
    return Array.from(this.entries.values())
  }
}

/**
 * Swiss endpoints.
 *
 * The base URL is account-specific: Infomaniak exposes one AI product per
 * organisation and the product id is part of the path
 * (`/2/ai/{product_id}/openai/v1`, verified against the developer portal on
 * 2026-08-26). It is therefore configuration, never a constant — without a
 * configured id we register nothing rather than a URL that cannot answer.
 *
 * `models` stays empty on purpose. Which models the account serves is answered
 * by `GET /models` against that endpoint. Queried on 2026-08-27, the account
 * returns `swiss-ai/Apertus-v1.5-70B` among 11 models; the list stays empty
 * here so the registry does not carry a copy that silently ages.
 *
 * Capabilities stay at the unmeasured default: no published benchmark
 * figures exist for Apertus 1.5, and the eval-framework suitability run
 * (`examples/modell_eignungspruefung.py`) has not been run against this
 * endpoint. Claiming a score here would be an assertion where the offering
 * promises a measurement.
 */
export function seedSwissProviders(
  registry: ProviderRegistry,
  infomaniakProductId: string | undefined
): void {
  if (!infomaniakProductId) {
    logger.warn(
      'No Swiss endpoint registered: INFOMANIAK_PRODUCT_ID is not set. ' +
        'Any policy rule that requires Swiss residency will be evaluated ' +
        'without Infomaniak as a candidate.'
    )
    return
  }

  registry.registerVerified(
    {
      id: 'infomaniak',
      name: 'Infomaniak (CH)',
      type: 'custom',
      apiBase: `https://api.infomaniak.com/2/ai/${infomaniakProductId}/openai/v1`,
      apiKeyRequired: true,
      supportsStreaming: true,
      supportsFunctionCalling: true,
      models: [],
      badge: 'CH',
      color: '#0098FF'
    },
    {
      residency: 'CH',
      operator: 'Infomaniak Network SA, Genf',
      weightsLicense: 'open',
      hostingMode: 'rented',
      dpaStatus: 'signed'
    },
    { ...UNMEASURED_CAPABILITIES }
  )
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
  // Ollama, under BOTH ids it answers to. `local` is an alias for the same
  // OllamaClient (client-manager.ts:76-77) and a member of LLMProvider, and it
  // is the id the new-conversation picker stores when the user chooses a local
  // model (NewConversationModal.tsx:172) — the choice the UI captions "no data
  // leaves your machine".
  //
  // Registering only `ollama` left the guards reading `local` as an id nobody
  // had declared an origin for, and the two "unknown provider" defaults then
  // broke the promise from both directions (measured 26.11.2026):
  //   - applyResidencyPolicy compared `local` against a candidate list that
  //     could never contain it and rerouted the run to `anthropic`, i.e. from
  //     on-device to US soil;
  //   - residencyIsCloud(undefined) is true, so a local run carrying sensitive
  //     data was treated as a cloud upload and fail-closed in the agent path.
  //
  // One origin object for both, so the alias cannot drift away from the
  // provider it aliases.
  const onDevice = {
    residency: 'on-device' as const,
    operator: 'on-device',
    weightsLicense: 'open' as const,
    hostingMode: 'local' as const,
    dpaStatus: 'not-applicable' as const
  }
  const ollamaFitness = { code: 0.6, creative: 0.6, analysis: 0.6, conversation: 0.65 }

  registry.registerVerified(BUILT_IN_PROVIDERS.ollama, onDevice, ollamaFitness)
  registry.registerVerified(
    { ...BUILT_IN_PROVIDERS.ollama, id: 'local', name: 'Local Models' },
    onDevice,
    ollamaFitness
  )
}

let registryInstance: ProviderRegistry | null = null

export function getProviderRegistry(): ProviderRegistry {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry()
    seedBuiltInProviders(registryInstance)
    seedSwissProviders(registryInstance, process.env.INFOMANIAK_PRODUCT_ID)
  }
  return registryInstance
}

/** Test seam — reset the singleton between test cases. */
export function setProviderRegistry(registry: ProviderRegistry | null): void {
  registryInstance = registry
}
