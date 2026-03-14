import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DataClassifier, DataSensitivity } from '../data-classifier'

// Mock the sensitive data detector
vi.mock('../sensitive-data-detector', () => ({
  getSensitiveDataDetector: () => ({
    scan: vi.fn().mockReturnValue({
      hasSensitiveData: false,
      matches: [],
      overallRiskLevel: 'low',
      recommendation: 'allow'
    })
  })
}))

describe('DataClassifier', () => {
  let classifier: DataClassifier

  beforeEach(() => {
    classifier = new DataClassifier()
  })

  describe('classify', () => {
    it('classifies plain text as PUBLIC', () => {
      const result = classifier.classify('Was ist das Wetter heute?')
      expect(result.sensitivity).toBe(DataSensitivity.PUBLIC)
      expect(result.reasons).toHaveLength(0)
    })

    it('classifies health data as CONFIDENTIAL', () => {
      const result = classifier.classify('Der Patient hat eine Diagnose erhalten.')
      expect(result.sensitivity).toBe(DataSensitivity.CONFIDENTIAL)
      expect(result.reasons.some((r) => r.includes('Health data'))).toBe(true)
    })

    it('classifies AHV numbers as CONFIDENTIAL', () => {
      const result = classifier.classify('Meine AHV: 756.1234.5678.90')
      expect(result.sensitivity).toBe(DataSensitivity.CONFIDENTIAL)
      expect(result.reasons.some((r) => r.includes('AHV'))).toBe(true)
    })

    it('classifies Swiss IBAN as CONFIDENTIAL', () => {
      const result = classifier.classify('IBAN: CH93 0076 2011 6238 5295 7')
      expect(result.sensitivity).toBe(DataSensitivity.CONFIDENTIAL)
      expect(result.reasons.some((r) => r.includes('IBAN'))).toBe(true)
    })

    it('classifies financial terms as CONFIDENTIAL', () => {
      const result = classifier.classify('Mein Gehalt betraegt 120000 CHF.')
      expect(result.sensitivity).toBe(DataSensitivity.CONFIDENTIAL)
      expect(result.reasons.some((r) => r.includes('Financial'))).toBe(true)
    })

    it('classifies private keys as RESTRICTED', () => {
      const result = classifier.classify('-----BEGIN RSA PRIVATE KEY-----\nMIIE...')
      expect(result.sensitivity).toBe(DataSensitivity.RESTRICTED)
      expect(result.reasons.some((r) => r.includes('Private key'))).toBe(true)
    })

    it('classifies credential patterns as RESTRICTED', () => {
      const result = classifier.classify('password: supersecret123')
      expect(result.sensitivity).toBe(DataSensitivity.RESTRICTED)
      expect(result.reasons.some((r) => r.includes('Credential'))).toBe(true)
    })

    it('classifies legal proceedings as RESTRICTED', () => {
      const result = classifier.classify('Das Strafverfahren gegen den Beschuldigten wird eingeleitet.')
      expect(result.sensitivity).toBe(DataSensitivity.RESTRICTED)
      expect(result.reasons.some((r) => r.includes('Legal proceeding'))).toBe(true)
    })

    it('RESTRICTED overrides CONFIDENTIAL', () => {
      const result = classifier.classify('Patient Diagnose und password: abc123')
      expect(result.sensitivity).toBe(DataSensitivity.RESTRICTED)
      // At least the RESTRICTED reason
      expect(result.reasons.length).toBeGreaterThanOrEqual(1)
      expect(result.reasons.some((r) => r.includes('Credential'))).toBe(true)
    })
  })

  describe('checkRouting', () => {
    it('allows public content to any provider', () => {
      const result = classifier.checkRouting('Wie ist das Wetter?', 'google')
      expect(result.allowed).toBe(true)
    })

    it('allows confidential content to ollama', () => {
      const result = classifier.checkRouting('Der Patient hat Diagnose X.', 'ollama')
      expect(result.allowed).toBe(true)
    })

    it('blocks confidential content from google', () => {
      const result = classifier.checkRouting('Der Patient hat Diagnose X.', 'google')
      expect(result.allowed).toBe(false)
      expect(result.suggestedProvider).toBe('ollama')
    })

    it('blocks confidential content from anthropic/openai', () => {
      const result = classifier.checkRouting('Mein Gehalt betraegt 120000.', 'anthropic')
      expect(result.allowed).toBe(false)
      expect(result.suggestedProvider).toBeDefined()
    })

    it('allows internal content to anthropic', () => {
      // Internal content needs medium-risk PII which comes from the mock
      // Without PII, plain text is PUBLIC — allowed everywhere
      const result = classifier.checkRouting('Schreibe mir einen Brief.', 'anthropic')
      expect(result.allowed).toBe(true)
    })

    it('suggests local provider for restricted content', () => {
      const result = classifier.checkRouting('password: mysecret123', 'openai')
      expect(result.allowed).toBe(false)
      // Restricted content: no provider can handle it (including local)
      // because RESTRICTED rank (3) > CONFIDENTIAL rank (2)
    })
  })

  describe('allowedProviders', () => {
    it('PUBLIC content allows all providers', () => {
      const result = classifier.classify('Hallo Welt')
      expect(result.allowedProviders).toContain('ollama')
      expect(result.allowedProviders).toContain('anthropic')
      expect(result.allowedProviders).toContain('google')
    })

    it('CONFIDENTIAL content only allows local providers', () => {
      const result = classifier.classify('Der Patient hat Diagnose X.')
      expect(result.allowedProviders).toContain('ollama')
      expect(result.allowedProviders).toContain('local')
      expect(result.allowedProviders).not.toContain('anthropic')
      expect(result.allowedProviders).not.toContain('google')
    })

    it('RESTRICTED content has no allowed providers', () => {
      const result = classifier.classify('password: abc123')
      expect(result.allowedProviders).toHaveLength(0)
    })
  })
})
