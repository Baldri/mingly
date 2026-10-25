/**
 * EncryptedStore — safeStorage availability is only reliable after app 'ready'.
 *
 * Since Electron 44, safeStorage.isEncryptionAvailable() returns false on macOS
 * until the app has emitted 'ready' (Electron 27 returned true). The store is
 * constructed at module load (keychain-manager), i.e. before 'ready'. Deciding
 * the backend in the constructor silently downgraded every new secret to the
 * file-key fallback. The decision must be taken on first use instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const electronState = vi.hoisted(() => ({ ready: false, userData: '' }))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
    isReady: () => electronState.ready
  },
  safeStorage: {
    isEncryptionAvailable: () => electronState.ready,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => {
      if (!electronState.ready) throw new Error('not ready')
      return buffer.toString('utf-8').replace(/^enc:/, '')
    }
  }
}))

import { EncryptedStore } from '../../src/main/utils/encrypted-store'

function readEntries(file: string): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(electronState.userData, file), 'utf-8'))
}

describe('EncryptedStore constructed before app ready', () => {
  beforeEach(() => {
    electronState.ready = false
    electronState.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-encstore-'))
  })

  afterEach(() => {
    fs.rmSync(electronState.userData, { recursive: true, force: true })
  })

  it('uses safeStorage for writes made after ready', () => {
    const store = new EncryptedStore('secure-keys.enc.json')
    electronState.ready = true

    store.set('anthropic', 'sk-test')

    expect(readEntries('secure-keys.enc.json').anthropic).toMatchObject({ v: 2 })
    expect(store.get('anthropic')).toBe('sk-test')
  })

  it('does not create a fallback key file when safeStorage is available after ready', () => {
    const store = new EncryptedStore('secure-keys.enc.json')
    electronState.ready = true

    store.set('openai', 'sk-other')

    expect(fs.existsSync(path.join(electronState.userData, 'secure-keys.enc.json.key'))).toBe(false)
  })

  it('keeps existing safeStorage entries readable', () => {
    fs.writeFileSync(
      path.join(electronState.userData, 'secure-keys.enc.json'),
      JSON.stringify({ google: { encrypted: Buffer.from('enc:g-key').toString('base64'), v: 2 } })
    )
    const store = new EncryptedStore('secure-keys.enc.json')
    electronState.ready = true

    expect(store.get('google')).toBe('g-key')
  })
})
