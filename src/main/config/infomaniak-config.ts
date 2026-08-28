/**
 * Where the Infomaniak product id comes from.
 *
 * The base URL is account-specific — one AI product per organisation, and the
 * id is part of the path — so it is configuration, never a constant. It used
 * to be read from `process.env` alone, which meant a packaged, GUI-launched
 * app never had it and the Swiss endpoint silently failed to register.
 *
 * It belongs in the settings, where a user can actually enter it. The
 * environment stays as a fallback for development and for headless runs.
 * Settings win: a value someone typed into the app beats one the process
 * happened to inherit.
 */

import { getProviderRegistry, seedSwissProviders } from '../routing/provider-registry'
import { getClientManager } from '../llm-clients/client-manager'

const ENV_VAR = 'INFOMANIAK_PRODUCT_ID'

/** Blank, whitespace-only and unset all mean the same thing: not configured. */
function normalise(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Resolve the product id, settings first.
 *
 * `getConfigured` is injected so this stays testable without the settings
 * store and its Electron dependencies.
 */
export function resolveInfomaniakProductId(
  getConfigured: () => string | undefined
): string | undefined {
  return normalise(getConfigured()) ?? normalise(process.env[ENV_VAR])
}

/**
 * Bring the registry in line with the configured id.
 *
 * Called at startup and again whenever the setting changes, so a user does
 * not have to restart the app to make a Swiss endpoint appear — or disappear.
 * Clearing the id REMOVES the entry rather than leaving the previous URL in
 * place; a stale entry would still claim Swiss residency and still receive
 * the requests that claim earns it.
 */
export function applyInfomaniakConfig(productId: string | undefined): void {
  const registry = getProviderRegistry()
  const id = normalise(productId)

  if (!id) {
    registry.remove('infomaniak')
    // Drop the in-memory key too: with no endpoint there is nothing to send,
    // and a leftover client must not be able to. The keychain copy stays, so
    // re-entering the id does not require re-entering the token.
    getClientManager().clearApiKey('infomaniak')
    return
  }

  seedSwissProviders(registry, id)

  // The registry decides whether a provider MAY receive a request; the client
  // manager is what can actually send one. Registering only the first would
  // leave the endpoint selectable but unreachable.
  const entry = registry.get('infomaniak')
  if (entry) getClientManager().registerCustomProvider(entry.config)
}
