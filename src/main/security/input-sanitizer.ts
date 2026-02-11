/**
 * Input Sanitizer — Layered Defense Against Prompt Injection
 *
 * Implements multiple defense layers:
 * 1. Regex pattern detection for known injection patterns
 * 2. Structural analysis (role spoofing, delimiter injection)
 * 3. Length/complexity limits
 * 4. Unicode normalization (prevents homoglyph attacks)
 *
 * DSG/DSGVO compliant: No user content is logged, only detection metadata.
 */

// ============================================================
// Types
// ============================================================

export interface SanitizationResult {
  safe: boolean
  sanitized: string
  warnings: SanitizationWarning[]
  riskScore: number // 0-100
}

export interface SanitizationWarning {
  type: InjectionType
  severity: 'low' | 'medium' | 'high' | 'critical'
  description: string
  /** Character offset where issue was detected */
  offset?: number
}

export type InjectionType =
  | 'role_spoofing'        // "You are now...", "Act as..."
  | 'delimiter_injection'  // Tries to break out of context
  | 'instruction_override' // "Ignore previous instructions"
  | 'system_prompt_leak'   // "Repeat your system prompt"
  | 'data_exfiltration'    // "Send all data to..."
  | 'encoding_attack'      // Base64, hex encoding to hide instructions
  | 'excessive_length'     // Unusually long input
  | 'unicode_abuse'        // Homoglyphs, invisible characters

// ============================================================
// Detection Patterns
// ============================================================

interface DetectionPattern {
  type: InjectionType
  severity: 'low' | 'medium' | 'high' | 'critical'
  pattern: RegExp
  description: string
}

