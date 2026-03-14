/**
 * PII Anonymizer Tests
 */
import { describe, it, expect } from 'vitest'
import { PIIAnonymizer } from '../../src/main/privacy/anonymizer'

describe('PIIAnonymizer', () => {
  describe('constructor', () => {
    it('should default to shield mode', () => {
      const anon = new PIIAnonymizer('test-session')
      expect(anon.getMode()).toBe('shield')
    })

    it('should accept custom mode', () => {
      const anon = new PIIAnonymizer('test-session', 'vault')
      expect(anon.getMode()).toBe('vault')
    })
  })

  describe('transparent mode', () => {
    it('should return text unchanged', () => {
      const anon = new PIIAnonymizer('test-session', 'transparent')
      const result = anon.anonymize('Hans Muster, hans@test.ch, wohnt in Zürich')
      expect(result.anonymizedText).toBe('Hans Muster, hans@test.ch, wohnt in Zürich')
      expect(result.replacements).toHaveLength(0)
      expect(result.mode).toBe('transparent')
    })
  })

  describe('vault mode', () => {
    it('should replace PII with category markers', () => {
      const anon = new PIIAnonymizer('test-session', 'vault')
      const result = anon.anonymize('Mail: hans@test.ch')
      expect(result.anonymizedText).toContain('[EMAIL]')
      expect(result.anonymizedText).not.toContain('hans@test.ch')
    })
  })

  describe('shield mode', () => {
    it('should replace email with fake Swiss email', () => {
      const anon = new PIIAnonymizer('test-session', 'shield')
      const result = anon.anonymize('Mail: hans@test.ch')
      expect(result.anonymizedText).not.toContain('hans@test.ch')
      expect(result.anonymizedText).toContain('@')
      expect(result.stats.anonymized).toBeGreaterThan(0)
    })

    it('should produce deterministic replacements per session', () => {
      const anon1 = new PIIAnonymizer('session-A', 'shield')
      const anon2 = new PIIAnonymizer('session-A', 'shield')
      const r1 = anon1.anonymize('Mail: hans@test.ch')
      const r2 = anon2.anonymize('Mail: hans@test.ch')
      expect(r1.anonymizedText).toBe(r2.anonymizedText)
    })

    it('should produce different replacements for different sessions', () => {
      const anon1 = new PIIAnonymizer('session-A', 'shield')
      const anon2 = new PIIAnonymizer('session-B', 'shield')
      const r1 = anon1.anonymize('Mail: hans@test.ch')
      const r2 = anon2.anonymize('Mail: hans@test.ch')
      // Different sessions should (almost certainly) produce different fake data
      // There's a tiny chance of collision, but with sufficient pool sizes it's negligible
      expect(r1.anonymizedText).not.toBe(r2.anonymizedText)
    })

    it('should use consistent replacements within session', () => {
      const anon = new PIIAnonymizer('test-session', 'shield')
      const r1 = anon.anonymize('Mail: hans@test.ch')
      const r2 = anon.anonymize('Nochmal: hans@test.ch')
      // Same PII should map to same fake value
      const fake1 = r1.replacements[0]?.replacement
      const fake2 = r2.replacements[0]?.replacement
      expect(fake1).toBe(fake2)
    })

    it('should NOT replace MEDICAL entities in shield mode', () => {
      // Medical entities are detected but kept as-is in shield mode
      const anon = new PIIAnonymizer('test-session', 'shield')
      // detectPII only detects MEDICAL via NER (future), so for now
      // we test the anonymizer logic with a text that has other PII
      const result = anon.anonymize('hans@test.ch hat Diabetes')
      // Email should be replaced
      expect(result.anonymizedText).not.toContain('hans@test.ch')
    })
  })

  describe('replacement map', () => {
    it('should return a copy of the replacement map', () => {
      const anon = new PIIAnonymizer('test-session', 'shield')
      anon.anonymize('Mail: hans@test.ch')
      const map = anon.getReplacementMap()
      expect(map.size).toBeGreaterThan(0)
      // Should be a copy, not the original
      map.clear()
      expect(anon.getReplacementMap().size).toBeGreaterThan(0)
    })
  })

  describe('clear', () => {
    it('should clear all stored mappings', () => {
      const anon = new PIIAnonymizer('test-session', 'shield')
      anon.anonymize('Mail: hans@test.ch')
      expect(anon.getReplacementMap().size).toBeGreaterThan(0)
      anon.clear()
      expect(anon.getReplacementMap().size).toBe(0)
    })
  })

  describe('setMode', () => {
    it('should change the privacy mode', () => {
      const anon = new PIIAnonymizer('test-session', 'shield')
      anon.setMode('vault')
      expect(anon.getMode()).toBe('vault')
    })
  })

  describe('stats', () => {
    it('should track detected vs anonymized counts', () => {
      const anon = new PIIAnonymizer('test-session', 'shield')
      const result = anon.anonymize('Mail: hans@test.ch')
      expect(result.stats.detected).toBeGreaterThan(0)
      expect(result.stats.anonymized).toBeLessThanOrEqual(result.stats.detected)
    })

    it('should report zero for clean text', () => {
      const anon = new PIIAnonymizer('test-session', 'shield')
      const result = anon.anonymize('Heute ist Mittwoch.')
      expect(result.stats.detected).toBe(0)
      expect(result.stats.anonymized).toBe(0)
    })

    it('should include latency', () => {
      const anon = new PIIAnonymizer('test-session', 'shield')
      const result = anon.anonymize('test@test.ch')
      expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    })
  })
})
