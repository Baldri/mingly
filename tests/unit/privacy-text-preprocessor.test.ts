/**
 * Text Preprocessor Tests
 * Verifies zero-width stripping, URL decoding, NFC normalization,
 * and correct offset mapping back to original text.
 */
import { describe, it, expect } from 'vitest'
import { preprocessText } from '../../src/main/privacy/text-preprocessor'

describe('preprocessText', () => {
  describe('zero-width character stripping', () => {
    it('should strip zero-width spaces from text', () => {
      const input = '756\u200B.1234.5678.97'
      const result = preprocessText(input)
      expect(result.normalized).toBe('756.1234.5678.97')
      expect(result.wasModified).toBe(true)
    })

    it('should strip ZWNJ from text', () => {
      const input = 'hans\u200C@test.ch'
      const result = preprocessText(input)
      expect(result.normalized).toBe('hans@test.ch')
    })

    it('should strip ZWJ from text', () => {
      const input = 'hans\u200D@test.ch'
      const result = preprocessText(input)
      expect(result.normalized).toBe('hans@test.ch')
    })

    it('should strip BOM from text', () => {
      const input = '\uFEFFhans@test.ch'
      const result = preprocessText(input)
      expect(result.normalized).toBe('hans@test.ch')
    })

    it('should strip soft hyphens', () => {
      const input = 'hans\u00AD@test.ch'
      const result = preprocessText(input)
      expect(result.normalized).toBe('hans@test.ch')
    })

    it('should strip multiple zero-width chars', () => {
      const input = '756\u200B.\u200C1234\u200D.5678.97'
      const result = preprocessText(input)
      expect(result.normalized).toBe('756.1234.5678.97')
    })
  })

  describe('URL decoding', () => {
    it('should decode %40 to @', () => {
      const input = 'hans%40test.ch'
      const result = preprocessText(input)
      expect(result.normalized).toBe('hans@test.ch')
      expect(result.wasModified).toBe(true)
    })

    it('should decode %2E to .', () => {
      const input = 'hans@test%2Ech'
      const result = preprocessText(input)
      expect(result.normalized).toBe('hans@test.ch')
    })

    it('should decode multiple URL-encoded sequences', () => {
      const input = 'hans%40test%2Ech'
      const result = preprocessText(input)
      expect(result.normalized).toBe('hans@test.ch')
    })

    it('should not break on invalid percent sequences', () => {
      const input = 'hans%ZZ@test.ch'
      const result = preprocessText(input)
      expect(result.normalized).toBe('hans%ZZ@test.ch')
    })

    it('should handle URL-encoded email in URL param', () => {
      const input = 'https://example.com?email=hans%40test.ch'
      const result = preprocessText(input)
      expect(result.normalized).toContain('hans@test.ch')
    })
  })

  describe('Unicode NFC normalization', () => {
    it('should normalize decomposed umlauts', () => {
      // ä as a + combining umlaut (NFD)
      const input = 'Zu\u0308rich'
      const result = preprocessText(input)
      expect(result.normalized).toBe('Zürich')
      expect(result.wasModified).toBe(true)
    })

    it('should leave already-composed text unchanged', () => {
      const input = 'Zürich'
      const result = preprocessText(input)
      expect(result.normalized).toBe('Zürich')
    })
  })

  describe('offset mapping', () => {
    it('should map offsets correctly after ZWS stripping', () => {
      // 'abc\u200Bdef' -> 'abcdef'
      // Original: a(0) b(1) c(2) ZWS(3) d(4) e(5) f(6)
      // Normalized: a(0) b(1) c(2) d(3) e(4) f(5)
      const input = 'abc\u200Bdef'
      const result = preprocessText(input)
      expect(result.normalized).toBe('abcdef')
      expect(result.toOriginalOffset(0)).toBe(0) // a -> a
      expect(result.toOriginalOffset(3)).toBe(4) // d -> d (after ZWS)
      expect(result.toOriginalOffset(5)).toBe(6) // f -> f
    })

    it('should map offsets correctly after URL decoding', () => {
      // 'a%40b' -> 'a@b'
      // Original: a(0) %(1) 4(2) 0(3) b(4)
      // Normalized: a(0) @(1) b(2)
      const input = 'a%40b'
      const result = preprocessText(input)
      expect(result.normalized).toBe('a@b')
      expect(result.toOriginalOffset(0)).toBe(0) // a -> a
      expect(result.toOriginalOffset(1)).toBe(1) // @ -> %
      expect(result.toOriginalOffset(2)).toBe(4) // b -> b
    })
  })

  describe('no modification', () => {
    it('should return wasModified=false for clean text', () => {
      const input = 'Hello World'
      const result = preprocessText(input)
      expect(result.wasModified).toBe(false)
      expect(result.normalized).toBe('Hello World')
    })

    it('should handle empty string', () => {
      const result = preprocessText('')
      expect(result.normalized).toBe('')
      expect(result.wasModified).toBe(false)
    })
  })
})
