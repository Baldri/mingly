/**
 * Output Guardrails — LLM Response Safety Checks.
 *
 * Scans LLM output for:
 * 1. System Prompt Leakage — detect if LLM echoed the system prompt
 * 2. Injection in Response — detect if LLM response contains manipulation attempts
 * 3. Swiss PII Formats — AHV-Nr, CH-IBAN, CH phone numbers, PLZ
 * 4. PII in RAG context — scan retrieved docs before injection
 *
 * Runs AFTER LLM response, BEFORE returning to user.
 * Non-blocking by default (logs warnings), can be configured to redact.
 */

// ── Types ──────────────────────────────────────────────────────

export type OutputViolationType =
  | 'system_prompt_leak'
  | 'injection_in_response'
  | 'swiss_pii'
  | 'generic_pii'

export interface OutputViolation {
  type: OutputViolationType
  severity: 'low' | 'medium' | 'high' | 'critical'
  description: string
  position?: { start: number; end: number }
  matchedText?: string
}

export interface OutputScanResult {
  safe: boolean
  violations: OutputViolation[]
  redactedOutput?: string
}

// ── Swiss PII Patterns ─────────────────────────────────────────

const SWISS_PII_PATTERNS: Array<{
  name: string
  pattern: RegExp
  severity: 'medium' | 'high' | 'critical'
  redact: (match: string) => string
}> = [
  {
    name: 'AHV number (756.xxxx.xxxx.xx)',
    pattern: /\b756\.\d{4}\.\d{4}\.\d{2}\b/g,
    severity: 'critical',
    redact: () => '756.****.****.XX'
  },
  {
    name: 'Swiss IBAN (CHxx xxxx ...)',
    pattern: /\bCH\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{1}\b/g,
    severity: 'high',
    redact: (m) => `CH** **** **** **** ***${m.slice(-1)}`
  },
  {
    name: 'Swiss mobile (+41 7x / 07x)',
    pattern: /(?:\+41\s?|0)7[5-9]\s?\d{3}\s?\d{2}\s?\d{2}\b/g,
    severity: 'medium',
    redact: (m) => m.slice(0, 6) + '*** ** **'
  },
  {
    name: 'Swiss landline (+41 xx / 0xx)',
    pattern: /(?:\+41\s?|0)[1-9]\d\s?\d{3}\s?\d{2}\s?\d{2}\b/g,
    severity: 'medium',
    redact: (m) => m.slice(0, 6) + '*** ** **'
  },
  {
    name: 'Swiss PLZ + city pattern',
    pattern: /\b[1-9]\d{3}\s+[A-ZÄÖÜ][a-zäöüé]+(?:\s[A-ZÄÖÜ][a-zäöüé]+)?\b/g,
    severity: 'medium',
    redact: (m) => m.replace(/^\d{4}/, '****')
  }
]

// ── Injection-in-Response Patterns ─────────────────────────────

const INJECTION_RESPONSE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\[SYSTEM\]|<\|system\|>|<<SYS>>|<s>\[INST\]/i, description: 'LLM markup tokens in response' },
  { pattern: /you must now|you should now ignore|forget your instructions|new instructions/i, description: 'Instruction manipulation in response' },
  { pattern: /as an AI,? I (?:must|should|will) (?:now|always)/i, description: 'Self-referential instruction override' }
]

// ── Output Guardrails ──────────────────────────────────────────

export class OutputGuardrails {
  /**
   * Scan LLM output for safety violations.
   *
   * @param output - The LLM response text
   * @param systemPrompt - The system prompt (for leak detection)
   * @param redact - If true, return redacted output with PII masked
   */
  scan(output: string, systemPrompt?: string, redact: boolean = false): OutputScanResult {
    const violations: OutputViolation[] = []
    let redactedOutput = redact ? output : undefined

    // 1. System Prompt Leak Detection
    if (systemPrompt) {
      const leakViolations = this.detectSystemPromptLeak(output, systemPrompt)
      violations.push(...leakViolations)
    }

    // 2. Injection in Response
    const injectionViolations = this.detectInjectionInResponse(output)
    violations.push(...injectionViolations)

    // 3. Swiss PII
    const piiViolations = this.detectSwissPII(output)
    violations.push(...piiViolations)

    // Redact if requested
    if (redact && redactedOutput) {
      redactedOutput = this.redactSwissPII(redactedOutput)
    }

    return {
      safe: violations.length === 0,
      violations,
      redactedOutput
    }
  }

  /**
   * Scan RAG context for PII before injecting into system prompt.
   */
  scanRAGContext(context: string): OutputScanResult {
    const violations: OutputViolation[] = []

    // Check for Swiss PII in RAG documents
    const piiViolations = this.detectSwissPII(context)
    for (const v of piiViolations) {
      v.description = `[RAG Source] ${v.description}`
    }
    violations.push(...piiViolations)

    // Check for injection patterns in RAG documents
    const injectionViolations = this.detectInjectionInResponse(context)
    for (const v of injectionViolations) {
      v.description = `[RAG Source] ${v.description}`
      v.severity = 'high' // Elevate RAG injection severity
    }
    violations.push(...injectionViolations)

    return {
      safe: violations.length === 0,
      violations
    }
  }

  // ── Private Detection Methods ──────────────────────────────

  private detectSystemPromptLeak(output: string, systemPrompt: string): OutputViolation[] {
    const violations: OutputViolation[] = []

    // Extract significant phrases from system prompt (>= 30 chars)
    const sentences = systemPrompt.split(/[.!?\n]/).filter((s) => s.trim().length > 30)

    for (const sentence of sentences) {
      const trimmed = sentence.trim()
      // Normalized comparison (lowercase, collapse whitespace)
      const normalizedSentence = trimmed.toLowerCase().replace(/\s+/g, ' ')
      const normalizedOutput = output.toLowerCase().replace(/\s+/g, ' ')

      if (normalizedOutput.includes(normalizedSentence)) {
        violations.push({
          type: 'system_prompt_leak',
          severity: 'high',
          description: `System prompt fragment detected in output (${trimmed.substring(0, 40)}...)`,
          matchedText: trimmed.substring(0, 60)
        })
        break // One detection is enough
      }
    }

    return violations
  }

  private detectInjectionInResponse(output: string): OutputViolation[] {
    const violations: OutputViolation[] = []

    for (const { pattern, description } of INJECTION_RESPONSE_PATTERNS) {
      const match = pattern.exec(output)
      if (match) {
        violations.push({
          type: 'injection_in_response',
          severity: 'medium',
          description,
          position: { start: match.index, end: match.index + match[0].length },
          matchedText: match[0]
        })
      }
    }

    return violations
  }

  private detectSwissPII(text: string): OutputViolation[] {
    const violations: OutputViolation[] = []

    for (const { name, pattern, severity } of SWISS_PII_PATTERNS) {
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = pattern.exec(text)) !== null) {
        violations.push({
          type: 'swiss_pii',
          severity,
          description: `${name} found in output`,
          position: { start: match.index, end: match.index + match[0].length },
          matchedText: match[0]
        })
      }
    }

    return violations
  }

  private redactSwissPII(text: string): string {
    let redacted = text

    for (const { pattern, redact } of SWISS_PII_PATTERNS) {
      pattern.lastIndex = 0
      redacted = redacted.replace(pattern, (match) => redact(match))
    }

    return redacted
  }
}

// ── Singleton ──────────────────────────────────────────────────

let instance: OutputGuardrails | null = null

export function getOutputGuardrails(): OutputGuardrails {
  if (!instance) instance = new OutputGuardrails()
  return instance
}
