/**
 * KeychainManager Tests
 * Tests API key storage and retrieval via encrypted store.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/mingly-keychain-test'
  }
}))

// Store mock state via vi.hoisted so it's available during vi.mock hoisting
const mockStore = vi.hoisted(() => ({
  get: vi.fn().mockReturnValue(null),
  set: vi.fn(),
  has: vi.fn().mockReturnValue(false),
  delete: vi.fn()
}))

vi.mock('../../src/main/utils/encrypted-store', () => ({
  EncryptedStore: vi.fn().mockImplementation(function () {
    Object.assign(this, mockStore)
  })
}))

vi.mock('../../src/main/utils/simple-store', () => ({
  SimpleStore: vi.fn().mockImplementation(function () {
    this.get = vi.fn()
    this.set = vi.fn()
  })
}))

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn()
  },
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn()
}))

import { KeychainManager } from '../../src/main/security/keychain-manager'

describe('KeychainManager', () => {
  let manager: KeychainManager

  beforeEach(() => {
    vi.clearAllMocks()
    mockStore.get.mockReturnValue(null)
    mockStore.has.mockReturnValue(false)
    manager = new KeychainManager()
  })

  describe('saveAPIKey', () => {
    it('should save an API key', async () => {
      await manager.saveAPIKey('anthropic', 'sk-test-key')
      expect(mockStore.set).toHaveBeenCalledWith('anthropic-api-key', 'sk-test-key')
    })

    it('should reject empty API key', async () => {
      await expect(manager.saveAPIKey('openai', '')).rejects.toThrow('API key cannot be empty')
    })

    it('should reject whitespace-only API key', async () => {
      await expect(manager.saveAPIKey('google', '   ')).rejects.toThrow('API key cannot be empty')
    })
  })

  describe('getAPIKey', () => {
    it('should return null when no key stored', async () => {
      mockStore.get.mockReturnValue(null)
      const key = await manager.getAPIKey('anthropic')
      expect(key).toBeNull()
    })

    it('should return stored API key', async () => {
      mockStore.get.mockReturnValue('sk-stored')
      const key = await manager.getAPIKey('anthropic')
      expect(key).toBe('sk-stored')
    })
  })

  describe('deleteAPIKey', () => {
    it('should return false when no key exists', async () => {
      mockStore.has.mockReturnValue(false)
      const result = await manager.deleteAPIKey('anthropic')
      expect(result).toBe(false)
    })

    it('should delete and return true when key exists', async () => {
      mockStore.has.mockReturnValue(true)
      const result = await manager.deleteAPIKey('anthropic')
      expect(result).toBe(true)
      expect(mockStore.delete).toHaveBeenCalledWith('anthropic-api-key')
    })
  })

  describe('listConfiguredProviders', () => {
    it('should return empty list when no keys stored', async () => {
      mockStore.has.mockReturnValue(false)
      const providers = await manager.listConfiguredProviders()
      expect(providers).toEqual([])
    })

    it('should return providers that have keys', async () => {
      mockStore.has.mockImplementation((key: string) => {
        return key === 'anthropic-api-key' || key === 'openai-api-key'
      })

      const providers = await manager.listConfiguredProviders()
      expect(providers).toContain('anthropic')
      expect(providers).toContain('openai')
      expect(providers).not.toContain('google')
    })
  })

  describe('hasAPIKey', () => {
    it('should return false when no key', async () => {
      mockStore.get.mockReturnValue(null)
      expect(await manager.hasAPIKey('anthropic')).toBe(false)
    })

    it('should return true when key exists', async () => {
      mockStore.get.mockReturnValue('sk-key')
      expect(await manager.hasAPIKey('anthropic')).toBe(true)
    })

    it('should return false for empty string key', async () => {
      mockStore.get.mockReturnValue('')
      expect(await manager.hasAPIKey('anthropic')).toBe(false)
    })
  })
})
