/**
 * Sensitive Data Detection
 * Detects potentially sensitive information before sending to cloud LLMs
 *
 * Security Model:
 * - Pattern-based detection (PII, credentials, etc.)
 * - Risk scoring (low/medium/high)
 * - User-configurable patterns
 * - Privacy-first: Better false positives than data leaks
 */

export type SensitiveDataType =
  | 'email'
  | 'phone'
  | 'ssn'
  | 'credit-card'
  | 'api-key'
  | 'password'
  | 'ip-address'
  | 'file-path'
  | 'url'
  | 'custom'

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface SensitiveDataMatch {
  type: SensitiveDataType
  value: string // Partially redacted for display
  fullValue: string
  position: { start: number; end: number }
  riskLevel: RiskLevel
  confidence: number // 0-1
}

export interface SensitiveDataScanResult {
  hasSensitiveData: boolean
  matches: SensitiveDataMatch[]
  overallRiskLevel: RiskLevel
  recommendation: 'allow' | 'warn' | 'block'
}

/**
 * Detection patterns with risk levels
 */
const PATTERNS: Array<{
  type: SensitiveDataType
  pattern: RegExp
  riskLevel: RiskLevel
  redactor: (match: string) => string
}> = [
  // Email addresses
  {
    type: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    riskLevel: 'low',
    redactor: (email) => {
      const [user, domain] = email.split('@')
      return `${user.substring(0, 2)}***@${domain}`
    }
  },

  // Phone numbers (various formats)
  {
    type: 'phone',
    pattern: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    riskLevel: 'medium',
    redactor: (phone) => `***-***-${phone.slice(-4)}`
  },

  // Social Security Numbers (US)
  {
    type: 'ssn',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    riskLevel: 'critical',
    redactor: () => '***-**-****'
  },

  // Credit card numbers (basic check)
  {
    type: 'credit-card',
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    riskLevel: 'critical',
    redactor: (cc) => `****-****-****-${cc.slice(-4)}`
  },

  // API Keys (common patterns)
  {
    type: 'api-key',
    pattern: /\b(sk|pk|api)[-_]?[a-zA-Z0-9]{20,}\b/gi,
    riskLevel: 'critical',
    redactor: (key) => `${key.substring(0, 6)}***${key.slice(-4)}`
  },

  // OpenAI API Keys
  {
    type: 'api-key',
    pattern: /\bsk-[a-zA-Z0-9]{48}\b/g,
    riskLevel: 'critical',
    redactor: (key) => `sk-***${key.slice(-4)}`
  },

  // Anthropic API Keys
  {
    type: 'api-key',
    pattern: /\bsk-ant-[a-zA-Z0-9-]{95}\b/g,
    riskLevel: 'critical',
    redactor: (key) => `sk-ant-***${key.slice(-4)}`
  },

  // Generic passwords (after "password:", "pwd:", etc.)
  {
    type: 'password',
    pattern: /(?:password|pwd|pass|passwd)[:=]\s*["']?([^\s"']{8,})["']?/gi,
    riskLevel: 'critical',
    redactor: () => 'password:***'
  },

  // Private IP addresses
  {
    type: 'ip-address',
    pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
    riskLevel: 'medium',
    redactor: (ip) => {
      const parts = ip.split('.')
      return `${parts[0]}.${parts[1]}.***.***.`
    }
  },

  // File paths (Unix/Mac)
  {
    type: 'file-path',
    pattern: /\/(?:Users|home|root|etc|var)\/[^\s]+/g,
    riskLevel: 'low',
    redactor: (path) => {
      const parts = path.split('/')
      return `/${parts[1]}/***/${parts[parts.length - 1]}`
    }
  },

  // File paths (Windows)
  {
    type: 'file-path',
    pattern: /[A-Z]:\\(?:Users|Program Files|Windows)\\[^\s]+/gi,
    riskLevel: 'low',
    redactor: (path) => {
      const parts = path.split('\\')
      return `${parts[0]}\\${parts[1]}\\***\\${parts[parts.length - 1]}`
    }
  },

  // AWS Access Keys
  {
    type: 'api-key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    riskLevel: 'critical',
    redactor: (key) => `${key.substring(0, 4)}***${key.slice(-4)}`
  }
]

export class SensitiveDataDetector {
  private customPatterns: Array<{
    type: SensitiveDataType
    pattern: RegExp
    riskLevel: RiskLevel
  }> = []

