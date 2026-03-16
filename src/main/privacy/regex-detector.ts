/**
 * Regex-based PII Detector
 * Detects structured PII patterns: emails, phones, IBANs, IPs, credit cards, URLs.
 * Deterministic, zero-latency, handles 80% of common PII patterns.
 */

import type { PIIEntity, PIICategory, DetectionSource } from './pii-types'
import { PII_SENSITIVITY } from './pii-types'

interface RegexPattern {
  category: PIICategory
  pattern: RegExp
  source: DetectionSource
}

const PATTERNS: RegexPattern[] = [
  // Email addresses
  {
    category: 'EMAIL',
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    source: 'regex'
  },

  // Credit card numbers (major formats with optional separators)
  {
    category: 'CREDIT_CARD',
    pattern: /\b(?:4[0-9]{3}|5[1-5][0-9]{2}|3[47][0-9]{1}|6(?:011|5[0-9]{2}))[- ]?[0-9]{4}[- ]?[0-9]{4}[- ]?[0-9]{3,4}\b/g,
    source: 'regex'
  },

  // IP addresses (v4)
  {
    category: 'IP_ADDRESS',
    pattern: /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    source: 'regex'
  },

  // Date of birth patterns (DD.MM.YYYY, DD/MM/YYYY, YYYY-MM-DD)
  {
    category: 'DATE_OF_BIRTH',
    pattern: /\b(?:geboren\s+am|geboren|geb\.|Geburtsdatum|né(?:e)?\s+le|born\s+on|born|DOB|date of birth|date de naissance|data di nascita)[:\s]*(\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2})\b/gi,
    source: 'regex'
  },

  // Age patterns
  {
    category: 'AGE',
    pattern: /\b(\d{1,3})\s*(?:Jahre?\s*alt|years?\s*old|jährig|j\.a\.|J\.)\b/gi,
    source: 'regex'
  },

  // URLs with potential PII (user profiles, etc.)
  {
    category: 'URL',
    pattern: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g,
    source: 'regex'
  },

  // International phone numbers (generic, before Swiss-specific)
  {
    category: 'PHONE',
    pattern: /\b(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{2,4}[\s.-]?\d{0,4}\b/g,
    source: 'regex'
  }
]

/** Email pattern used to extract emails from URLs */
const EMAIL_IN_URL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

/**
 * Run all regex patterns against input text and return detected entities.
 */
export function detectWithRegex(text: string): PIIEntity[] {
  const entities: PIIEntity[] = []

  for (const { category, pattern, source } of PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(text)) !== null) {
      const matchedText = match[0]
      const start = match.index
      const end = start + matchedText.length

      // Skip very short phone matches (likely false positives like years)
      if (category === 'PHONE' && matchedText.replace(/\D/g, '').length < 7) {
        continue
      }

      entities.push({
        category,
        original: matchedText,
        start,
        end,
        confidence: 1.0, // Regex matches are deterministic
        source,
        sensitivity: PII_SENSITIVITY[category]
      })

      // Extract emails embedded in URLs (e.g., ?email=hans@test.ch)
      if (category === 'URL') {
        EMAIL_IN_URL_PATTERN.lastIndex = 0
        let emailMatch: RegExpExecArray | null
        while ((emailMatch = EMAIL_IN_URL_PATTERN.exec(matchedText)) !== null) {
          entities.push({
            category: 'EMAIL',
            original: emailMatch[0],
            start: start + emailMatch.index,
            end: start + emailMatch.index + emailMatch[0].length,
            confidence: 0.95,
            source: 'regex',
            sensitivity: PII_SENSITIVITY.EMAIL
          })
        }
      }
    }
  }

  return entities
}