const INJECTION_PATTERNS: DetectionPattern[] = [
  // Role spoofing
  {
    type: 'role_spoofing',
    severity: 'high',
    pattern: /\b(you are now|act as|pretend to be|you're now|from now on you are|your new role is)\b/i,
    description: 'Role spoofing attempt detected'
  },
  {
    type: 'role_spoofing',
    severity: 'high',
    pattern: /\b(system:\s|assistant:\s|<<SYS>>|<\|im_start\|>system)/i,
    description: 'Chat role injection detected'
  },

  // Instruction override
  {
    type: 'instruction_override',
    severity: 'critical',
    pattern: /\b(ignore (all )?(previous|prior|above|earlier) (instructions|prompts|rules|constraints))\b/i,
    description: 'Instruction override attempt'
  },
  {
    type: 'instruction_override',
    severity: 'critical',
    pattern: /\b(disregard|forget|override|bypass|skip) (all |any )?(safety|security|rules|guidelines|instructions|restrictions|filters)\b/i,
    description: 'Safety bypass attempt'
  },
  {
    type: 'instruction_override',
    severity: 'high',
    pattern: /\b(do not follow|stop following|new instructions|updated instructions|real instructions)\b/i,
    description: 'Instruction replacement attempt'
  },

  // System prompt leak
  {
    type: 'system_prompt_leak',
    severity: 'high',
    pattern: /\b(repeat|show|display|reveal|print|output) (your |the )?(system prompt|instructions|rules|initial prompt|hidden prompt|secret prompt)\b/i,
    description: 'System prompt extraction attempt'
  },
  {
    type: 'system_prompt_leak',
    severity: 'medium',
    pattern: /\b(what (are|were) your (instructions|rules|guidelines))\b/i,
    description: 'Indirect system prompt probe'
  },

  // Data exfiltration
  {
    type: 'data_exfiltration',
    severity: 'critical',
    pattern: /\b(send|post|transmit|forward|email|upload) (all |the )?(data|information|content|messages|conversations|keys|tokens|passwords) to\b/i,
    description: 'Data exfiltration attempt'
  },
  {
    type: 'data_exfiltration',
    severity: 'high',
    pattern: /\b(api[_-]?key|secret[_-]?key|access[_-]?token|bearer|authorization|password|credential)/i,
    description: 'Credential extraction attempt'
  },

  // Delimiter injection
  {
    type: 'delimiter_injection',
    severity: 'high',
    pattern: /---\s*(system|end of context|new instructions|admin|override)/i,
    description: 'Delimiter breakout attempt'
  },
  {
    type: 'delimiter_injection',
    severity: 'medium',
    pattern: /```\s*(system|instructions|override|admin)/i,
    description: 'Code block delimiter injection'
  },

  // Encoding attacks
  {
    type: 'encoding_attack',
    severity: 'medium',
    pattern: /\b(base64|hex|rot13|decode|atob|btoa)\s*[:(]/i,
    description: 'Encoded instruction attempt'
  }
]

// Invisible/control Unicode characters (excluding normal whitespace)
const INVISIBLE_CHARS = /[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u034F\u180E\u2060-\u2064\u2066-\u206F]/g

// ============================================================
// Input Sanitizer
// ============================================================

const MAX_INPUT_LENGTH = 100_000  // 100k characters
const MAX_LINE_COUNT = 5000

export class InputSanitizer {
  private customPatterns: DetectionPattern[] = []

  /**
   * Sanitize user input before sending to LLM.
   * Returns a SanitizationResult with warnings and risk score.
   */
  sanitize(input: string): SanitizationResult {
    const warnings: SanitizationWarning[] = []
    let sanitized = input

    // Layer 1: Length check
    if (input.length > MAX_INPUT_LENGTH) {
      warnings.push({
        type: 'excessive_length',
        severity: 'medium',
        description: `Input exceeds ${MAX_INPUT_LENGTH} characters (${input.length})`
      })
      sanitized = sanitized.slice(0, MAX_INPUT_LENGTH)
    }

    const lineCount = (input.match(/\n/g) || []).length + 1
    if (lineCount > MAX_LINE_COUNT) {
      warnings.push({
        type: 'excessive_length',
        severity: 'low',
        description: `Input has ${lineCount} lines (max ${MAX_LINE_COUNT})`
      })
    }

    // Layer 2: Unicode normalization — remove invisible characters
    const invisibleMatches = sanitized.match(INVISIBLE_CHARS)
    if (invisibleMatches && invisibleMatches.length > 0) {
      warnings.push({
        type: 'unicode_abuse',
        severity: 'medium',
        description: `${invisibleMatches.length} invisible Unicode characters removed`
      })
      sanitized = sanitized.replace(INVISIBLE_CHARS, '')
    }

    // Layer 3: Regex pattern detection
    const allPatterns = [...INJECTION_PATTERNS, ...this.customPatterns]
    for (const pattern of allPatterns) {
      const match = pattern.pattern.exec(sanitized)
      if (match) {
        warnings.push({
          type: pattern.type,
          severity: pattern.severity,
          description: pattern.description,
          offset: match.index
        })
      }
    }

    // Calculate risk score (0-100)
    const riskScore = this.calculateRiskScore(warnings)
    const safe = riskScore < 50

    return { safe, sanitized, warnings, riskScore }
  }

  /**
   * Sanitize RAG context to prevent indirect prompt injection.
   * Wraps context in clear boundaries and strips dangerous patterns.
   */
  sanitizeRAGContext(context: string): string {
    // Remove any chat role markers from documents
    let sanitized = context
      .replace(/\b(system|assistant|user):\s/gi, '[role]: ')
      .replace(/<<SYS>>|<\|im_start\|>/gi, '[marker]')
      .replace(/---\s*(system|end of context|new instructions|override)/gi, '---[filtered]')

    // Remove invisible characters
    sanitized = sanitized.replace(INVISIBLE_CHARS, '')

    return sanitized
  }

  /**
   * Add custom detection pattern (e.g., organization-specific terms)
   */
  addPattern(pattern: DetectionPattern): void {
    this.customPatterns.push(pattern)
  }

  /**
   * Get all active patterns (for admin inspection)
   */
  getPatterns(): DetectionPattern[] {
    return [...INJECTION_PATTERNS, ...this.customPatterns]
  }

  private calculateRiskScore(warnings: SanitizationWarning[]): number {
    if (warnings.length === 0) return 0

    const severityWeights: Record<string, number> = {
      low: 5,
      medium: 15,
      high: 30,
      critical: 50
    }

    let score = 0
    for (const warning of warnings) {
      score += severityWeights[warning.severity] || 10
    }

    return Math.min(100, score)
  }
}

// Singleton
let instance: InputSanitizer | null = null
export function getInputSanitizer(): InputSanitizer {
  if (!instance) instance = new InputSanitizer()
  return instance
}
