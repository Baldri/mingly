// Pure crypto helpers for EncryptedStore's fallback (no OS keychain) path.
// Extracted so the key handling is unit-testable without Electron.
//
// Security: the fallback key must NOT be derivable from a public value. The old
// code derived it from the (predictable) userData path, so anyone who could read
// the store file could recompute the key. getOrCreateRandomKey persists a random
// 32-byte key with owner-only permissions instead; deriveKeyFromPath is kept
// only to read data written by the old scheme.
import crypto from 'crypto'
import fs from 'fs'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const LEGACY_APP_SALT = 'mingly-secure-store-v1'

export interface GcmEntry {
  iv: string
  data: string
  tag: string
}

export function gcmEncrypt(plaintext: string, key: Buffer): GcmEntry {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return {
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export function gcmDecrypt(entry: GcmEntry, key: Buffer): string {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, 'base64'), { authTagLength: AUTH_TAG_LENGTH })
  decipher.setAuthTag(Buffer.from(entry.tag, 'base64'))
  const decrypted = Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()])
  return decrypted.toString('utf-8')
}

/** Legacy key derived from the userData path — kept ONLY to read old entries. */
export function deriveKeyFromPath(userDataPath: string): Buffer {
  return crypto.pbkdf2Sync(userDataPath, LEGACY_APP_SALT, 100_000, KEY_LENGTH, 'sha512')
}

/**
 * Load the persisted random fallback key, or generate + persist one with
 * owner-only (0600) permissions on first use.
 */
export function getOrCreateRandomKey(keyPath: string): Buffer {
  if (fs.existsSync(keyPath)) {
    const key = fs.readFileSync(keyPath)
    if (key.length === KEY_LENGTH) return key
    // Corrupt/short key file — regenerate below.
  }
  const key = crypto.randomBytes(KEY_LENGTH)
  fs.writeFileSync(keyPath, key, { mode: 0o600 })
  // Defensively tighten perms in case the file already existed with a wider mode.
  try { fs.chmodSync(keyPath, 0o600) } catch { /* best effort */ }
  return key
}
