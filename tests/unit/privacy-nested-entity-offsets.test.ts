/**
 * Regression tests for two related PII-pipeline bugs, both surfaced by
 * anonymizing "Kontakt: anna.meier@example.ch" in shield mode:
 *
 * 1. Offset drift on nested entities. The NER layer tags "anna" and "meier"
 *    as separate name fragments — both are full substrings of the EMAIL the
 *    regex layer already matched as a whole. A prior "co-existence" rule in
 *    deduplicateEntities() (detector-pipeline.ts) deliberately kept both the
 *    EMAIL and its nested NER fragments. anonymizer.ts then replaces every
 *    surviving entity sequentially using offsets from the ORIGINAL text,
 *    which only works if the entities are mutually disjoint — replacing the
 *    nested fragments corrupts the fake email it just inserted.
 *    Measured: "Kontakt: davi[CUSTOM]b[CUSTOM]otonmail.ch"
 *
 * 2. Non-unique shield-mode fallback markers. Categories without a
 *    plausible-fake-data generator (CUSTOM, ORGANIZATION) fell back to a
 *    bare "[CATEGORY]" marker for every entity of that category. Two
 *    different CUSTOM entities in the same text therefore produced the
 *    IDENTICAL replacement string, which made the reverse (fake -> original)
 *    mapping ambiguous — rehydration can only recover whichever original was
 *    added last.
 *
 * The mock NER entities below mirror exactly what the real piiranha-v1 model
 * produced for this input (verified with the real ONNX model in
 * tests/integration/privacy-ner-integration.test.ts, `RUN_NER_INTEGRATION=1`
 * — the model is comparatively slow to cold-start, so the fast unit-level
 * regression here uses a mock NER detector with the captured real output).
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { PIIEntity } from '../../src/main/privacy/pii-types'
import { setNERDetector, deduplicateEntities } from '../../src/main/privacy/detector-pipeline'
import { PIIAnonymizer } from '../../src/main/privacy/anonymizer'
import { rehydrate } from '../../src/main/privacy/rehydrator'
import { PrivacySessionMap } from '../../src/main/privacy/session-map'

function mockNERDetector(entities: PIIEntity[]) {
  return {
    isAvailable: () => true,
    detect: async () => entities,
    shutdown: () => {},
    getModelManager: () => undefined as any
  } as any
}

/**
 * Mirrors the production wiring in src/main/ipc/privacy-handlers.ts:
 * anonymize() -> build a PrivacySessionMap from the replacement map -> rehydrate().
 */
async function anonymizeAndRehydrate(text: string, anon: PIIAnonymizer) {
  const result = await anon.anonymize(text)
  const sessionMap = new PrivacySessionMap(text)
  const categoryMap = new Map(result.replacements.map(r => [r.entity.original, r.entity.category]))
  sessionMap.importFromAnonymizer(anon.getReplacementMap(), categoryMap)
  const rehydrated = rehydrate(result.anonymizedText, sessionMap, anon.getMode())
  return { result, rehydrated }
}

describe('Bug 1 — nested-entity offset drift ("Kontakt: anna.meier@example.ch")', () => {
  afterEach(() => setNERDetector(null))

  it('deduplicateEntities collapses a fully-nested NER fragment into its containing regex match', () => {
    const email: PIIEntity = {
      category: 'EMAIL', original: 'anna.meier@example.ch', start: 9, end: 30,
      confidence: 1.0, source: 'regex', sensitivity: 'high'
    }
    const anna: PIIEntity = {
      category: 'CUSTOM', original: 'anna', start: 9, end: 13,
      confidence: 0.7, source: 'ner', sensitivity: 'medium'
    }
    const meier: PIIEntity = {
      category: 'CUSTOM', original: 'meier', start: 14, end: 19,
      confidence: 0.7, source: 'ner', sensitivity: 'medium'
    }

    const result = deduplicateEntities([email, anna, meier])

    expect(result).toHaveLength(1)
    expect(result[0].category).toBe('EMAIL')
    expect(result[0].original).toBe('anna.meier@example.ch')
  })

  it('anonymize -> rehydrate reproduces the original text exactly (measured repro)', async () => {
    setNERDetector(mockNERDetector([
      { category: 'CUSTOM', original: 'anna', start: 9, end: 13, confidence: 0.7, source: 'ner', sensitivity: 'medium' },
      { category: 'CUSTOM', original: 'meier', start: 14, end: 19, confidence: 0.7, source: 'ner', sensitivity: 'medium' }
    ]))

    const input = 'Kontakt: anna.meier@example.ch'
    const anon = new PIIAnonymizer('probe-1', 'shield')
    const { result, rehydrated } = await anonymizeAndRehydrate(input, anon)

    // The anonymized text must never contain a mid-token marker like the
    // measured "davi[CUSTOM]b[CUSTOM]otonmail.ch" corruption.
    expect(result.anonymizedText).not.toMatch(/\[CUSTOM/i)
    expect(rehydrated.rehydratedText).toBe(input)
  })
})

describe('Bug 2 — non-unique shield-mode fallback markers', () => {
  afterEach(() => setNERDetector(null))

  it('two distinct CUSTOM entities get distinct markers and round-trip to their own originals', async () => {
    setNERDetector(mockNERDetector([
      { category: 'CUSTOM', original: 'alice123', start: 9, end: 17, confidence: 0.9, source: 'ner', sensitivity: 'medium' },
      { category: 'CUSTOM', original: 'bob456', start: 28, end: 34, confidence: 0.9, source: 'ner', sensitivity: 'medium' }
    ]))

    const input = 'Benutzer alice123 und Konto bob456'
    const anon = new PIIAnonymizer('probe-1', 'shield')
    const { result, rehydrated } = await anonymizeAndRehydrate(input, anon)

    const markers = result.replacements.map(r => r.replacement)
    expect(new Set(markers).size).toBe(markers.length)
    expect(rehydrated.rehydratedText).toBe(input)
  })

  it('vault mode keeps the shared [CATEGORY] marker unchanged (intentionally non-reversible)', async () => {
    setNERDetector(mockNERDetector([
      { category: 'CUSTOM', original: 'alice123', start: 9, end: 17, confidence: 0.9, source: 'ner', sensitivity: 'medium' },
      { category: 'CUSTOM', original: 'bob456', start: 28, end: 34, confidence: 0.9, source: 'ner', sensitivity: 'medium' }
    ]))

    const input = 'Benutzer alice123 und Konto bob456'
    const anon = new PIIAnonymizer('probe-1', 'vault')
    const result = await anon.anonymize(input)

    expect(result.anonymizedText).toBe('Benutzer [CUSTOM] und Konto [CUSTOM]')
  })
})
