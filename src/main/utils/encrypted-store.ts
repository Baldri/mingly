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
  private useSafeStorage = false
  private initialized = false
  private legacyKey: Buffer | null = null
  private fallbackKey: Buffer | null = null
  /** Keys whose ciphertext is present but could not be decrypted this run. */
  private unreadable = new Set<string>()
  /**
   * The store file existed but could not be read or parsed. The bytes are then
   * never overwritten: the next save moves them aside first (see saveToDisk).
   */
  private loadFailed = false

  constructor(filename: string = 'secure-keys.enc.json') {
    this.storePath = path.join(app.getPath('userData'), filename)
  }

  /**
   * Choose the backend on first use, not in the constructor. Stores are
   * created at module load, before app 'ready', and since Electron 44
   * safeStorage reports itself unavailable on macOS until 'ready' — deciding
   * early would silently downgrade every new secret to the file-key fallback.
   */
  private ensureInitialized(): void {
    if (this.initialized) return
    this.initialized = true

    if (!app.isReady()) {
      console.warn('[EncryptedStore] Accessed before app ready — safeStorage may be reported unavailable')
    }

    const userDataPath = app.getPath('userData')
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
      // Unreadable or unparseable. Start empty IN MEMORY so the app keeps
      // working, but remember it: the bytes on disk are the user's only copy
      // of their secrets, and this branch must never be the reason they go.
      this.entries = {}
      this.loadFailed = true
    }
  }

  /**
   * Move a store file we could not read out of the way, before the first write
   * replaces it. Named rather than deleted: whatever went wrong may be fixable
   * later, and then the ciphertext is still there.
   *
   * Returns false when the bytes are STILL IN PLACE, which means they must not
   * be overwritten. `loadFailed` then stays set, so the next save tries the
   * preservation again.
   *
   * The first version of this cleared `loadFailed` before attempting the
   * rename — "a failed rename must not make every later save retry it" — and
   * saveToDisk wrote regardless. A rename that threw therefore produced exactly
   * the outcome this mechanism exists to prevent. Retrying two syscalls per
   * save is the cheaper mistake, so that is the one taken.
   */
  private preserveUnreadableFile(): boolean {
    if (!this.loadFailed) return true
    if (!fs.existsSync(this.storePath)) {
      // Nothing to preserve: whatever made the load fail is no longer there.
      this.loadFailed = false
      return true
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const kept = `${this.storePath}.unreadable-${stamp}`

    // Rename first: atomic, and it leaves no second copy of the secrets behind.
    try {
      fs.renameSync(this.storePath, kept)
      this.loadFailed = false
      return true
    } catch (error) {
      console.error('[EncryptedStore] Could not rename the unreadable store aside:', error)
    }

    // A copy preserves the bytes too, and then the original may be replaced.
    // Attempted separately because the two fail for different reasons: a rename
    // across devices (EXDEV) or a directory that allows writing a file but not
    // unlinking one.
    try {
      fs.copyFileSync(this.storePath, kept)
      this.loadFailed = false
      return true
    } catch (error) {
      console.error('[EncryptedStore] Could not copy the unreadable store aside:', error)
    }

    return false
  }

  private saveToDisk(): void {
    if (!this.preserveUnreadableFile()) {
      // Not a silent failure: a write error below is reported the same way, so
      // this is the contract this class already has. What it buys is that the
      // user's only copy of their secrets is still on disk afterwards.
      console.error(
        '[EncryptedStore] Not writing: the existing store could not be read and could not be ' +
          'preserved, and writing would destroy the only copy of the stored secrets. ' +
          `Move ${this.storePath} aside by hand to continue.`
      )
      return
    }
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
    this.ensureInitialized()
    const entry = this.entries[key]
    if (!entry) return undefined

    try {
      const value = isSafeStorageEntry(entry)
        ? safeStorage.decryptString(Buffer.from(entry.encrypted, 'base64'))
        : // Legacy / fallback entry — keyFor picks the right key by keyId.
          this.decryptLegacy(entry as LegacyEncryptedEntry)
      this.unreadable.delete(key)
      return value
    } catch {
      // Decrypt failed — typically because the OS refuses this binary the key
      // material (a dismissed keychain prompt, an ACL a rebuild invalidated).
      //
      // This used to delete the entry and save, on the reasoning that the user
      // can just re-enter the key. It cost a real user all three of their API
      // keys three seconds after a rebuilt app first started, with no notice
      // and no way back. "I cannot read this right now" is not "this is
      // worthless": the ciphertext is intact and may well be readable again
      // once the cause is gone. Destroying it removes that possibility, so the
      // entry stays and the caller is told it is unreadable instead.
      this.unreadable.add(key)
      console.error(`[EncryptedStore] Failed to decrypt key "${key}" — keeping the stored value. Re-enter the API key in Settings if it stays unreadable.`)
      return undefined
    }
  }

  /**
   * Is this key stored but undecryptable? Distinguishes "not configured" from
   * "configured, and we cannot read it" — the two look identical through
   * `get`/`has`, and only the second one is worth telling the user about.
   */
  isUnreadable(key: string): boolean {
    this.ensureInitialized()
    if (!(key in this.entries)) return false
    if (this.unreadable.has(key)) return true
    // Not attempted yet in this run: answering the question is what settles it.
    this.get(key)
    return this.unreadable.has(key)
  }

  set(key: string, value: string): void {
    this.ensureInitialized()
    if (this.useSafeStorage) {
      const encrypted = safeStorage.encryptString(value)
      this.entries[key] = { encrypted: encrypted.toString('base64'), v: 2 }
    } else {
      this.entries[key] = this.encryptLegacy(value)
    }
    this.saveToDisk()
  }

  has(key: string): boolean {
    this.ensureInitialized()
    if (!(key in this.entries)) return false
    // Verify the entry is actually readable (not corrupted by re-signing)
    return this.get(key) !== undefined
  }

  delete(key: string): void {
    this.ensureInitialized()
    delete this.entries[key]
    this.saveToDisk()
  }

  clear(): void {
    this.ensureInitialized()
    this.entries = {}
    this.saveToDisk()
  }
}

