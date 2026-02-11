/**
 * EncryptedStore - AES-256-GCM encrypted key-value storage.
 *
 * Derives a machine-bound encryption key from:
 *   - A static app salt
 *   - The userData path (unique per OS user + app)
 *
 * This ensures API keys are never stored as plaintext on disk.
 * Each value gets its own random IV for authenticated encryption.
 */

import { app } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const APP_SALT = 'mingly-secure-store-v1'

interface EncryptedEntry {
  /** Base64-encoded IV */
  iv: string
  /** Base64-encoded ciphertext */
  data: string
  /** Base64-encoded GCM auth tag */
  tag: string
}

export class EncryptedStore {
  private storePath: string
  private encryptionKey: Buffer
  private entries: Record<string, EncryptedEntry> = {}

  constructor(filename: string = 'secure-keys.enc.json') {
    const userDataPath = app.getPath('userData')
    this.storePath = path.join(userDataPath, filename)
    this.encryptionKey = this.deriveKey(userDataPath)
    this.loadFromDisk()
  }

  /**
   * Derive a deterministic 256-bit key from the app's userData path.
   * This binds the key to the current OS user + app installation.
   */
  private deriveKey(userDataPath: string): Buffer {
    return crypto.pbkdf2Sync(
      userDataPath,
      APP_SALT,
      100_000,
      KEY_LENGTH,
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

  private encrypt(plaintext: string): EncryptedEntry {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, this.encryptionKey, iv, {
      authTagLength: AUTH_TAG_LENGTH
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

  private decrypt(entry: EncryptedEntry): string {
    const iv = Buffer.from(entry.iv, 'base64')
    const data = Buffer.from(entry.data, 'base64')
    const tag = Buffer.from(entry.tag, 'base64')

    const decipher = crypto.createDecipheriv(ALGORITHM, this.encryptionKey, iv, {
      authTagLength: AUTH_TAG_LENGTH
    })
    decipher.setAuthTag(tag)

    const decrypted = Buffer.concat([
      decipher.update(data),
      decipher.final()
    ])

    return decrypted.toString('utf-8')
  }

  get(key: string): string | undefined {
    const entry = this.entries[key]
    if (!entry) return undefined

    try {
      return this.decrypt(entry)
    } catch {
      // Corrupted or tampered entry
      console.error(`Failed to decrypt key: ${key}`)
      return undefined
    }
  }

  set(key: string, value: string): void {
    this.entries[key] = this.encrypt(value)
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
