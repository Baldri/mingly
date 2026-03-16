/**
 * Swiss-specific PII Detector
 * Detects CH-specific PII: AHV numbers, Swiss IBANs, CH phone numbers,
 * Swiss postal codes + cities, cantons.
 *
 * Note: This module uses RegExp for PII pattern matching only (no shell/process usage).
 */

import type { PIIEntity } from './pii-types'
import { PII_SENSITIVITY } from './pii-types'

/** Swiss AHV number: 756.XXXX.XXXX.XX (with checksum validation) */
// \s includes newlines — handles AHV split across lines
const AHV_PATTERN = /\b756[.\s-]{0,3}\d{4}[.\s-]{0,3}\d{4}[.\s-]{0,3}\d{2}\b/g

/** Swiss IBAN: CH followed by 2 check digits + 17 alphanumeric */
const CH_IBAN_PATTERN = /\bCH\s?\d{2}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{4}\s?\d{1}\b/gi

/** Swiss mobile: 07X XXX XX XX (with various separators) */
const CH_MOBILE_PATTERN = /(?<=\s|^)(?:\+41\s?|0041\s?|0)7[5-9]\s?\d{3}\s?\d{2}\s?\d{2}\b/g

/** Swiss landline: 0XX XXX XX XX */
const CH_LANDLINE_PATTERN = /(?<=\s|^)(?:\+41\s?|0041\s?|0)(?:2[1-9]|3[1-4]|4[1-4]|5[12568]|6[1-2]|7[1-4]|81)\s?\d{3}\s?\d{2}\s?\d{2}\b/g

/** Swiss postal codes (1000-9999) followed by city name */
const CH_PLZ_CITY_PATTERN = /\b([1-9]\d{3})\s+([A-ZÄÖÜ][a-zäöüéèê]+(?:\s[A-ZÄÖÜ][a-zäöüéèê]+)?)\b/g

/** Swiss cantons (abbreviations) */
const CANTONS = new Set([
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR',
  'JU', 'LU', 'NE', 'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG',
  'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH'
])

/** Major Swiss cities for location detection */
const SWISS_CITIES = new Set([
  'Zürich', 'Zurich', 'Genf', 'Genève', 'Geneva', 'Basel', 'Bern',
  'Lausanne', 'Winterthur', 'Luzern', 'Lucerne', 'St. Gallen',
  'Lugano', 'Biel', 'Bienne', 'Thun', 'Köniz', 'La Chaux-de-Fonds',
  'Schaffhausen', 'Fribourg', 'Chur', 'Neuchâtel', 'Uster',
  'Sion', 'Emmen', 'Zug', 'Yverdon', 'Kriens', 'Rapperswil',
  'Dietikon', 'Aarau', 'Frauenfeld', 'Baden', 'Olten', 'Wil',
  'Solothurn', 'Davos', 'Interlaken', 'Montreux', 'Locarno'
])

/**
 * Validate AHV checksum (EAN-13 algorithm).
 */
function isValidAHV(ahv: string): boolean {
  const digits = ahv.replace(/\D/g, '')
  if (digits.length !== 13 || !digits.startsWith('756')) return false

  let sum = 0
  for (let i = 0; i < 12; i++) {
    const d = parseInt(digits[i])
    sum += i % 2 === 0 ? d : d * 3
  }
  const checkDigit = (10 - (sum % 10)) % 10
  return checkDigit === parseInt(digits[12])
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Detect Swiss-specific PII patterns.
 */
export function detectSwissPII(text: string): PIIEntity[] {
  const entities: PIIEntity[] = []

  // AHV numbers (with checksum validation)
  AHV_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = AHV_PATTERN.exec(text)) !== null) {
    if (isValidAHV(match[0])) {
      entities.push({
        category: 'AHV',
        original: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: 1.0,
        source: 'swiss',
        sensitivity: PII_SENSITIVITY.AHV
      })
    }
  }

  // Swiss IBANs
  CH_IBAN_PATTERN.lastIndex = 0
  while ((match = CH_IBAN_PATTERN.exec(text)) !== null) {
    entities.push({
      category: 'IBAN',
      original: match[0],
      start: match.index,
      end: match.index + match[0].length,
      confidence: 1.0,
      source: 'swiss',
      sensitivity: PII_SENSITIVITY.IBAN
    })
  }

  // Swiss mobile numbers
  CH_MOBILE_PATTERN.lastIndex = 0
  while ((match = CH_MOBILE_PATTERN.exec(text)) !== null) {
    entities.push({
      category: 'PHONE',
      original: match[0],
      start: match.index,
      end: match.index + match[0].length,
      confidence: 1.0,
      source: 'swiss',
      sensitivity: PII_SENSITIVITY.PHONE
    })
  }

  // Swiss landline numbers
  CH_LANDLINE_PATTERN.lastIndex = 0
  while ((match = CH_LANDLINE_PATTERN.exec(text)) !== null) {
    entities.push({
      category: 'PHONE',
      original: match[0],
      start: match.index,
      end: match.index + match[0].length,
      confidence: 1.0,
      source: 'swiss',
      sensitivity: PII_SENSITIVITY.PHONE
    })
  }

  // PLZ + City
  CH_PLZ_CITY_PATTERN.lastIndex = 0
  while ((match = CH_PLZ_CITY_PATTERN.exec(text)) !== null) {
    const plz = parseInt(match[1])
    if (plz >= 1000 && plz <= 9658) {
      entities.push({
        category: 'LOCATION',
        original: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: 0.9,
        source: 'swiss',
        sensitivity: PII_SENSITIVITY.LOCATION
      })
    }
  }

  // Known Swiss cities mentioned standalone
  for (const city of SWISS_CITIES) {
    const cityPattern = new RegExp(`\\b${escapeRegex(city)}\\b`, 'gi')
    while ((match = cityPattern.exec(text)) !== null) {
      const alreadyCovered = entities.some(
        e => e.start <= match!.index && e.end >= match!.index + match![0].length
      )
      if (!alreadyCovered) {
        entities.push({
          category: 'LOCATION',
          original: match[0],
          start: match.index,
          end: match.index + match[0].length,
          confidence: 0.8,
          source: 'swiss',
          sensitivity: PII_SENSITIVITY.LOCATION
        })
      }
    }
  }

  return entities
}

/** Exported for testing */
export { isValidAHV, SWISS_CITIES, CANTONS }
