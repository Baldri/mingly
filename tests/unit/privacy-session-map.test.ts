/**
 * Privacy Session Map Tests
 */
import { describe, it, expect } from 'vitest'
import { PrivacySessionMap } from '../../src/main/privacy/session-map'

describe('PrivacySessionMap', () => {
  describe('basic operations', () => {
    it('should store and retrieve mappings', () => {
      const map = new PrivacySessionMap('session-1')
      map.add('hans@test.ch', 'thomas.mueller@gmail.com', 'EMAIL')
      expect(map.getReplacement('hans@test.ch')).toBe('thomas.mueller@gmail.com')
      expect(map.getOriginal('thomas.mueller@gmail.com')).toBe('hans@test.ch')
    })

    it('should return undefined for unknown values', () => {
      const map = new PrivacySessionMap('session-1')
      expect(map.getReplacement('unknown')).toBeUndefined()
      expect(map.getOriginal('unknown')).toBeUndefined()
    })

    it('should track size', () => {
      const map = new PrivacySessionMap('session-1')
      expect(map.size).toBe(0)
      map.add('a', 'b', 'EMAIL')
      expect(map.size).toBe(1)
      map.add('c', 'd', 'PHONE')
      expect(map.size).toBe(2)
    })
  })

  describe('session ID', () => {
    it('should return the session ID', () => {
      const map = new PrivacySessionMap('my-session')
      expect(map.getSessionId()).toBe('my-session')
    })
  })

  describe('importFromAnonymizer', () => {
    it('should bulk-import replacement and category maps', () => {
      const map = new PrivacySessionMap('session-1')
      const replacements = new Map([
        ['hans@test.ch', 'fake@gmail.com'],
        ['Basel', 'Zürich']
      ])
      const categories = new Map<string, 'EMAIL' | 'LOCATION'>([
        ['hans@test.ch', 'EMAIL'],
        ['Basel', 'LOCATION']
      ])
      map.importFromAnonymizer(replacements, categories)
      expect(map.size).toBe(2)
      expect(map.getReplacement('hans@test.ch')).toBe('fake@gmail.com')
      expect(map.getOriginal('Zürich')).toBe('Basel')
    })

    it('should default to CUSTOM category for unknown originals', () => {
      const map = new PrivacySessionMap('session-1')
      const replacements = new Map([['unknown', 'fake']])
      const categories = new Map<string, never>()
      map.importFromAnonymizer(replacements, categories)
      const mappings = map.getAllMappings()
      expect(mappings[0].category).toBe('CUSTOM')
    })
  })

  describe('getReplacementsSortedByLength', () => {
    it('should return replacements sorted longest-first', () => {
      const map = new PrivacySessionMap('session-1')
      map.add('a', 'short', 'EMAIL')
      map.add('b', 'much longer replacement', 'PERSON')
      map.add('c', 'medium text', 'PHONE')
      const sorted = map.getReplacementsSortedByLength()
      expect(sorted[0]).toBe('much longer replacement')
      expect(sorted[sorted.length - 1]).toBe('short')
    })
  })

  describe('getAllMappings', () => {
    it('should return all mappings with metadata', () => {
      const map = new PrivacySessionMap('session-1')
      map.add('hans@test.ch', 'fake@test.ch', 'EMAIL')
      const mappings = map.getAllMappings()
      expect(mappings).toHaveLength(1)
      expect(mappings[0].original).toBe('hans@test.ch')
      expect(mappings[0].replacement).toBe('fake@test.ch')
      expect(mappings[0].category).toBe('EMAIL')
      expect(mappings[0].createdAt).toBeGreaterThan(0)
    })
  })

  describe('clear', () => {
    it('should remove all mappings', () => {
      const map = new PrivacySessionMap('session-1')
      map.add('a', 'b', 'EMAIL')
      map.add('c', 'd', 'PHONE')
      map.clear()
      expect(map.size).toBe(0)
      expect(map.getReplacement('a')).toBeUndefined()
      expect(map.getOriginal('b')).toBeUndefined()
    })
  })

  describe('export / restore', () => {
    it('should export and restore session state', () => {
      const original = new PrivacySessionMap('session-1')
      original.add('hans@test.ch', 'fake@test.ch', 'EMAIL')
      original.add('Basel', 'Zürich', 'LOCATION')

      const exported = original.export()
      expect(exported.sessionId).toBe('session-1')
      expect(exported.mappings).toHaveLength(2)

      const restored = PrivacySessionMap.restore(exported)
      expect(restored.getSessionId()).toBe('session-1')
      expect(restored.size).toBe(2)
      expect(restored.getReplacement('hans@test.ch')).toBe('fake@test.ch')
      expect(restored.getOriginal('Zürich')).toBe('Basel')
    })
  })
})
