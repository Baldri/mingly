/**
 * Integration Test: Full production-path round trip with the REAL piiranha-v1
 * NER model, exercising the exact measured bug: anonymizing
 * "Kontakt: anna.meier@example.ch" via PIIAnonymizer (shield mode) and
 * rehydrating the result must reproduce the original text exactly.
 *
 * Skipped by default (matches tests/integration/privacy-ner-integration.test.ts) —
 * run with: RUN_NER_INTEGRATION=1 npx vitest run tests/integration/
 *
 * Unlike privacy-ner-integration.test.ts (which loads the ONNX pipeline
 * directly and hand-rolls token merging for isolated model testing), this
 * suite goes through the ACTUAL production wiring: PIIAnonymizer -> detectPII
 * -> NERDetector -> worker_thread -> ner-worker.js — the same path
 * src/main/ipc/privacy-handlers.ts uses. It deliberately lives in its own
 * file so its worker-thread lifecycle can't interfere with the shared
 * pipeline instance the primary NER integration suite loads in beforeAll.
 */
import { describe, it, expect } from 'vitest'
import { PIIAnonymizer } from '../../src/main/privacy/anonymizer'
import { detectPII } from '../../src/main/privacy/detector-pipeline'
import { rehydrate } from '../../src/main/privacy/rehydrator'
import { PrivacySessionMap } from '../../src/main/privacy/session-map'
import type { PIICategory } from '../../src/main/privacy/pii-types'

const SKIP = !process.env.RUN_NER_INTEGRATION

// Real NER cold-start (worker spawn + ONNX session init) plus inference can
// exceed vitest's default 5000ms test timeout even with the model cached
// locally — this is a latency characteristic of the ONNX pipeline, not a
// bug, so the timeout is raised for this test only (per CLAUDE.md: timeout
// increases are only acceptable for NER tests, never as a general fix).
const NER_TEST_TIMEOUT_MS = 60_000

describe.skipIf(SKIP)('PIIAnonymizer + rehydrate — real NER round trip', () => {
  /**
   * Positive control — MUST run in the same suite as the round-trip assertion
   * below, and must not be folded into it.
   *
   * The round-trip test's core assertion is a NEGATIVE one ("the anonymized
   * text contains no [CUSTOM marker"). If the NER layer were inactive — model
   * not downloaded, worker failed to spawn, ONNX init timed out — NERDetector
   * swallows the failure and returns [], no NER fragments are produced at all,
   * nothing can collide with the EMAIL regex match, and the negative assertion
   * passes trivially. A green result would then measure "NER never ran", not
   * "the nesting bug is fixed".
   *
   * This control cannot simply assert that a NER entity survives the round-trip
   * input: the whole point of the fix is that NER fragments nested inside the
   * EMAIL match get collapsed away, so zero surviving NER entities is the
   * CORRECT outcome there. It therefore probes a separate text.
   *
   * The probe asserts a PERSON specifically, not merely "some NER entity".
   * Person detection is the capability this layer exists for since the model
   * swap (see model-manager.ts), and no other layer can produce it — regex
   * and Swiss detectors emit no PERSON. A weaker control would pass on a
   * model that finds cities and nothing else, which is exactly the state the
   * swap was meant to leave behind.
   */
  it(
    'precondition: the real NER layer is live AND detects a person',
    async () => {
      const detection = await detectPII(
        'Der Patient Hans Müller wohnt an der Bahnhofstrasse 12 in Zürich.'
      )
      const persons = detection.entities.filter(e => e.category === 'PERSON')
      expect(
        persons.map(p => p.original),
        'No PERSON detected. Only the NER layer can produce one, so either the ' +
        'layer is not running or the model cannot do names — the state that ' +
        'prompted the 2026-08-05 model swap. Re-run scripts/ner-eval/ before ' +
        'changing this expectation.'
      ).toContain('Hans Müller')

      const nerEntities = detection.entities.filter(e => e.source === 'ner')

      expect(
        nerEntities.length,
        'No NER-sourced entity for a text measured to produce several — the NER ' +
        'layer is not running, so the round-trip test below would pass vacuously. ' +
        'Two likely causes: (1) the model is not cached — check ~/.mingly/models; ' +
        '(2) src/main/privacy/ner-worker.js is missing. Running from TypeScript ' +
        'sources, ner-detector.ts resolves the worker via ' +
        'path.join(__dirname, "ner-worker.js"), i.e. next to itself — whereas the ' +
        'packaged app resolves it inside dist/main. Build the source-adjacent copy ' +
        'with: npm run build:ner-worker:src'
      ).toBeGreaterThan(0)
    },
    NER_TEST_TIMEOUT_MS
  )

  it(
    'anonymize -> rehydrate reproduces "Kontakt: anna.meier@example.ch" exactly',
    async () => {
      const input = 'Kontakt: anna.meier@example.ch'
      const anon = new PIIAnonymizer('probe-1', 'shield')
      const result = await anon.anonymize(input)

      // Regression guard for the measured corruption pattern
      // ("Kontakt: davi[CUSTOM]b[CUSTOM]otonmail.ch").
      expect(result.anonymizedText).not.toMatch(/\[CUSTOM/i)

      // Mirrors src/main/ipc/privacy-handlers.ts's wiring.
      const sessionMap = new PrivacySessionMap('probe-1')
      const categoryMap = new Map<string, PIICategory>(
        result.replacements.map(r => [r.entity.original, r.entity.category])
      )
      sessionMap.importFromAnonymizer(anon.getReplacementMap(), categoryMap)

      const rehydrated = rehydrate(result.anonymizedText, sessionMap, 'shield')
      expect(rehydrated.rehydratedText).toBe(input)
    },
    NER_TEST_TIMEOUT_MS
  )
})
