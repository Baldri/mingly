import { KEYCHAIN_SERVICE } from '../../shared/constants'
import type { LLMProvider } from '../../shared/types'
import { EncryptedStore } from '../utils/encrypted-store'
import { SimpleStore } from '../utils/simple-store'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

// AES-256-GCM encrypted storage for API keys
const secureStore = new EncryptedStore('secure-keys.enc.json')

export class KeychainManager {
  private serviceName = KEYCHAIN_SERVICE
  private migrated = false

  /**
   * Migrate plaintext keys from the old SimpleStore to the encrypted store.
   * Runs once on first access, then deletes the old plaintext file.
   */
  private migrateFromPlaintext(): void {
    if (this.migrated) return
    this.migrated = true

    const oldPath = path.join(app.getPath('userData'), 'secure-keys.json')
    if (!fs.existsSync(oldPath)) return

    try {
      const content = fs.readFileSync(oldPath, 'utf-8')
      const oldData = JSON.parse(content)

      let migratedCount = 0
      for (const [key, value] of Object.entries(oldData)) {
        if (typeof value === 'string' && value.length > 0 && !secureStore.has(key)) {
          secureStore.set(key, value)
          migratedCount++
        }
      }

      // Delete the plaintext file after successful migration
      fs.unlinkSync(oldPath)
      if (migratedCount > 0) {
        console.log(`Migrated ${migratedCount} API key(s) to encrypted storage`)
      }
    } catch (error) {
      console.error('Failed to migrate plaintext keys:', error)
    }
  }

  /**
   * Save an API key to encrypted storage (AES-256-GCM)
   */
  async saveAPIKey(provider: LLMProvider, apiKey: string): Promise<void> {
    this.migrateFromPlaintext()

    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error('API key cannot be empty')
    }

    const key = `${provider}-api-key`
    secureStore.set(key, apiKey)
    console.log(`API key saved for ${provider}`)
  }

  /**
   * Retrieve an API key from encrypted storage
   */
  async getAPIKey(provider: LLMProvider): Promise<string | null> {
    this.migrateFromPlaintext()

    const key = `${provider}-api-key`
    const apiKey = secureStore.get(key)
    return apiKey || null
  }

  /**
   * Delete an API key from encrypted storage
   */
  async deleteAPIKey(provider: LLMProvider): Promise<boolean> {
    this.migrateFromPlaintext()

    const key = `${provider}-api-key`

    if (!secureStore.has(key)) {
      return false
    }

    secureStore.delete(key)
    console.log(`API key deleted for ${provider}`)
    return true
  }

  /**
   * List all configured providers (that have API keys stored)
   */
  async listConfiguredProviders(): Promise<LLMProvider[]> {
    this.migrateFromPlaintext()

    const providers: LLMProvider[] = []
    const allProviders: LLMProvider[] = ['anthropic', 'openai', 'google']

    for (const provider of allProviders) {
      const key = `${provider}-api-key`
      if (secureStore.has(key)) {
        providers.push(provider)
      }
    }

    return providers
  }

  /**
   * Check if an API key exists for a provider
   */
  async hasAPIKey(provider: LLMProvider): Promise<boolean> {
    const apiKey = await this.getAPIKey(provider)
    return apiKey !== null && apiKey.length > 0
  }
}
