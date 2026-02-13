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
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

// Legacy constants (for migration only)
const LEGACY_ALGORITHM = 'aes-256-gcm'
const LEGACY_IV_LENGTH = 16
const LEGACY_AUTH_TAG_LENGTH = 16
const LEGACY_KEY_LENGTH = 32
const LEGACY_APP_SALT = 'mingly-secure-store-v1'

interface LegacyEncryptedEntry {
  iv: string
  data: string
  tag: string
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

  constructor(filename: string = 'secure-keys.enc.json') {
    const userDataPath = app.getPath('userData')
    this.storePath = path.join(userDataPath, filename)
    this.useSafeStorage = safeStorage.isEncryptionAvailable()

    if (!this.useSafeStorage) {
      // Fallback: derive legacy key for environments without safeStorage
      this.legacyKey = this.deriveLegacyKey(userDataPath)
      console.warn('[EncryptedStore] safeStorage unavailable — using AES-256-GCM fallback')
    }

    this.loadFromDisk()
    this.migrateToSafeStorage()
  }

  /** Derive legacy encryption key (for migration and fallback) */
  private deriveLegacyKey(userDataPath: string): Buffer {
    return crypto.pbkdf2Sync(
      userDataPath,
      LEGACY_APP_SALT,
      100_000,
      LEGACY_KEY_LENGTH,
      'sha512'
    )
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

    // Need legacy key to decrypt old entries
    const userDataPath = app.getPath('userData')
    const legacyKey = this.deriveLegacyKey(userDataPath)

    let migrated = 0
    for (const [key, entry] of Object.entries(this.entries)) {
      if (isSafeStorageEntry(entry)) continue // Already migrated

      // Decrypt with legacy AES-256-GCM
      try {
        const plaintext = this.decryptLegacy(entry as LegacyEncryptedEntry, legacyKey)
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

  /** Decrypt a legacy AES-256-GCM entry */
  private decryptLegacy(entry: LegacyEncryptedEntry, encryptionKey: Buffer): string {
    const iv = Buffer.from(entry.iv, 'base64')
    const data = Buffer.from(entry.data, 'base64')
    const tag = Buffer.from(entry.tag, 'base64')

    const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, encryptionKey, iv, {
      authTagLength: LEGACY_AUTH_TAG_LENGTH
    })
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([
      decipher.update(data),
      decipher.final()
    ])

    return decrypted.toString('utf-8')
  }

  /** Encrypt with legacy AES-256-GCM (fallback only) */
  private encryptLegacy(plaintext: string): LegacyEncryptedEntry {
    if (!this.legacyKey) throw new Error('Legacy key not available')

    const iv = crypto.randomBytes(LEGACY_IV_LENGTH)
    const cipher = crypto.createCipheriv(LEGACY_ALGORITHM, this.legacyKey, iv, {
      authTagLength: LEGACY_AUTH_TAG_LENGTH
    })

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final()
    ])

    return {
      iv: iv.toString('base64'),
      data: encrypted.toString('base64'),
      tag: cipher.getAuthTag().toString('base64')
    }
  }

  get(key: string): string | undefined {
    const entry = this.entries[key]
    if (!entry) return undefined

    try {
      if (isSafeStorageEntry(entry)) {
        const buffer = Buffer.from(entry.encrypted, 'base64')
        return safeStorage.decryptString(buffer)
      }

      // Legacy fallback
      if (this.legacyKey) {
        return this.decryptLegacy(entry as LegacyEncryptedEntry, this.legacyKey)
      }

      // safeStorage available but entry is legacy — should have been migrated
      const userDataPath = app.getPath('userData')
      const legacyKey = this.deriveLegacyKey(userDataPath)
      return this.decryptLegacy(entry as LegacyEncryptedEntry, legacyKey)
    } catch {
      console.error(`Failed to decrypt key: ${key}`)
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
    return key in this.entries
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
