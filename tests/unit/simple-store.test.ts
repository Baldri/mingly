/**
 * SimpleStore Tests
 * Mocks Electron app module and tests key-value store operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import path from 'path'
import fs from 'fs'

const testDir = path.join(tmpdir(), `mingly-simple-store-test-${process.pid}`)

// Mock Electron
vi.mock('electron', () => ({
  app: {
    getPath: () => testDir
  }
}))

// Ensure test directory exists
beforeEach(() => {
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true })
  }
})

afterEach(() => {
  // Reset singleton cache between tests so each test gets a fresh instance
  SimpleStore._resetForTesting()

  // Clean up test files
  try {
    const files = fs.readdirSync(testDir)
    for (const file of files) {
      fs.unlinkSync(path.join(testDir, file))
    }
  } catch {
    // ignore
  }
})

import { SimpleStore } from '../../src/main/utils/simple-store'

describe('SimpleStore', () => {
  it('should create a store with default filename', () => {
    const store = SimpleStore.create()
    expect(store).toBeDefined()
  })

  it('should create a store with custom filename', () => {
    const store = SimpleStore.create('test-store.json')
    expect(store).toBeDefined()
  })

  it('should set and get values', () => {
    const store = SimpleStore.create('test-get-set.json')
    store.set('key1', 'value1')
    expect(store.get('key1')).toBe('value1')
  })

  it('should return default value for missing key', () => {
    const store = SimpleStore.create('test-default.json')
    expect(store.get('nonexistent', 'default')).toBe('default')
  })

  it('should return undefined for missing key without default', () => {
    const store = SimpleStore.create('test-undef.json')
    expect(store.get('nonexistent')).toBeUndefined()
  })

  it('should check if key exists', () => {
    const store = SimpleStore.create('test-has.json')
    store.set('exists', true)
    expect(store.has('exists')).toBe(true)
    expect(store.has('nope')).toBe(false)
  })

  it('should delete a key', () => {
    const store = SimpleStore.create('test-delete.json')
    store.set('toDelete', 'value')
    expect(store.has('toDelete')).toBe(true)
    store.delete('toDelete')
    expect(store.has('toDelete')).toBe(false)
  })

  it('should clear all data', () => {
    const store = SimpleStore.create('test-clear.json')
    store.set('a', 1)
    store.set('b', 2)
    store.clear()
    expect(store.has('a')).toBe(false)
    expect(store.has('b')).toBe(false)
  })

  it('should persist data to disk', () => {
    const filename = 'test-persist.json'
    const store1 = SimpleStore.create(filename)
    store1.set('persistent', 'data')

    // Reset cache to force re-read from disk
    SimpleStore._resetForTesting()

    const store2 = SimpleStore.create(filename)
    expect(store2.get('persistent')).toBe('data')
  })

  it('should return same instance for same filename (singleton)', () => {
    const store1 = SimpleStore.create('test-singleton.json')
    const store2 = SimpleStore.create('test-singleton.json')
    expect(store1).toBe(store2)
  })

  it('should store complex objects', () => {
    const store = SimpleStore.create('test-complex.json')
    const complex = { nested: { array: [1, 2, 3], bool: true } }
    store.set('complex', complex)
    expect(store.get('complex')).toEqual(complex)
  })
})
