/**
 * How much this product trusts a provider with content.
 *
 * The trust table names five providers. Everything else used to fall to
 * PUBLIC — the LOWEST level — which meant a Swiss endpoint we had verified
 * ourselves was treated exactly like a provider name someone made up, and was
 * refused the confidential content it exists to handle.
 *
 * Trust is now earned in two ways, in this order:
 *
 *   1. An explicit entry in the table wins, always. This is what keeps Google
 *      rated below Anthropic and OpenAI although all three are `residency:
 *      'US'` — a judgement about a vendor that no origin field expresses.
 *   2. Otherwise a provider registered with an origin WE verified earns trust
 *      from that origin.
 *
 * A tenant-registered endpoint earns nothing: registerTenant forces
 * `residency: 'unknown'` (invariant I2), so a tenant cannot talk its own
 * endpoint into receiving confidential content.
 */

import { DataSensitivity } from './data-classifier'
import { getProviderRegistry } from '../routing/provider-registry'
import type { ProviderOrigin } from '../../shared/provider-types'

/** Vendor judgements that no origin field expresses. Always wins. */
const EXPLICIT_TRUST: Record<string, DataSensitivity> = {
  ollama: DataSensitivity.CONFIDENTIAL,
  local: DataSensitivity.CONFIDENTIAL,
  anthropic: DataSensitivity.INTERNAL,
  openai: DataSensitivity.INTERNAL,
  google: DataSensitivity.PUBLIC
}

/**
 * Trust derived from a verified origin.
 *
 * Swiss soil alone is not enough: a processor without a data processing
 * agreement is precisely what `dpaStatus` exists to record, so it earns no
 * more than an unknown provider. On-device execution needs no agreement —
 * there is no processor.
 */
function trustFromOrigin(origin: ProviderOrigin): DataSensitivity {
  if (origin.residency === 'on-device') return DataSensitivity.CONFIDENTIAL

  const covered = origin.dpaStatus === 'signed' || origin.dpaStatus === 'byok-tenant'
  if (!covered) return DataSensitivity.PUBLIC

  if (origin.residency === 'CH') return DataSensitivity.CONFIDENTIAL
  if (origin.residency === 'EU' || origin.residency === 'US') return DataSensitivity.INTERNAL

  return DataSensitivity.PUBLIC
}

export function trustForProvider(provider: string): DataSensitivity {
  const explicit = EXPLICIT_TRUST[provider]
  if (explicit !== undefined) return explicit

  const entry = getProviderRegistry().get(provider)
  if (!entry) return DataSensitivity.PUBLIC

  return trustFromOrigin(entry.origin)
}

/**
 * Every provider trust can be resolved for: the named ones plus everything
 * currently registered. This is what a fallback suggestion may be chosen
 * from — without it, a suggestion could only ever name one of the five in the
 * table, and a registered Swiss endpoint would never be offered.
 */
export function knownProviderIds(): string[] {
  const ids = new Set(Object.keys(EXPLICIT_TRUST))
  for (const entry of getProviderRegistry().all()) ids.add(entry.config.id)
  return [...ids]
}
