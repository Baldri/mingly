/**
 * PII Anonymizer
 * Replaces detected PII with plausible fake data (Shield mode),
 * redaction markers (Vault mode), or leaves unchanged (Transparent mode).
 *
 * Uses deterministic seeding per session for consistent replacements
 * (same PII always maps to the same fake value within a conversation).
 */

import type {
  PIIEntity, PIICategory, PIIReplacement,
  AnonymizationResult, PrivacyMode
} from './pii-types'
import { detectPII } from './detector-pipeline'

// ── Fake Data Pools (CH-focused) ─────────────────────────────

const SWISS_FIRST_NAMES_M = [
  'Thomas', 'Daniel', 'Michael', 'Peter', 'Andreas', 'Martin', 'Stefan',
  'Marco', 'Patrick', 'Christian', 'David', 'Markus', 'Simon', 'Lukas',
  'Reto', 'Marcel', 'Fabian', 'René', 'Beat', 'Urs'
]

const SWISS_FIRST_NAMES_F = [
  'Sandra', 'Andrea', 'Monika', 'Nicole', 'Claudia', 'Barbara', 'Daniela',
  'Sabine', 'Christine', 'Maria', 'Karin', 'Petra', 'Kathrin', 'Sarah',
  'Laura', 'Anna', 'Lisa', 'Nina', 'Silvia', 'Ruth'
]

const SWISS_LAST_NAMES = [
  'Müller', 'Meier', 'Schmid', 'Keller', 'Weber', 'Huber', 'Schneider',
  'Meyer', 'Steiner', 'Fischer', 'Gerber', 'Brunner', 'Baumann', 'Frei',
  'Zimmermann', 'Moser', 'Widmer', 'Wyss', 'Graf', 'Roth'
]

const SWISS_CITIES = [
  'Zürich', 'Bern', 'Basel', 'Lausanne', 'Luzern', 'St. Gallen',
  'Winterthur', 'Biel', 'Thun', 'Aarau', 'Schaffhausen', 'Fribourg',
  'Chur', 'Olten', 'Baden', 'Zug', 'Frauenfeld', 'Solothurn'
]

const SWISS_STREETS = [
  'Bahnhofstrasse', 'Hauptstrasse', 'Dorfstrasse', 'Kirchgasse',
  'Seestrasse', 'Bergstrasse', 'Industriestrasse', 'Gartenweg',
  'Mühleweg', 'Rosenweg', 'Schulstrasse', 'Lindenstrasse'
]

const EMAIL_PROVIDERS = [
  'gmail.com', 'bluewin.ch', 'gmx.ch', 'outlook.com', 'protonmail.ch'
]

// ── Seeded Random ─────────────────────────────────────────────

/**
 * Simple seeded pseudo-random number generator (Mulberry32).
 * Produces deterministic sequences per seed.
 */
function createSeededRandom(seed: number): () => number {
  let t = seed
  return () => {
    t = (t + 0x6D2B79F5) | 0
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash)
}

// ── Anonymizer ────────────────────────────────────────────────

export class PIIAnonymizer {
  private sessionId: string
  private mode: PrivacyMode
  private random: () => number
  /** Maps original PII text → replacement text for consistency */
  private replacementMap: Map<string, string> = new Map()

  constructor(sessionId: string, mode: PrivacyMode = 'shield') {
    this.sessionId = sessionId
    this.mode = mode
    this.random = createSeededRandom(hashString(sessionId))
  }

  getMode(): PrivacyMode {
    return this.mode
  }

  setMode(mode: PrivacyMode): void {
    this.mode = mode
  }

  /**
   * Detect and anonymize PII in the given text.
   */
  anonymize(text: string): AnonymizationResult {
    const startTime = performance.now()
    const detection = detectPII(text)

    if (this.mode === 'transparent' || detection.entities.length === 0) {
      return {
        anonymizedText: text,
        replacements: [],
        mode: this.mode,
        latencyMs: Math.round(performance.now() - startTime),
        stats: { detected: detection.entities.length, anonymized: 0, kept: detection.entities.length }
      }
    }

    const replacements: PIIReplacement[] = []
    let anonymized = text
    let offset = 0
    let keptCount = 0

    // Process entities in order (sorted by position from detector)
    for (const entity of detection.entities) {
      // Medical entities are detected but NOT replaced in Shield mode
      if (this.mode === 'shield' && entity.category === 'MEDICAL') {
        keptCount++
        continue
      }

      const replacement = this.getReplacementText(entity)
      replacements.push({ entity, replacement })

      // Apply replacement with offset tracking
      const adjustedStart = entity.start + offset
      const adjustedEnd = entity.end + offset
      anonymized = anonymized.slice(0, adjustedStart) + replacement + anonymized.slice(adjustedEnd)
      offset += replacement.length - (entity.end - entity.start)
    }

    return {
      anonymizedText: anonymized,
      replacements,
      mode: this.mode,
      latencyMs: Math.round(performance.now() - startTime),
      stats: {
        detected: detection.entities.length,
        anonymized: replacements.length,
        kept: keptCount
      }
    }
  }

