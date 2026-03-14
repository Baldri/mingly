/**
 * PII Rehydrator Tests
 */
import { describe, it, expect } from 'vitest'
import { rehydrate } from '../../src/main/privacy/rehydrator'
import { PrivacySessionMap } from '../../src/main/privacy/session-map'

describe('rehydrate', () => {
  function createMap(entries: [string, string, 'EMAIL' | 'PERSON' | 'LOCATION'][]): PrivacySessionMap {
    const map = new PrivacySessionMap('test-session')
    for (const [original, replacement, category] of entries) {
      map.add(original, replacement, category)
    }
    return map
  }

  describe('shield mode', () => {
    it('should replace fake data back with originals', () => {
      const map = createMap([
        ['holger@test.ch', 'thomas.mueller@gmail.com', 'EMAIL'],
        ['Basel', 'Luzern', 'LOCATION']
      ])
      const result = rehydrate(
        'Antwort für thomas.mueller@gmail.com in Luzern.',
        map,
        'shield'
      )
      expect(result.rehydratedText).toBe('Antwort für holger@test.ch in Basel.')
      expect(result.replacementCount).toBe(2)
      expect(result.attempted).toBe(true)
    })

    it('should handle case-insensitive LLM reformulations', () => {
      const map = createMap([['Basel', 'Luzern', 'LOCATION']])
      const result = rehydrate('Willkommen in LUZERN!', map, 'shield')
      expect(result.rehydratedText).toBe('Willkommen in Basel!')
    })

    it('should replace longest matches first', () => {
      const map = createMap([
        ['Hans', 'Thomas', 'PERSON'],
        ['Hans Muster', 'Thomas Müller', 'PERSON']
      ])
      const result = rehydrate('Hallo Thomas Müller', map, 'shield')
      expect(result.rehydratedText).toBe('Hallo Hans Muster')
    })

    it('should handle multiple occurrences', () => {
      const map = createMap([['Basel', 'Luzern', 'LOCATION']])
      const result = rehydrate('Von Luzern nach Luzern', map, 'shield')
      expect(result.rehydratedText).toBe('Von Basel nach Basel')
    })
  })

  describe('non-shield modes', () => {
    it('should not rehydrate in vault mode', () => {
      const map = createMap([['Basel', 'Luzern', 'LOCATION']])
      const result = rehydrate('[LOCATION] ist schön', map, 'vault')
      expect(result.rehydratedText).toBe('[LOCATION] ist schön')
      expect(result.attempted).toBe(false)
      expect(result.replacementCount).toBe(0)
    })

    it('should not rehydrate in transparent mode', () => {
      const map = createMap([['Basel', 'Luzern', 'LOCATION']])
      const result = rehydrate('Basel ist schön', map, 'transparent')
      expect(result.attempted).toBe(false)
    })
  })

  describe('empty cases', () => {
    it('should handle empty session map', () => {
      const map = new PrivacySessionMap('test-session')
      const result = rehydrate('Some text', map, 'shield')
      expect(result.rehydratedText).toBe('Some text')
      expect(result.attempted).toBe(false)
    })

    it('should handle empty text', () => {
      const map = createMap([['Basel', 'Luzern', 'LOCATION']])
      const result = rehydrate('', map, 'shield')
      expect(result.rehydratedText).toBe('')
    })

    it('should handle text with no matches', () => {
      const map = createMap([['Basel', 'Luzern', 'LOCATION']])
      const result = rehydrate('Keine Matches hier', map, 'shield')
      expect(result.rehydratedText).toBe('Keine Matches hier')
      expect(result.replacementCount).toBe(0)
    })
  })

  describe('special characters', () => {
    it('should handle regex special chars in replacements', () => {
      const map = createMap([['real@test.ch', 'fake+tag@test.ch', 'EMAIL']])
      const result = rehydrate('Mail: fake+tag@test.ch', map, 'shield')
      expect(result.rehydratedText).toBe('Mail: real@test.ch')
    })
  })

  describe('latency', () => {
    it('should measure processing time', () => {
      const map = createMap([['Basel', 'Luzern', 'LOCATION']])
      const result = rehydrate('In Luzern', map, 'shield')
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })
  })
})
