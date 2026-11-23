/**
 * EncryptedStore must never destroy a secret it cannot read.
 *
 * Measured on 2026-11-20: after the first launch of a freshly packed build,
 * `~/Library/Application Support/Mingly/secure-keys.enc.json` went from 646
 * bytes to 2 bytes (`{}`) within three seconds of process start. Every stored
 * API key was gone, and the app fell back to a welcome screen the user could
 * not leave.
 *
 * Two places do it. `get()` deletes the entry and persists the deletion when
 * decryption throws; `loadFromDisk()` catches every error, resets `entries` to
 * `{}`, and lets the next save write that emptiness over the file.
 *
 * A failed decrypt says "I cannot read this right now" — it does not say "this
 * is worthless". The usual causes are transient: a keychain prompt the user
 * dismissed, an ACL a rebuild invalidated. The ciphertext is intact and would
 * be readable again once the cause is fixed. Throwing it away removes that
 * possibility, silently and for good.
 *
 * These tests pin one property: the bytes survive, whatever the reader does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const electronState = vi.hoisted(() => ({
  userData: '',
  failDecrypt: false
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
    isReady: () => true
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buffer: Buffer) => {
      // Stands in for the real failure: the OS refuses the key material to
      // this binary, so the ciphertext is intact but unreadable here.
      if (electronState.failDecrypt) throw new Error('decrypt failed')
      return buffer.toString('utf-8').replace(/^enc:/, '')
    }
  }
}))

import { EncryptedStore } from '../../src/main/utils/encrypted-store'

const FILE = 'secure-keys.enc.json'

function storePath(): string {
  return path.join(electronState.userData, FILE)
}

function rawFile(): string {
  return fs.readFileSync(storePath(), 'utf-8')
}

function entryKeys(): string[] {
  return Object.keys(JSON.parse(rawFile()) as Record<string, unknown>)
}

function sidecars(): string[] {
  return fs
    .readdirSync(electronState.userData)
    .filter((name) => name.startsWith(`${FILE}.unreadable-`))
}

describe('EncryptedStore keeps what it cannot read', () => {
  beforeEach(() => {
    electronState.failDecrypt = false
    electronState.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-encstore-keep-'))
  })

  afterEach(() => {
    fs.rmSync(electronState.userData, { recursive: true, force: true })
  })

  it('returns undefined but leaves the entry on disk when decryption fails', () => {
    const store = new EncryptedStore(FILE)
    store.set('anthropic-api-key', 'sk-ant-secret')

    // Positive control: without it, a store that never wrote anything would
    // satisfy the assertion below for entirely the wrong reason.
    expect(entryKeys()).toEqual(['anthropic-api-key'])
    const bytesBefore = rawFile()

    electronState.failDecrypt = true

    expect(store.get('anthropic-api-key')).toBeUndefined()
    expect(entryKeys()).toEqual(['anthropic-api-key'])
    expect(rawFile()).toBe(bytesBefore)
  })

  it('still returns the value when decryption works', () => {
    const store = new EncryptedStore(FILE)
    store.set('openai-api-key', 'sk-openai-secret')

    expect(store.get('openai-api-key')).toBe('sk-openai-secret')
  })

  it('does not drop the other entries when one of them is unreadable', () => {
    const store = new EncryptedStore(FILE)
    store.set('anthropic-api-key', 'sk-a')
    store.set('openai-api-key', 'sk-b')
    store.set('google-api-key', 'sk-c')

    electronState.failDecrypt = true
    store.get('openai-api-key')

    expect(entryKeys().sort()).toEqual([
      'anthropic-api-key',
      'google-api-key',
      'openai-api-key'
    ])
  })

  it('reports an unreadable entry as unreadable, not as absent', () => {
    const store = new EncryptedStore(FILE)
    store.set('anthropic-api-key', 'sk-ant-secret')

    electronState.failDecrypt = true

    // `has` keeps its meaning — can this key be used right now? — and the
    // answer is no. What changes is that answering it costs nothing.
    expect(store.has('anthropic-api-key')).toBe(false)
    // The caller can still tell the two cases apart, which is what lets a UI
    // say "could not be read" instead of "not configured".
    expect(store.isUnreadable('anthropic-api-key')).toBe(true)
    expect(store.isUnreadable('openai-api-key')).toBe(false)
  })
})

describe('EncryptedStore never overwrites a store file it could not parse', () => {
  beforeEach(() => {
    electronState.failDecrypt = false
    electronState.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-encstore-parse-'))
  })

  afterEach(() => {
    fs.rmSync(electronState.userData, { recursive: true, force: true })
  })

  it('preserves the unparseable bytes in a sidecar before writing a new store', () => {
    const garbage = '{"anthropic-api-key": {"encrypted": "truncated...'
    fs.writeFileSync(storePath(), garbage, 'utf-8')

    const store = new EncryptedStore(FILE)
    store.set('openai-api-key', 'sk-new')

    // The new key is stored, so the app stays usable.
    expect(store.get('openai-api-key')).toBe('sk-new')

    // And the old bytes still exist, instead of being gone.
    expect(sidecars()).toHaveLength(1)
    expect(fs.readFileSync(path.join(electronState.userData, sidecars()[0]), 'utf-8')).toBe(garbage)
  })

  it('writes no sidecar when the store file parsed cleanly', () => {
    const store = new EncryptedStore(FILE)
    store.set('openai-api-key', 'sk-new')

    expect(sidecars()).toEqual([])
  })
})

/**
 * What happens when moving the unreadable file aside FAILS.
 *
 * The first version of this preservation cleared its own `loadFailed` flag
 * before attempting the rename, with the reasoning that a failed rename must
 * not make every later save retry it — and then `saveToDisk` went on to write
 * anyway. So a rename that threw produced exactly the outcome the whole
 * mechanism exists to prevent: the only copy of the user's secrets overwritten,
 * with a line in the log as the sole trace.
 *
 * The window is narrow (a rename inside a directory the app can otherwise
 * write), but it is the same class the mechanism was built to close, so the
 * choice here is explicit: when the bytes cannot be preserved, NOTHING is
 * written. Losing a key the user just typed costs them one re-entry; losing the
 * file costs them everything in it, with no way back.
 *
 * `fs.renameSync` and `fs.copyFileSync` are spied rather than provoked through
 * the real filesystem: an OS that refuses them is the scenario, and arranging a
 * genuine refusal (a read-only directory) would also stop the ordinary write,
 * so the test could no longer tell "we refused" from "the write failed too".
 * Each test asserts the spy was actually reached.
 */
