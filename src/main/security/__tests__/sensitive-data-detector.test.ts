/**
 * Sensitive Data Detector Tests
 * Tests für Pattern-basierte Erkennung sensibler Daten
 */

import { getSensitiveDataDetector } from '../sensitive-data-detector'

describe('Sensitive Data Detector', () => {
  const detector = getSensitiveDataDetector()

  describe('API Key Detection', () => {
    it('should detect OpenAI API key', () => {
      // Pattern requires sk- followed by exactly 48 alphanumeric chars
      const text = 'My key is sk-' + 'a'.repeat(48)
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches.length).toBeGreaterThan(0)
      expect(result.matches[0].type).toBe('api-key')
      expect(result.overallRiskLevel).toBe('critical')
      expect(result.recommendation).toBe('block')
    })

    it('should detect Anthropic API key', () => {
      // Pattern requires sk-ant- followed by exactly 95 alphanumeric/dash chars
      const text = 'sk-ant-' + 'a'.repeat(95)
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].type).toBe('api-key')
      expect(result.matches[0].riskLevel).toBe('critical')
    })

    it('should detect AWS Access Key', () => {
      const text = 'AWS Key: AKIAIOSFODNN7EXAMPLE'
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].type).toBe('api-key')
      expect(result.matches[0].riskLevel).toBe('critical')
    })
  })

  describe('PII Detection', () => {
    it('should detect SSN and recommend block', () => {
      const text = 'My SSN is 123-45-6789'
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].type).toBe('ssn')
      expect(result.overallRiskLevel).toBe('critical')
      expect(result.recommendation).toBe('block')
    })

    it('should detect credit card number', () => {
      const text = 'Card: 4532-1111-2222-3333'
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].type).toBe('credit-card')
      expect(result.matches[0].riskLevel).toBe('critical')
    })

    it('should detect phone number and recommend warn', () => {
      const text = 'Call me at +1-555-123-4567'
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].type).toBe('phone')
      expect(result.matches[0].riskLevel).toBe('medium')
      expect(result.recommendation).toBe('warn')
    })
  })

  describe('Email Detection', () => {
    it('should detect email address', () => {
      const text = 'Contact: user@example.com'
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].type).toBe('email')
      expect(result.matches[0].riskLevel).toBe('low')
    })

    it('should allow emails (low risk)', () => {
      const text = 'Email me at info@company.com'
      const result = detector.scan(text)

      expect(result.recommendation).toBe('allow')
    })
  })

  describe('Password Detection', () => {
    it('should detect password pattern', () => {
      const text = 'password:mysecret123'
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].type).toBe('password')
      expect(result.matches[0].riskLevel).toBe('critical')
    })

    it('should detect various password formats', () => {
      // The regex requires at least 8 characters after the colon
      const inputs = [
        'pwd:secretpass123',
        'pass:mypassword',
        'passwd:"mysecret1"'
      ]

      inputs.forEach((text) => {
        const result = detector.scan(text)
        expect(result.hasSensitiveData).toBe(true)
      })
    })
  })

  describe('IP Address Detection', () => {
    it('should detect private IP addresses', () => {
      const ips = [
        '192.168.1.100',
        '10.0.0.1',
        '172.16.0.1'
      ]

      ips.forEach((ip) => {
        const result = detector.scan(`Server IP: ${ip}`)
        expect(result.hasSensitiveData).toBe(true)
        expect(result.matches[0].type).toBe('ip-address')
      })
    })
  })

  describe('File Path Detection', () => {
    it('should detect Unix file paths', () => {
      const text = 'File: /Users/john/Documents/secret.txt'
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].type).toBe('file-path')
    })

    it('should detect Windows file paths', () => {
      const text = 'Path: C:\\Users\\john\\Documents\\secret.docx'
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].type).toBe('file-path')
    })
  })

  describe('Multiple Matches', () => {
    it('should detect multiple sensitive items and escalate risk', () => {
      const text = `
        Email: user@example.com
        Phone: +1-555-123-4567
        IP: 192.168.1.100
      `
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches.length).toBe(3)
      expect(result.overallRiskLevel).toBe('medium') // 3 items
      expect(result.recommendation).toBe('warn')
    })

    it('should escalate to critical if ANY critical item present', () => {
      // Use a valid API key format that the regex can match
      const apiKey = 'sk-' + 'a'.repeat(48)
      const text = `
        Email: user@example.com
        API Key: ${apiKey}
      `
      const result = detector.scan(text)

      expect(result.overallRiskLevel).toBe('critical')
      expect(result.recommendation).toBe('block')
    })
  })

  describe('Clean Text', () => {
    it('should return no matches for clean text', () => {
      const text = 'This is a normal message without any sensitive data.'
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(false)
      expect(result.matches.length).toBe(0)
      expect(result.recommendation).toBe('allow')
    })
  })

  describe('Custom Patterns', () => {
    it('should allow adding custom patterns', () => {
      detector.addCustomPattern('employee-id', /\bEMP-\d{6}\b/g, 'high')

      const text = 'Employee EMP-123456 accessed the system'
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].type).toBe('employee-id')
      expect(result.matches[0].riskLevel).toBe('high')

      // Cleanup
      detector.removeCustomPattern(/\bEMP-\d{6}\b/g)
    })
  })

  describe('Redaction', () => {
    it('should redact sensitive values in matches', () => {
      // Use a format that matches the generic API key pattern: (sk|pk|api)[-_]?[a-zA-Z0-9]{20,}
      const text = 'My API key is sk-' + 'a'.repeat(48)
      const result = detector.scan(text)

      expect(result.hasSensitiveData).toBe(true)
      expect(result.matches[0].value).not.toBe(result.matches[0].fullValue)
      expect(result.matches[0].value).toContain('***')
    })
  })
})
