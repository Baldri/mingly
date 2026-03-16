/**
 * PII Detector Pipeline
 * Orchestrates detection across multiple sources: Regex -> Swiss -> NER (piiranha-v1).
 * Merges and deduplicates results, returns sorted entities.
 */

import type { PIIEntity, PIICategory, DetectionResult } from './pii-types'
import { detectWithRegex } from './regex-detector'
import { detectSwissPII } from './swiss-detector'
import { NERDetector } from './ner-detector'

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

  // Layer 1: Regex patterns (emails, phones, IPs, credit cards, etc.)
  const regexEntities = detectWithRegex(text)

  // Layer 2: Swiss-specific patterns (AHV, CH-IBAN, CH-phones, cities)
  const swissEntities = detectSwissPII(text)

  // Layer 3: NER/ONNX model (piiranha-v1)
  const ner = getNERDetector()
  const nerEntities = ner.isAvailable() ? await ner.detect(text) : []

  // Merge all entities
  const allEntities = [...regexEntities, ...swissEntities, ...nerEntities]

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
 * 2. NER over regex (contextual understanding)
 * 3. Swiss over NER for Swiss-specific types (AHV, CH-IBAN — checksum validation)
 * 4. Higher confidence
 * 5. Longer match
 */
const SWISS_SPECIFIC_CATEGORIES = new Set(['AHV', 'IBAN'])

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

    if (!overlapping) {
      result.push(entity)
      continue
    }

    // Rule 1: Swiss > Regex
    if (entity.source === 'swiss' && overlapping.source === 'regex') {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }

    // Rule 2: NER > Regex
    if (entity.source === 'ner' && overlapping.source === 'regex') {
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
