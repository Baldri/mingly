/**
 * EncryptedStore Tests
 * Validates AES-256-GCM encryption for API key storage.
 *
 * Note: We test the crypto logic directly since the EncryptedStore
 * class depends on Electron's `app` module. We extract and test
 * the core encrypt/decrypt logic here.
 */

import { describe, it, expect } from 'vitest'
import crypto from 'crypto'

// Replicate the encryption constants from encrypted-store.ts
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const APP_SALT = 'mingly-secure-store-v1'

function deriveKey(secret: string): Buffer {
  return crypto.pbkdf2Sync(secret, APP_SALT, 100_000, KEY_LENGTH, 'sha512')
}

interface EncryptedEntry {
  iv: string
  data: string
  tag: string
}

function encrypt(plaintext: string, key: Buffer): EncryptedEntry {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
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

function decrypt(entry: EncryptedEntry, key: Buffer): string {
  const iv = Buffer.from(entry.iv, 'base64')
  const data = Buffer.from(entry.data, 'base64')
  const tag = Buffer.from(entry.tag, 'base64')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH
  })
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([
    decipher.update(data),
    decipher.final()
  ])
  return decrypted.toString('utf-8')
}

describe('EncryptedStore Crypto Logic', () => {
  const testKey = deriveKey('/test/user/data/path')

  describe('Key Derivation', () => {
    it('should derive a 32-byte key', () => {
      expect(testKey.length).toBe(32)
    })

    it('should produce deterministic keys for same input', () => {
      const key1 = deriveKey('/same/path')
      const key2 = deriveKey('/same/path')
      expect(key1.equals(key2)).toBe(true)
    })

    it('should produce different keys for different inputs', () => {
      const key1 = deriveKey('/path/one')
      const key2 = deriveKey('/path/two')
      expect(key1.equals(key2)).toBe(false)
    })
  })

  describe('Encrypt/Decrypt', () => {
    it('should encrypt and decrypt an API key', () => {
      const apiKey = 'sk-ant-api03-' + 'a'.repeat(90)
      const encrypted = encrypt(apiKey, testKey)
      const decrypted = decrypt(encrypted, testKey)
      expect(decrypted).toBe(apiKey)
    })

    it('should encrypt and decrypt short strings', () => {
      const value = 'abc'
      const encrypted = encrypt(value, testKey)
      expect(decrypt(encrypted, testKey)).toBe(value)
    })

    it('should encrypt and decrypt empty strings', () => {
      const encrypted = encrypt('', testKey)
      expect(decrypt(encrypted, testKey)).toBe('')
    })

    it('should encrypt and decrypt unicode', () => {
      const value = 'Schlüssel mit Ümlauten: äöü'
      const encrypted = encrypt(value, testKey)
      expect(decrypt(encrypted, testKey)).toBe(value)
    })

    it('should produce different ciphertext for same plaintext (random IV)', () => {
      const value = 'same-value'
      const e1 = encrypt(value, testKey)
      const e2 = encrypt(value, testKey)
      expect(e1.iv).not.toBe(e2.iv)
      expect(e1.data).not.toBe(e2.data)
    })

    it('should produce valid base64 output', () => {
      const encrypted = encrypt('test-key', testKey)
      expect(() => Buffer.from(encrypted.iv, 'base64')).not.toThrow()
      expect(() => Buffer.from(encrypted.data, 'base64')).not.toThrow()
      expect(() => Buffer.from(encrypted.tag, 'base64')).not.toThrow()
    })
  })

  describe('Tamper Detection', () => {
    it('should fail to decrypt with wrong key', () => {
      const encrypted = encrypt('secret', testKey)
      const wrongKey = deriveKey('/wrong/path')
      expect(() => decrypt(encrypted, wrongKey)).toThrow()
    })

    it('should fail to decrypt with modified ciphertext', () => {
      const encrypted = encrypt('secret', testKey)
      const tampered = { ...encrypted, data: 'AAAA' + encrypted.data.slice(4) }
      expect(() => decrypt(tampered, testKey)).toThrow()
    })

    it('should fail to decrypt with modified auth tag', () => {
      const encrypted = encrypt('secret', testKey)
      const tampered = { ...encrypted, tag: 'AAAA' + encrypted.tag.slice(4) }
      expect(() => decrypt(tampered, testKey)).toThrow()
    })

    it('should fail to decrypt with modified IV', () => {
      const encrypted = encrypt('secret', testKey)
      const tampered = { ...encrypted, iv: 'AAAA' + encrypted.iv.slice(4) }
      expect(() => decrypt(tampered, testKey)).toThrow()
    })
  })
})