  /**
   * Scan text for sensitive data
   */
  scan(text: string): SensitiveDataScanResult {
    const matches: SensitiveDataMatch[] = []

    // Check built-in patterns
    for (const { type, pattern, riskLevel, redactor } of PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match: RegExpExecArray | null

      while ((match = regex.exec(text)) !== null) {
        matches.push({
          type,
          value: redactor(match[0]),
          fullValue: match[0],
          position: { start: match.index, end: regex.lastIndex },
          riskLevel,
          confidence: this.calculateConfidence(type, match[0])
        })
      }
    }

    // Check custom patterns
    for (const { type, pattern, riskLevel } of this.customPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match: RegExpExecArray | null

      while ((match = regex.exec(text)) !== null) {
        matches.push({
          type,
          value: `***${match[0].slice(-4)}`,
          fullValue: match[0],
          position: { start: match.index, end: regex.lastIndex },
          riskLevel,
          confidence: 0.8
        })
      }
    }

    // Determine overall risk level
    const overallRiskLevel = this.calculateOverallRisk(matches)

    // Recommendation based on risk
    const recommendation = this.getRecommendation(overallRiskLevel, matches.length)

    return {
      hasSensitiveData: matches.length > 0,
      matches,
      overallRiskLevel,
      recommendation
    }
  }

  /**
   * Calculate confidence score for a match
   */
  private calculateConfidence(type: SensitiveDataType, value: string): number {
    switch (type) {
      case 'credit-card':
        // Luhn algorithm check
        return this.validateLuhn(value.replace(/[-\s]/g, '')) ? 0.95 : 0.6

      case 'email':
        // Check if domain exists (TLD validation)
        const domain = value.split('@')[1]
        return domain && domain.includes('.') ? 0.9 : 0.7

      case 'api-key':
        // Known prefixes (sk-, pk-, AKIA, etc.) have high confidence
        return value.match(/^(sk|pk|AKIA|ASIA)/i) ? 0.95 : 0.8

      case 'ssn':
        // SSN format is very specific
        return 0.95

      default:
        return 0.8
    }
  }

  /**
   * Luhn algorithm for credit card validation
   */
  private validateLuhn(cardNumber: string): boolean {
    let sum = 0
    let isEven = false

    for (let i = cardNumber.length - 1; i >= 0; i--) {
      let digit = parseInt(cardNumber[i], 10)

      if (isEven) {
        digit *= 2
        if (digit > 9) digit -= 9
      }

      sum += digit
      isEven = !isEven
    }

    return sum % 10 === 0
  }

  /**
   * Calculate overall risk from all matches
   */
  private calculateOverallRisk(matches: SensitiveDataMatch[]): RiskLevel {
    if (matches.length === 0) return 'low'

    const hasCritical = matches.some((m) => m.riskLevel === 'critical')
    const hasHigh = matches.some((m) => m.riskLevel === 'high')
    const hasMedium = matches.some((m) => m.riskLevel === 'medium')

    if (hasCritical) return 'critical'
    if (hasHigh || matches.length >= 5) return 'high'
    if (hasMedium || matches.length >= 3) return 'medium'
    return 'low'
  }

  /**
   * Get recommendation based on risk level
   */
  private getRecommendation(
    riskLevel: RiskLevel,
    matchCount: number
  ): 'allow' | 'warn' | 'block' {
    if (riskLevel === 'critical') return 'block'
    if (riskLevel === 'high' || matchCount >= 5) return 'warn'
    if (riskLevel === 'medium') return 'warn'
    return 'allow'
  }

  /**
   * Add custom detection pattern
   */
  addCustomPattern(type: SensitiveDataType, pattern: RegExp, riskLevel: RiskLevel): void {
    this.customPatterns.push({ type, pattern, riskLevel })
  }

  /**
   * Remove custom pattern
   */
  removeCustomPattern(pattern: RegExp): void {
    this.customPatterns = this.customPatterns.filter((p) => p.pattern.source !== pattern.source)
  }

  /**
   * Get all custom patterns
   */
  getCustomPatterns(): Array<{ type: SensitiveDataType; pattern: RegExp; riskLevel: RiskLevel }> {
    return [...this.customPatterns]
  }
}

// Singleton instance
let detectorInstance: SensitiveDataDetector | null = null

export function getSensitiveDataDetector(): SensitiveDataDetector {
  if (!detectorInstance) {
    detectorInstance = new SensitiveDataDetector()
  }
  return detectorInstance
}
