/**
 * Regex PII Detector Tests
 */
import { describe, it, expect } from 'vitest'
import { detectWithRegex } from '../../src/main/privacy/regex-detector'

describe('detectWithRegex', () => {
  describe('EMAIL detection', () => {
    it('should detect standard email addresses', () => {
      const result = detectWithRegex('Kontakt: hans.muster@gmail.com bitte.')
      const emails = result.filter(e => e.category === 'EMAIL')
      expect(emails).toHaveLength(1)
      expect(emails[0].original).toBe('hans.muster@gmail.com')
      expect(emails[0].confidence).toBe(1.0)
      expect(emails[0].source).toBe('regex')
    })

    it('should detect multiple emails', () => {
      const result = detectWithRegex('a@b.ch und c@d.de')
      const emails = result.filter(e => e.category === 'EMAIL')
      expect(emails).toHaveLength(2)
    })

    it('should detect emails with special chars', () => {
      const result = detectWithRegex('user+tag@example.co.uk')
      const emails = result.filter(e => e.category === 'EMAIL')
      expect(emails).toHaveLength(1)
    })
  })

  describe('CREDIT_CARD detection', () => {
    it('should detect Visa card numbers', () => {
      const result = detectWithRegex('Karte: 4111-1111-1111-1111')
      const cards = result.filter(e => e.category === 'CREDIT_CARD')
      expect(cards).toHaveLength(1)
      expect(cards[0].original).toBe('4111-1111-1111-1111')
    })

    it('should detect Mastercard numbers', () => {
      const result = detectWithRegex('MC: 5500 0000 0000 0004')
      const cards = result.filter(e => e.category === 'CREDIT_CARD')
      expect(cards).toHaveLength(1)
    })
  })

  describe('IP_ADDRESS detection', () => {
    it('should detect valid IPv4', () => {
      const result = detectWithRegex('Server: 192.168.1.1')
      const ips = result.filter(e => e.category === 'IP_ADDRESS')
      expect(ips).toHaveLength(1)
      expect(ips[0].original).toBe('192.168.1.1')
    })

    it('should detect edge-case octets', () => {
      const result = detectWithRegex('IP: 255.255.255.0')
      const ips = result.filter(e => e.category === 'IP_ADDRESS')
      expect(ips).toHaveLength(1)
    })
  })

  describe('DATE_OF_BIRTH detection', () => {
    it('should detect German date format with "geboren"', () => {
      const result = detectWithRegex('geboren: 15.03.1990')
      const dobs = result.filter(e => e.category === 'DATE_OF_BIRTH')
      expect(dobs).toHaveLength(1)
    })

    it('should detect "geb." prefix', () => {
      const result = detectWithRegex('geb. 01/12/1985')
      const dobs = result.filter(e => e.category === 'DATE_OF_BIRTH')
      expect(dobs).toHaveLength(1)
    })

    it('should detect English DOB', () => {
      const result = detectWithRegex('date of birth 1990-05-20')
      const dobs = result.filter(e => e.category === 'DATE_OF_BIRTH')
      expect(dobs).toHaveLength(1)
    })
  })

  describe('AGE detection', () => {
    it('should detect "Jahre alt"', () => {
      const result = detectWithRegex('Patient ist 45 Jahre alt')
      const ages = result.filter(e => e.category === 'AGE')
      expect(ages).toHaveLength(1)
      expect(ages[0].original).toContain('45')
    })

    it('should detect "years old"', () => {
      const result = detectWithRegex('She is 32 years old')
      const ages = result.filter(e => e.category === 'AGE')
      expect(ages).toHaveLength(1)
    })

    it('should detect "jährig"', () => {
      const result = detectWithRegex('ein 28jährig Mann')
      const ages = result.filter(e => e.category === 'AGE')
      expect(ages).toHaveLength(1)
    })
  })

  describe('URL detection', () => {
    it('should detect https URLs', () => {
      const result = detectWithRegex('Profil: https://linkedin.com/in/hans-muster')
      const urls = result.filter(e => e.category === 'URL')
      expect(urls).toHaveLength(1)
      expect(urls[0].original).toContain('linkedin.com')
    })

    it('should detect http URLs', () => {
      const result = detectWithRegex('Link: http://example.com/user/123')
      const urls = result.filter(e => e.category === 'URL')
      expect(urls).toHaveLength(1)
    })
  })

  describe('PHONE detection', () => {
    it('should detect international phone numbers', () => {
      const result = detectWithRegex('Nummer: +49 171 1234567')
      const phones = result.filter(e => e.category === 'PHONE')
      expect(phones.length).toBeGreaterThan(0)
    })

    it('should skip short digit sequences (false positives)', () => {
      const result = detectWithRegex('Im Jahr 2024 gab es Neues.')
      const phones = result.filter(e => e.category === 'PHONE')
      expect(phones).toHaveLength(0)
    })
  })

  describe('position tracking', () => {
    it('should track correct start/end offsets', () => {
      const text = 'Email: test@example.com here'
      const result = detectWithRegex(text)
      const email = result.find(e => e.category === 'EMAIL')!
      expect(text.slice(email.start, email.end)).toBe('test@example.com')
    })
  })

  describe('sensitivity', () => {
    it('should assign correct sensitivity levels', () => {
      const result = detectWithRegex('test@test.com 4111-1111-1111-1111 192.168.1.1')
      const email = result.find(e => e.category === 'EMAIL')
      const card = result.find(e => e.category === 'CREDIT_CARD')
      const ip = result.find(e => e.category === 'IP_ADDRESS')
      expect(email?.sensitivity).toBe('high')
      expect(card?.sensitivity).toBe('critical')
      expect(ip?.sensitivity).toBe('medium')
    })
  })
})
