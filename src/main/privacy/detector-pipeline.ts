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
 * Remove overlapping entities so that every surviving entity is mutually
 * disjoint from every other one.
 *
 * Why disjointness is mandatory (not just a nicety): anonymizer.ts applies
 * replacements SEQUENTIALLY over the original text, tracking one cumulative
 * offset (see `anonymize()` in anonymizer.ts). That is only correct if the
 * entities it receives never overlap — for any overlap (full containment or
 * a partial crossing), a later replacement is applied at a position that no
 * longer lines up with the text after an earlier replacement already
 * shifted it, corrupting the output.
 *
 * This function used to make a deliberate exception for "co-existence":
 * an NER entity and a structurally-reliable regex entity (EMAIL, PHONE, …)
 * on overlapping spans, but different categories, were BOTH kept — e.g. so
 * a name-shaped NER hit and a regex EMAIL hit on the same text wouldn't
 * silently lose one of them. In practice this mostly fired when NER tagged
 * a SUBSTRING of an already-matched EMAIL as a name fragment (e.g. NER
 * splits "anna.meier@example.ch" into "anna" + "meier", both fully nested
 * inside the EMAIL regex already matched as a whole). Keeping both nested
 * entities passed two overlapping spans downstream and corrupted the
 * anonymized text: "Kontakt: davi[CUSTOM]b[CUSTOM]otonmail.ch" instead of a
 * clean fake email. The same latent bug existed for the "EMAIL nested
 * inside URL" case a few lines below (embedded ?email= params).
 *
 * The fix: resolve EVERY overlap — nested or partial — via the same
 * source/confidence priority cascade, with no exceptions:
 * 1. Swiss > Regex (checksum-validated AHV/IBAN beats a generic regex guess
 *    at the SAME real-world value, even if the regex match is textually
 *    longer — this is not "two facts", it's one fact matched twice with
 *    different boundary confidence)
 * 2. NER > Regex — but only for non-structural regex categories (NER must
 *    not override pattern-matched entities like EMAIL, PHONE, CREDIT_CARD)
 * 3. Swiss > NER for Swiss-specific categories (AHV, CH-IBAN)
 * 4. Higher confidence wins
 * 5. Larger span wins (final tiebreak)
 *
 * Full containment (nested) vs. partial overlap are handled identically by
 * this cascade — there is no separate "outer always wins" rule. In the
 * common case (a structural regex/Swiss match containing an NER sub-token)
 * this resolves to the larger, more complete entity by rules 1/2/4/5 — the
 * full email protects more than its username fragment — but a
 * checksum-validated Swiss match still wins over a longer, looser regex
 * guess via rule 1, because span size is not what makes an entity
 * authoritative. Rule 5 (larger span) is the same, single rule that also
 * covers genuine partial (non-nesting) overlaps between two different
 * detector categories: whichever entity does not win on source/confidence
 * loses entirely, rather than surviving as a second overlapping fragment.
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
    const overlapIdx = result.findIndex(
      existing => entity.start < existing.end && entity.end > existing.start
    )

    if (overlapIdx === -1) {
      result.push(entity)
      continue
    }

    const existing = result[overlapIdx]

    // Rule 1: Swiss > Regex
    if (entity.source === 'swiss' && existing.source === 'regex') {
      result[overlapIdx] = entity
      continue
    }

    // Rule 2: NER > Regex (only for non-structural regex categories)
    if (entity.source === 'ner' && existing.source === 'regex' &&
        !REGEX_STRUCTURAL_CATEGORIES.has(existing.category)) {
      result[overlapIdx] = entity
      continue
    }

    // Rule 3: Swiss > NER for Swiss-specific categories
    if (entity.source === 'swiss' && existing.source === 'ner' &&
        SWISS_SPECIFIC_CATEGORIES.has(entity.category)) {
      result[overlapIdx] = entity
      continue
    }

    // Rule 4: Higher confidence wins
    if (entity.confidence > existing.confidence) {
      result[overlapIdx] = entity
      continue
    }

    // Rule 5: Final tiebreak — larger span wins (broader coverage; also the
    // rule that resolves genuine partial overlaps once source/confidence
    // don't discriminate between the two entities).
    if ((entity.end - entity.start) > (existing.end - existing.start)) {
      result[overlapIdx] = entity
      continue
    }

    // Otherwise `existing` already wins (equal-or-higher priority, equal-or-
    // larger span) — drop `entity` by leaving `result` unchanged.
  }

  return result
}

export { deduplicateEntities }
