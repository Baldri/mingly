/**
 * PII Detector Pipeline
 * Orchestrates detection across multiple sources: Regex -> Swiss -> NER (piiranha-v1).
 * Merges and deduplicates results, returns sorted entities.
 */

import type { PIIEntity, PIICategory, DetectionResult } from './pii-types'
import { detectWithRegex } from './regex-detector'
import { detectSwissPII } from './swiss-detector'
import { NERDetector } from './ner-detector'
import { preprocessText } from './text-preprocessor'

// Singleton NER detector — initialized lazily
let nerDetector: NERDetector | null = null

function getNERDetector(): NERDetector {
  if (!nerDetector) {
    nerDetector = new NERDetector()
  }
  return nerDetector
}

/** Allow injecting a mock detector for testing */
export function setNERDetector(detector: NERDetector | null): void {
  nerDetector = detector
}

/**
 * Run all detectors and merge results.
 * Entities are deduplicated (overlapping spans keep the higher-priority one)
 * and sorted by position.
 */
export async function detectPII(text: string): Promise<DetectionResult> {
  const start = performance.now()

  // Preprocess: strip zero-width chars, URL-decode, NFC normalize
  const { normalized, toOriginalOffset, wasModified } = preprocessText(text)

  // Layer 1: Regex patterns (emails, phones, IPs, credit cards, etc.)
  const regexEntities = detectWithRegex(normalized)

  // Layer 2: Swiss-specific patterns (AHV, CH-IBAN, CH-phones, cities)
  const swissEntities = detectSwissPII(normalized)

  // Layer 3: NER/ONNX model (piiranha-v1)
  const ner = getNERDetector()
  const nerEntities = ner.isAvailable() ? await ner.detect(normalized) : []

  // Merge all entities
  let allEntities = [...regexEntities, ...swissEntities, ...nerEntities]

  // Map offsets back to original text if preprocessing modified anything
  if (wasModified) {
    allEntities = allEntities.map(entity => ({
      ...entity,
      start: toOriginalOffset(entity.start),
      end: toOriginalOffset(entity.end),
      original: text.substring(
        toOriginalOffset(entity.start),
        toOriginalOffset(entity.end)
      )
    }))
  }

  // Deduplicate overlapping spans
  const deduped = deduplicateEntities(allEntities)

  // Sort by position
  deduped.sort((a, b) => a.start - b.start)

  // Build stats
  const stats = {} as Record<PIICategory, number>
  for (const entity of deduped) {
    stats[entity.category] = (stats[entity.category] ?? 0) + 1
  }

  return {
    entities: deduped,
    originalText: text,
    latencyMs: Math.round(performance.now() - start),
    stats
  }
}

/**
 * Remove overlapping entities, preferring:
 * 1. Swiss-specific over generic regex (more precise, e.g. AHV checksums)
 * 2. NER over regex — BUT only for non-structural categories (NER must not
 *    override pattern-matched entities like EMAIL, PHONE, CREDIT_CARD, etc.)
 * 3. Swiss over NER for Swiss-specific types (AHV, CH-IBAN — checksum validation)
 * 4. Higher confidence
 * 5. Longer match
 *
 * Co-existence: NER + regex entities with DIFFERENT categories on overlapping
 * spans are both kept (e.g., PERSON from NER + EMAIL from regex on "hans@test.ch").
 */
const SWISS_SPECIFIC_CATEGORIES = new Set(['AHV', 'IBAN'])

// Categories where regex patterns are structurally reliable and must not be
// overridden by NER. These are format-based matches (checksum, grammar, etc.).
const REGEX_STRUCTURAL_CATEGORIES = new Set([
  'EMAIL', 'PHONE', 'CREDIT_CARD', 'IP_ADDRESS', 'URL',
  'IBAN', 'AHV', 'DATE_OF_BIRTH',
])

function deduplicateEntities(entities: PIIEntity[]): PIIEntity[] {
  if (entities.length <= 1) return entities

  // Sort by start position, then by length descending
  const sorted = [...entities].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : (b.end - b.start) - (a.end - a.start)
  )

  const result: PIIEntity[] = []

  for (const entity of sorted) {
    const overlapping = result.find(
      existing => entity.start < existing.end && entity.end > existing.start
    )

    // Keep EMAIL entities that are sub-spans of URL entities (emails in URL params)
    if (overlapping && entity.category === 'EMAIL' && overlapping.category === 'URL' &&
        entity.start >= overlapping.start && entity.end <= overlapping.end) {
      result.push(entity)
      continue
    }

    if (!overlapping) {
      result.push(entity)
      continue
    }

    // Co-existence: NER entity overlaps a structural regex entity with a
    // DIFFERENT category → keep both (e.g., PERSON + EMAIL on same span)
    if (entity.source === 'ner' && overlapping.source === 'regex' &&
        REGEX_STRUCTURAL_CATEGORIES.has(overlapping.category) &&
        entity.category !== overlapping.category) {
      result.push(entity)
      continue
    }
    if (entity.source === 'regex' && overlapping.source === 'ner' &&
        REGEX_STRUCTURAL_CATEGORIES.has(entity.category) &&
        entity.category !== overlapping.category) {
      result.push(entity)
      continue
    }

    // Rule 1: Swiss > Regex
    if (entity.source === 'swiss' && overlapping.source === 'regex') {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }

    // Rule 2: NER > Regex (only for non-structural regex categories)
    if (entity.source === 'ner' && overlapping.source === 'regex' &&
        !REGEX_STRUCTURAL_CATEGORIES.has(overlapping.category)) {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }

    // Rule 3: Swiss > NER for Swiss-specific categories
    if (entity.source === 'swiss' && overlapping.source === 'ner' &&
        SWISS_SPECIFIC_CATEGORIES.has(entity.category)) {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }

    // Rule 4: Higher confidence
    if (entity.confidence > overlapping.confidence) {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }
  }

  return result
}

export { deduplicateEntities }
