/**
 * EncryptedStore - Secure key-value storage using Electron's safeStorage API.
 *
 * Uses the OS-native credential store:
 *   - macOS: Keychain
 *   - Windows: DPAPI (Data Protection API)
 *   - Linux: Secret Service (GNOME Keyring / KDE Wallet)
 *
 * Falls back to AES-256-GCM file encryption when safeStorage is unavailable.
 * Automatically migrates old AES-encrypted entries to safeStorage on first use.
 */

import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { gcmEncrypt, gcmDecrypt, deriveKeyFromPath, getOrCreateRandomKey } from './encrypted-store-crypto'

interface LegacyEncryptedEntry {
  iv: string
  data: string
  tag: string
  /** 'random' = new per-install fallback key; absent = legacy path-derived key. */
  keyId?: 'random'
}

interface SafeStorageEntry {
  /** Base64-encoded safeStorage-encrypted buffer */
  encrypted: string
  /** Version marker to distinguish from legacy format */
  v: 2
}

type StoreEntry = LegacyEncryptedEntry | SafeStorageEntry

function isSafeStorageEntry(entry: StoreEntry): entry is SafeStorageEntry {
  return 'v' in entry && entry.v === 2
}

export class EncryptedStore {
  private storePath: string
  private entries: Record<string, StoreEntry> = {}
  private useSafeStorage: boolean
  private legacyKey: Buffer | null = null
  private fallbackKey: Buffer | null = null

  constructor(filename: string = 'secure-keys.enc.json') {
    const userDataPath = app.getPath('userData')
    this.storePath = path.join(userDataPath, filename)
    this.useSafeStorage = safeStorage.isEncryptionAvailable()

    if (!this.useSafeStorage) {
      // Fallback (no OS keychain): use a persisted RANDOM key, not one derived
      // from the predictable userData path. The path-derived key is kept only
      // to read entries written by the old scheme.
      this.legacyKey = this.deriveLegacyKey(userDataPath)
      this.fallbackKey = getOrCreateRandomKey(this.storePath + '.key')
      console.warn('[EncryptedStore] safeStorage unavailable — using AES-256-GCM fallback')
    }

    this.loadFromDisk()
    this.migrateToSafeStorage()
  }

  /** Derive legacy encryption key (for migration and fallback) */
  private deriveLegacyKey(userDataPath: string): Buffer {
    return deriveKeyFromPath(userDataPath)
  }

  private ensureFallbackKey(): Buffer {
    if (!this.fallbackKey) this.fallbackKey = getOrCreateRandomKey(this.storePath + '.key')
    return this.fallbackKey
  }

  private ensurePathKey(): Buffer {
    if (!this.legacyKey) this.legacyKey = deriveKeyFromPath(app.getPath('userData'))
    return this.legacyKey
  }

  /** Pick the decryption key: random fallback key for current-scheme entries,
   *  else the legacy path-derived key for old data. */
  private keyFor(entry: LegacyEncryptedEntry): Buffer {
    return entry.keyId === 'random' ? this.ensureFallbackKey() : this.ensurePathKey()
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const content = fs.readFileSync(this.storePath, 'utf-8')
        this.entries = JSON.parse(content)
      }
    } catch {
      this.entries = {}
    }
  }

  private saveToDisk(): void {
    try {
      fs.writeFileSync(
        this.storePath,
        JSON.stringify(this.entries, null, 2),
        'utf-8'
      )
    } catch (error) {
      console.error('Failed to save encrypted store:', error)
    }
  }

  /**
   * Migrate legacy AES-256-GCM entries to safeStorage format.
   * Only runs when safeStorage is available and legacy entries exist.
   */
  private migrateToSafeStorage(): void {
    if (!this.useSafeStorage) return

    let migrated = 0
    for (const [key, entry] of Object.entries(this.entries)) {
      if (isSafeStorageEntry(entry)) continue // Already migrated

      // Decrypt with legacy AES-256-GCM
      try {
        const plaintext = this.decryptLegacy(entry as LegacyEncryptedEntry)
        // Re-encrypt with safeStorage
        const encrypted = safeStorage.encryptString(plaintext)
        this.entries[key] = { encrypted: encrypted.toString('base64'), v: 2 }
        migrated++
      } catch {
        console.error(`[EncryptedStore] Failed to migrate key: ${key}`)
      }
    }

    if (migrated > 0) {
      this.saveToDisk()
      console.log(`[EncryptedStore] Migrated ${migrated} key(s) to safeStorage`)
    }
  }

  /** Decrypt an AES-256-GCM entry, picking the right key by its keyId. */
  private decryptLegacy(entry: LegacyEncryptedEntry): string {
    return gcmDecrypt(entry, this.keyFor(entry))
  }

  /** Encrypt with the random fallback key (used only when safeStorage is off). */
  private encryptLegacy(plaintext: string): LegacyEncryptedEntry {
    return { ...gcmEncrypt(plaintext, this.ensureFallbackKey()), keyId: 'random' }
  }

  get(key: string): string | undefined {
    const entry = this.entries[key]
    if (!entry) return undefined

    try {
      if (isSafeStorageEntry(entry)) {
        const buffer = Buffer.from(entry.encrypted, 'base64')
        return safeStorage.decryptString(buffer)
      }

      // Legacy / fallback entry — keyFor picks the right key by keyId.
      return this.decryptLegacy(entry as LegacyEncryptedEntry)
    } catch {
      // Decrypt failed — likely caused by adhoc re-signing after rebuild.
      // Remove the corrupted entry so the user can re-enter the key cleanly.
      console.error(`[EncryptedStore] Failed to decrypt key "${key}" — removing corrupted entry. Re-enter the API key in Settings.`)
      delete this.entries[key]
      this.saveToDisk()
      return undefined
    }
  }

  set(key: string, value: string): void {
    if (this.useSafeStorage) {
      const encrypted = safeStorage.encryptString(value)
      this.entries[key] = { encrypted: encrypted.toString('base64'), v: 2 }
    } else {
      this.entries[key] = this.encryptLegacy(value)
    }
    this.saveToDisk()
  }

  has(key: string): boolean {
    if (!(key in this.entries)) return false
    // Verify the entry is actually readable (not corrupted by re-signing)
    return this.get(key) !== undefined
  }

  delete(key: string): void {
    delete this.entries[key]
    this.saveToDisk()
  }

  clear(): void {
    this.entries = {}
    this.saveToDisk()
  }
}
