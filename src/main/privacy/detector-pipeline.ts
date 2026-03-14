/**
 * PII Detector Pipeline
 * Orchestrates detection across multiple sources: Regex → Swiss → (NER in future).
 * Merges and deduplicates results, returns sorted entities.
 */

import type { PIIEntity, PIICategory, DetectionResult } from './pii-types'
import { detectWithRegex } from './regex-detector'
import { detectSwissPII } from './swiss-detector'

/**
 * Run all detectors and merge results.
 * Entities are deduplicated (overlapping spans keep the higher-confidence one)
 * and sorted by position.
 */
export function detectPII(text: string): DetectionResult {
  const start = performance.now()

  // Layer 1: Regex patterns (emails, phones, IPs, credit cards, etc.)
  const regexEntities = detectWithRegex(text)

  // Layer 2: Swiss-specific patterns (AHV, CH-IBAN, CH-phones, cities)
  const swissEntities = detectSwissPII(text)

  // Layer 3: NER/ONNX model (future — piiranha-v1)
  // const nerEntities = await detectWithNER(text)

  // Merge all entities
  const allEntities = [...regexEntities, ...swissEntities]

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
 * 1. Swiss-specific over generic (more precise)
 * 2. Higher confidence
 * 3. Longer match
 */
function deduplicateEntities(entities: PIIEntity[]): PIIEntity[] {
  if (entities.length <= 1) return entities

  // Sort by start position, then by length descending
  const sorted = [...entities].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : (b.end - b.start) - (a.end - a.start)
  )

  const result: PIIEntity[] = []

  for (const entity of sorted) {
    // Check if this entity overlaps with any already-accepted entity
    const overlapping = result.find(
      existing => entity.start < existing.end && entity.end > existing.start
    )

    if (!overlapping) {
      result.push(entity)
      continue
    }

    // Prefer Swiss-specific detection over generic regex
    if (entity.source === 'swiss' && overlapping.source === 'regex') {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }

    // Prefer higher confidence
    if (entity.confidence > overlapping.confidence) {
      const idx = result.indexOf(overlapping)
      result[idx] = entity
      continue
    }

    // Otherwise skip (keep existing)
  }

  return result
}

export { deduplicateEntities }
