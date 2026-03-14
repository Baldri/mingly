/**
 * Swiss PII Detector Tests
 */
import { describe, it, expect } from 'vitest'
import { detectSwissPII, isValidAHV, SWISS_CITIES, CANTONS } from '../../src/main/privacy/swiss-detector'

describe('detectSwissPII', () => {
  describe('AHV detection', () => {
    it('should detect valid AHV number with dots', () => {
      // Valid AHV: 756.1234.5678.97 (checksum must be correct)
      // Calculate: 7*1+5*3+6*1+1*3+2*1+3*3+4*1+5*3+6*1+7*3+8*1+9*3 = 7+15+6+3+2+9+4+15+6+21+8+27 = 123, check = (10-(123%10))%10 = 7
      const result = detectSwissPII('AHV-Nr: 756.1234.5678.97')
      const ahv = result.filter(e => e.category === 'AHV')
      expect(ahv).toHaveLength(1)
      expect(ahv[0].source).toBe('swiss')
      expect(ahv[0].sensitivity).toBe('critical')
    })

    it('should reject AHV with invalid checksum', () => {
      const result = detectSwissPII('Fake: 756.1234.5678.00')
      const ahv = result.filter(e => e.category === 'AHV')
      expect(ahv).toHaveLength(0)
    })

    it('should detect AHV without dots', () => {
      const result = detectSwissPII('Nr 7561234567897')
      const ahv = result.filter(e => e.category === 'AHV')
      expect(ahv).toHaveLength(1)
    })
  })

  describe('isValidAHV', () => {
    it('should validate correct checksum', () => {
      expect(isValidAHV('756.1234.5678.97')).toBe(true)
    })

    it('should reject incorrect checksum', () => {
      expect(isValidAHV('756.1234.5678.00')).toBe(false)
    })

    it('should reject non-756 prefix', () => {
      expect(isValidAHV('757.1234.5678.97')).toBe(false)
    })

    it('should reject wrong length', () => {
      expect(isValidAHV('756.1234.5678')).toBe(false)
    })
  })

  describe('CH-IBAN detection', () => {
    it('should detect Swiss IBAN', () => {
      const result = detectSwissPII('Konto: CH93 0076 2011 6238 5295 7')
      const ibans = result.filter(e => e.category === 'IBAN')
      expect(ibans).toHaveLength(1)
      expect(ibans[0].source).toBe('swiss')
    })

    it('should detect IBAN without spaces', () => {
      const result = detectSwissPII('IBAN: CH9300762011623852957')
      const ibans = result.filter(e => e.category === 'IBAN')
      expect(ibans).toHaveLength(1)
    })
  })

  describe('CH phone detection', () => {
    it('should detect Swiss mobile (079)', () => {
      const result = detectSwissPII('Tel: 079 123 45 67')
      const phones = result.filter(e => e.category === 'PHONE')
      expect(phones).toHaveLength(1)
    })

    it('should detect Swiss mobile with +41', () => {
      const result = detectSwissPII('Mobil: +41 79 123 45 67')
      const phones = result.filter(e => e.category === 'PHONE')
      expect(phones).toHaveLength(1)
    })

    it('should detect Swiss landline', () => {
      const result = detectSwissPII('Festnetz: 044 123 45 67')
      const phones = result.filter(e => e.category === 'PHONE')
      expect(phones).toHaveLength(1)
    })
  })

  describe('PLZ + City detection', () => {
    it('should detect Swiss PLZ with city', () => {
      const result = detectSwissPII('Adresse: 8001 Zürich')
      const locs = result.filter(e => e.category === 'LOCATION')
      expect(locs.length).toBeGreaterThan(0)
    })

    it('should reject PLZ outside Swiss range', () => {
      const result = detectSwissPII('PLZ: 0500 Something')
      const plzLocs = result.filter(e => e.category === 'LOCATION' && e.original.match(/^\d{4}/))
      expect(plzLocs).toHaveLength(0)
    })
  })

  describe('Swiss city detection', () => {
    it('should detect known Swiss cities', () => {
      const result = detectSwissPII('Wohnt in Basel und arbeitet in Zürich.')
      const locs = result.filter(e => e.category === 'LOCATION')
      expect(locs.length).toBeGreaterThanOrEqual(2)
    })

    it('should detect French city names', () => {
      const result = detectSwissPII('Réunion à Lausanne')
      const locs = result.filter(e => e.category === 'LOCATION')
      expect(locs.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('SWISS_CITIES and CANTONS exports', () => {
    it('should have major cities', () => {
      expect(SWISS_CITIES.has('Zürich')).toBe(true)
      expect(SWISS_CITIES.has('Basel')).toBe(true)
      expect(SWISS_CITIES.has('Lugano')).toBe(true)
    })

    it('should have all 26 cantons', () => {
      expect(CANTONS.size).toBe(26)
      expect(CANTONS.has('ZH')).toBe(true)
      expect(CANTONS.has('TI')).toBe(true)
    })
  })
})
