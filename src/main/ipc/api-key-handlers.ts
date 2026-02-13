/**
 * IPC Handlers — API Key Management
 */

import { IPC_CHANNELS } from '../../shared/types'
import type { LLMProvider } from '../../shared/types'
import { KeychainManager } from '../security/keychain-manager'
import { getClientManager } from '../llm-clients/client-manager'
import { wrapHandler, requirePermission, validateProvider } from './ipc-utils'

export function registerApiKeyHandlers(): void {
  const keychainManager = new KeychainManager()
  const clientManager = getClientManager()

  wrapHandler(IPC_CHANNELS.SAVE_API_KEY, async (provider: LLMProvider, apiKey: string) => {
    requirePermission('settings.api_keys')
    await keychainManager.saveAPIKey(provider, apiKey)
    if (validateProvider(provider)) {
      clientManager.setApiKey(provider, apiKey)
    }
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.GET_API_KEY, async (provider: LLMProvider) => {
    const apiKey = await keychainManager.getAPIKey(provider)
    return { success: true, apiKey }
  })

  wrapHandler(IPC_CHANNELS.DELETE_API_KEY, async (provider: LLMProvider) => {
    requirePermission('settings.api_keys')
    await keychainManager.deleteAPIKey(provider)
    return { success: true }
  })

  wrapHandler(IPC_CHANNELS.LIST_API_KEYS, async () => {
    const providers = await keychainManager.listConfiguredProviders()
    return { success: true, providers }
  })

  wrapHandler(IPC_CHANNELS.VALIDATE_API_KEY, async (provider: LLMProvider) => {
    if (!validateProvider(provider)) {
      return { success: false, valid: false, error: 'Invalid provider' }
    }
    const isValid = await clientManager.validateApiKey(provider)
    return { success: true, valid: isValid }
  })

  // Initialize keys from keychain at startup
  initializeAPIKeys(keychainManager, clientManager)
}

async function initializeAPIKeys(keychainManager: KeychainManager, clientManager: ReturnType<typeof getClientManager>): Promise<void> {
  try {
    const providers = await keychainManager.listConfiguredProviders()
    for (const provider of providers) {
      if (validateProvider(provider)) {
        const apiKey = await keychainManager.getAPIKey(provider)
        if (apiKey) {
          clientManager.setApiKey(provider, apiKey)
        }
      }
    }
    console.log(`✅ Initialized API keys for ${providers.length} providers`)
  } catch (error) {
    console.error('Failed to initialize API keys:', error)
  }
}
