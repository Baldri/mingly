/**
 * PII Types — Shared type definitions for the privacy pipeline.
 */

/** Supported PII entity categories */
export type PIICategory =
  | 'PERSON'           // Full names
  | 'EMAIL'            // Email addresses
  | 'PHONE'            // Phone numbers (CH + international)
  | 'IBAN'             // Bank account numbers
  | 'AHV'              // Swiss social security number (756.XXXX.XXXX.XX)
  | 'ADDRESS'          // Street addresses
  | 'LOCATION'         // Cities, cantons, countries
  | 'DATE_OF_BIRTH'    // Birth dates
  | 'AGE'              // Age mentions
  | 'IP_ADDRESS'       // IP addresses
  | 'CREDIT_CARD'      // Credit card numbers
  | 'PASSPORT'         // Passport numbers
  | 'URL'              // URLs that may contain PII
  | 'MEDICAL'          // Medical conditions (detected but NOT anonymized by default)
  | 'CUSTOM'           // User-defined patterns

/** Sensitivity levels for PII categories */
export type PIISensitivity = 'critical' | 'high' | 'medium' | 'low'

/** Detection source */
export type DetectionSource = 'regex' | 'ner' | 'swiss' | 'custom'

/** A single detected PII entity */
export interface PIIEntity {
  /** PII category */
  category: PIICategory
  /** Original text as found in input */
  original: string
  /** Start character offset in original text */
  start: number
  /** End character offset in original text */
  end: number
  /** Detection confidence (0-1, 1.0 for regex) */
  confidence: number
  /** How it was detected */
  source: DetectionSource
  /** Sensitivity level */
  sensitivity: PIISensitivity
}

/** Result of PII detection */
export interface DetectionResult {
  /** All detected entities, sorted by position */
  entities: PIIEntity[]
  /** Original input text */
  originalText: string
  /** Detection latency in ms */
  latencyMs: number
  /** Number of entities per category */
  stats: Record<PIICategory, number>
}

/** Privacy processing modes */
export type PrivacyMode = 'shield' | 'vault' | 'transparent' | 'local_only'

/** A single anonymization replacement */
export interface PIIReplacement {
  entity: PIIEntity
  /** Replacement text (fake data for shield, [REDACTED] for vault, original for transparent) */
  replacement: string
}

/** Result of anonymization */
export interface AnonymizationResult {
  /** Anonymized text ready to send to LLM */
  anonymizedText: string
  /** All replacements made */
  replacements: PIIReplacement[]
  /** Privacy mode used */
  mode: PrivacyMode
  /** Total latency (detection + anonymization) in ms */
  latencyMs: number
  /** Summary stats */
  stats: {
    detected: number
    anonymized: number
    kept: number  // entities detected but not replaced (e.g., medical in shield mode)
  }
}

/** Sensitivity mapping for each PII category */
export const PII_SENSITIVITY: Record<PIICategory, PIISensitivity> = {
  AHV: 'critical',
  CREDIT_CARD: 'critical',
  PASSPORT: 'critical',
  MEDICAL: 'critical',
  IBAN: 'high',
  DATE_OF_BIRTH: 'high',
  EMAIL: 'high',
  PERSON: 'high',
  PHONE: 'medium',
  ADDRESS: 'medium',
  LOCATION: 'medium',
  AGE: 'medium',
  IP_ADDRESS: 'medium',
  URL: 'low',
  CUSTOM: 'medium'
}