  /**
   * Get or create a consistent replacement for a PII entity.
   */
  private getReplacementText(entity: PIIEntity): string {
    if (this.mode === 'vault') {
      return `[${entity.category}]`
    }

    // Shield mode: check if we already have a replacement for this exact text
    const existing = this.replacementMap.get(entity.original)
    if (existing) return existing

    const replacement = this.generateFakeData(entity)
    this.replacementMap.set(entity.original, replacement)
    return replacement
  }

  /**
   * Generate plausible fake data based on the PII category.
   */
  private generateFakeData(entity: PIIEntity): string {
    const pick = <T>(arr: T[]): T => arr[Math.floor(this.random() * arr.length)]

    switch (entity.category) {
      case 'PERSON': {
        const firstName = pick([...SWISS_FIRST_NAMES_M, ...SWISS_FIRST_NAMES_F])
        const lastName = pick(SWISS_LAST_NAMES)
        return `${firstName} ${lastName}`
      }

      case 'EMAIL': {
        const first = pick(SWISS_FIRST_NAMES_M).toLowerCase()
        const last = pick(SWISS_LAST_NAMES).toLowerCase().replace(/ü/g, 'ue').replace(/ö/g, 'oe').replace(/ä/g, 'ae')
        const provider = pick(EMAIL_PROVIDERS)
        return `${first}.${last}@${provider}`
      }

      case 'PHONE': {
        const prefix = pick(['079', '078', '076', '077'])
        const n1 = String(Math.floor(this.random() * 900) + 100)
        const n2 = String(Math.floor(this.random() * 90) + 10)
        const n3 = String(Math.floor(this.random() * 90) + 10)
        return `${prefix} ${n1} ${n2} ${n3}`
      }

      case 'IBAN': {
        const checkDigits = String(Math.floor(this.random() * 90) + 10)
        const bankCode = String(Math.floor(this.random() * 9000) + 1000)
        const account = Array.from({ length: 12 }, () => Math.floor(this.random() * 10)).join('')
        return `CH${checkDigits}${bankCode}${account}0`
      }

      case 'AHV': {
        // Generate a valid-looking but fake AHV number
        const digits = '756' + Array.from({ length: 9 }, () => Math.floor(this.random() * 10)).join('')
        // Calculate checksum
        let sum = 0
        for (let i = 0; i < 12; i++) {
          sum += parseInt(digits[i]) * (i % 2 === 0 ? 1 : 3)
        }
        const check = (10 - (sum % 10)) % 10
        const full = digits + check
        return `${full.slice(0, 3)}.${full.slice(3, 7)}.${full.slice(7, 11)}.${full.slice(11, 13)}`
      }

      case 'LOCATION':
        return pick(SWISS_CITIES)

      case 'ADDRESS': {
        const street = pick(SWISS_STREETS)
        const num = Math.floor(this.random() * 50) + 1
        return `${street} ${num}`
      }

      case 'AGE': {
        // Shift age by ±5 years
        const ageMatch = entity.original.match(/(\d+)/)
        if (ageMatch) {
          const originalAge = parseInt(ageMatch[1])
          const shift = Math.floor(this.random() * 11) - 5
          const newAge = Math.max(1, originalAge + shift)
          return entity.original.replace(ageMatch[1], String(newAge))
        }
        return entity.original
      }

      case 'DATE_OF_BIRTH': {
        // Shift date by ±30 days
        const dateMatch = entity.original.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/)
        if (dateMatch) {
          const day = Math.floor(this.random() * 28) + 1
          const month = Math.floor(this.random() * 12) + 1
          return entity.original.replace(
            dateMatch[0],
            `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${dateMatch[3]}`
          )
        }
        return entity.original
      }

      case 'IP_ADDRESS': {
        const octets = Array.from({ length: 4 }, () => Math.floor(this.random() * 254) + 1)
        return octets.join('.')
      }

      case 'CREDIT_CARD':
        return '4XXX-XXXX-XXXX-' + String(Math.floor(this.random() * 9000) + 1000)

      case 'PASSPORT':
        return 'X' + String(Math.floor(this.random() * 9000000) + 1000000)

      case 'URL':
        return 'https://example.com/redacted'

      default:
        return `[${entity.category}]`
    }
  }

  /**
   * Get the current replacement map (for rehydration).
   */
  getReplacementMap(): Map<string, string> {
    return new Map(this.replacementMap)
  }

  /**
   * Clear all stored mappings (e.g., on session end).
   */
  clear(): void {
    this.replacementMap.clear()
  }
}
