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

/**
 * Street name with an optional house number.
 *
 * Layer 3 no longer emits STREET/BUILDINGNUM (see model-manager.ts): the
 * current model returns a street as LOC, so shield mode substituted a CITY
 * for it — "an der Bahnhofstrasse 12" became "an der Lausanne 12" — and left
 * the number in the clear. German-language street names end in a small,
 * closed set of suffixes, which makes them a pattern rather than a
 * prediction; matching them here restores a plausible substitution and
 * captures the number too.
 *
 * The leading part requires at least two lowercase letters before the
 * suffix, which is what keeps a bare noun out: "Weg" has none, and
 * "Bewegung" does not end on the suffix. A compound that merely ends in one
 * of these ("Vorgehensweg") would match — over-redaction, which is the safe
 * direction for a privacy filter, and rare in the texts this sees.
 */
const CH_STREET_PATTERN =
  /\b[A-ZÄÖÜ][a-zäöüéèêß-]{2,}(?:strasse|straße|gasse|weg|platz|allee|ring|steig|damm|ufer)(?:\s+\d{1,4}\s?[a-zA-Z]?\b)?/g

/**
 * City names that are also ordinary German words.
 *
 * Matched as bare words, every "Zug" became a LOCATION and shield mode swapped
 * a city in for it — measured 2026-08-05: "Der Zug nach Zürich faellt aus."
 * became "Der Luzern nach Baden faellt aus."
 *
 * Membership is measured, not assumed. "Chur" was claimed to belong here and
 * does not — it is no German word. Only these two fired in non-place
 * sentences ("Er hat einen Zug gemacht", "Nach dem Baden gingen wir essen").
 *
 * They are not simply removed from SWISS_CITIES: layer 3 does not cover them
 * either. "Ich wohne in Zug." produced no NER entity at all, only this Swiss
 * match — dropping the name would lose a real city.
 */
const AMBIGUOUS_CITIES = new Set(['Zug', 'Baden'])

/**
 * A locative cue directly before an ambiguous name makes it a place.
 *
 * Anchored at the end of the text preceding the match. Deliberately narrow —
 * a preposition, an administrative word, or a postal code. "Nach dem Baden"
 * fails because the token before the name is "dem", not "nach".
 *
 * `im` and `beim` are deliberately NOT cues, and that is the sharpest signal
 * German offers here: "in Zug" is the city, "im Zug" is the train; "bei
 * Baden" is the town, "beim Baden" is the activity. The contracted form marks
 * the common noun.
 *
 * Accepted cost: an ambiguous name at the start of a sentence
 * ("Zug ist eine schöne Stadt.") has no cue and is missed. That is
 * under-redaction of a city name — weak on its own — against mangling every
 * sentence that mentions a train. A postal code still catches the address
 * form via CH_PLZ_CITY_PATTERN.
 */
const LOCATIVE_CUE = /(?:\b(?:in|nach|aus|bei|von|zu|ab|über|ueber|via|um|Kanton|Stadt|Gemeinde|PLZ)\s+|\d{4}\s+)$/i

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

  // Street (+ house number)
  //
  // Confidence 1.0 like the other structural patterns here, and that value
  // matters: deduplicateEntities resolves the overlap with the layer-3 LOC
  // hit for the same street by confidence first, then by span. The model
  // also reports 1.0, so the tie is broken by the longer span — which is the
  // street *including* its number. A lower value here would silently hand
  // the span back to LOC and undo the point of this pattern.
  CH_STREET_PATTERN.lastIndex = 0
  while ((match = CH_STREET_PATTERN.exec(text)) !== null) {
    const original = match[0].trimEnd()
    entities.push({
      category: 'ADDRESS',
      original,
      start: match.index,
      end: match.index + original.length,
      confidence: 1.0,
      source: 'swiss',
      sensitivity: PII_SENSITIVITY.ADDRESS
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

      // Names that double as ordinary German words only count as a place when
      // a locative cue precedes them — see AMBIGUOUS_CITIES / LOCATIVE_CUE.
      const needsCue = AMBIGUOUS_CITIES.has(city)
      const hasCue = !needsCue || LOCATIVE_CUE.test(text.slice(0, match.index))

      if (!alreadyCovered && hasCue) {
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