describe('EncryptedStore refuses to write when it cannot preserve the old bytes', () => {
  const garbage = '{"anthropic-api-key": {"encrypted": "truncated...'

  beforeEach(() => {
    electronState.failDecrypt = false
    electronState.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mingly-encstore-fail-'))
    fs.writeFileSync(storePath(), garbage, 'utf-8')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(electronState.userData, { recursive: true, force: true })
  })

  it('leaves the file untouched when neither the rename nor the copy can be made', () => {
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })

    const store = new EncryptedStore(FILE)
    store.set('openai-api-key', 'sk-new')

    // Positive control: the refusal has to come from the preservation attempt,
    // not from the test forgetting to trigger it.
    expect(rename).toHaveBeenCalled()
    expect(copy).toHaveBeenCalled()

    // The point of the whole exercise.
    expect(rawFile()).toBe(garbage)
    expect(sidecars()).toEqual([])
    // The session still works; only the persisting of it was refused.
    expect(store.get('openai-api-key')).toBe('sk-new')
  })

  it('falls back to a copy when only the rename fails, and then writes', () => {
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' })
    })

    const store = new EncryptedStore(FILE)
    store.set('openai-api-key', 'sk-new')

    expect(rename).toHaveBeenCalled()
    // The bytes are safe in the sidecar, so replacing the original is allowed.
    expect(sidecars()).toHaveLength(1)
    expect(fs.readFileSync(path.join(electronState.userData, sidecars()[0]), 'utf-8')).toBe(garbage)
    expect(entryKeys()).toEqual(['openai-api-key'])
  })

  it('tries the preservation again on the next save instead of giving up on it', () => {
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })
    const copy = vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    })

    const store = new EncryptedStore(FILE)
    store.set('openai-api-key', 'sk-first')
    expect(rawFile()).toBe(garbage)

    // The obstacle goes away — a keychain prompt answered, a lock released.
    rename.mockRestore()
    copy.mockRestore()

    store.set('google-api-key', 'sk-second')

    // Both keys land, and the original bytes are in the sidecar rather than
    // gone: the retry is what makes the refusal above recoverable instead of
    // permanent.
    expect(sidecars()).toHaveLength(1)
    expect(fs.readFileSync(path.join(electronState.userData, sidecars()[0]), 'utf-8')).toBe(garbage)
    expect(entryKeys().sort()).toEqual(['google-api-key', 'openai-api-key'])
  })
})
