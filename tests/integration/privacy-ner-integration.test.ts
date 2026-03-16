/**
 * Integration Test: piiranha-v1 NER Layer
 *
 * Downloads the real piiranha-v1 ONNX model and runs end-to-end inference.
 * Skipped by default — run with: RUN_NER_INTEGRATION=1 npx vitest run tests/integration/
 *
 * First run downloads ~300MB model (1-3min depending on connection).
 * Subsequent runs use cached model (~2-5s per test).
 *
 * piiranha-v1 specifics:
 * - Trained for PII detection in structured contexts (forms, contact info, records)
 * - Labels: GIVENNAME, SURNAME, CITY, STREET, ZIPCODE, EMAIL, TELEPHONENUM, DATEOFBIRTH, etc.
 * - Uses I-* prefix only (no B-* tagging)
 * - ONNX version may return null start/end offsets
 * - Names detected best when in PII context ("Name: ...", "Kontakt: ...")
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { NERModelManager } from '../../src/main/privacy/model-manager'

const SKIP = !process.env.RUN_NER_INTEGRATION
const INTEGRATION_MODEL_DIR = path.join(os.homedir(), '.mingly', 'models')

// Shared pipeline instance — loaded once, reused across tests
let pipeline: any = null

// ── Inline mergeTokens (mirrors ner-worker.ts logic) ─────────────

function areMergeableLabels(labelA: string, labelB: string): boolean {
  if (labelA === labelB) return true
  const nameLabels = new Set(['GIVENNAME', 'SURNAME'])
  if (nameLabels.has(labelA) && nameLabels.has(labelB)) return true
  return false
}

function mapLabel(label: string): string | null {
  const map: Record<string, string> = {
    GIVENNAME: 'PERSON', SURNAME: 'PERSON',
    CITY: 'LOCATION', STREET: 'ADDRESS', BUILDINGNUM: 'ADDRESS', ZIPCODE: 'LOCATION',
    EMAIL: 'EMAIL', TELEPHONENUM: 'PHONE',
    DATEOFBIRTH: 'DATE_OF_BIRTH', SOCIALNUM: 'AHV', CREDITCARDNUMBER: 'CREDIT_CARD',
    ACCOUNTNUM: 'IBAN', IDCARDNUM: 'PASSPORT', DRIVERLICENSENUM: 'PASSPORT',
    TAXNUM: 'AHV', PASSWORD: 'CUSTOM', USERNAME: 'CUSTOM',
    PER: 'PERSON', PERSON: 'PERSON', ORG: 'ORGANIZATION', LOC: 'LOCATION',
    GPE: 'LOCATION', STREET_ADDRESS: 'ADDRESS', ADDRESS: 'ADDRESS'
  }
  return map[label] ?? null
}

function findInText(text: string, needle: string): { start: number; end: number } {
  const idx = text.indexOf(needle)
  if (idx !== -1) return { start: idx, end: idx + needle.length }
  const lowerIdx = text.toLowerCase().indexOf(needle.toLowerCase())
  if (lowerIdx !== -1) return { start: lowerIdx, end: lowerIdx + needle.length }
  const normalized = needle.replace(/\s+/g, ' ').trim()
  const normIdx = text.indexOf(normalized)
  if (normIdx !== -1) return { start: normIdx, end: normIdx + normalized.length }
  return { start: 0, end: needle.length }
}

async function detectWithNER(text: string): Promise<Array<{
  category: string
  original: string
  start: number
  end: number
  confidence: number
  source: 'ner'
}>> {
  if (!pipeline) return []

  const tokens = await pipeline(text, { ignore_labels: [] })
  const entities: any[] = []
  let current: any = null

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const label = token.entity || token.entity_group || ''

    if (label === 'O') {
      if (current) { entities.push(finalize(current, text)); current = null }
      continue
    }

    const rawLabel = label.startsWith('I-') ? label.substring(2) : label
    const category = mapLabel(rawLabel)
    if (!category) {
      if (current) { entities.push(finalize(current, text)); current = null }
      continue
    }

    const shouldMerge = current !== null &&
      areMergeableLabels(current.rawLabels[0], rawLabel) &&
      i === current.endIdx + 1

    if (shouldMerge && current) {
      current.words.push(token.word)
      current.rawLabels.push(rawLabel)
      current.endIdx = i
      current.score = Math.min(current.score, token.score)
    } else {
      if (current) entities.push(finalize(current, text))
      current = {
        category, rawLabels: [rawLabel], words: [token.word],
        startIdx: i, endIdx: i, score: token.score,
        start: token.start, end: token.end
      }
    }
  }
  if (current) entities.push(finalize(current, text))
  return entities
}

function finalize(e: any, text: string) {
  const hasName = e.rawLabels.some((l: string) => l === 'GIVENNAME' || l === 'SURNAME')
  const category = hasName ? 'PERSON' : e.category
  const reconstructed = e.words.join('').replace(/^\s+/, '')
  let { start, end } = e
  if (start === null || start === undefined || end === null || end === undefined) {
    const found = findInText(text, reconstructed)
    start = found.start
    end = found.end
  }
  return {
    category, original: reconstructed,
    start: start ?? 0, end: end ?? reconstructed.length,
    confidence: Math.round(e.score * 100) / 100,
    source: 'ner' as const
  }
}

// ── Test Suite ────────────────────────────────────────────────────

describe.skipIf(SKIP)('piiranha-v1 NER Integration', () => {

  beforeAll(async () => {
    console.log('[NER Integration] Checking model status...')
    const manager = new NERModelManager(INTEGRATION_MODEL_DIR)

    if (manager.getStatus() !== 'ready') {
      console.log('[NER Integration] Downloading piiranha-v1 model (~300MB)...')
      await manager.download((p) => { if (p % 25 === 0) console.log(`  Download: ${p}%`) })
      console.log('[NER Integration] Download complete.')
    } else {
      console.log('[NER Integration] Model already cached.')
    }

    const transformers = await import('@xenova/transformers')
    transformers.env.cacheDir = INTEGRATION_MODEL_DIR
    transformers.env.allowRemoteModels = true // allow download of non-quantized variant

    console.log('[NER Integration] Loading pipeline (fp32 for best quality)...')
    pipeline = await transformers.pipeline(
      'token-classification',
      'onnx-community/piiranha-v1-detect-personal-information-ONNX',
      { quantized: false }
    )
    console.log('[NER Integration] Pipeline ready.')
  }, 300_000)

  afterAll(async () => {
    if (pipeline?.dispose) { await pipeline.dispose(); pipeline = null }
  })

  // ── Model Manager ──────────────────────────────────────────────

  describe('Model Manager', () => {
    it('reports status as ready after download', () => {
      const manager = new NERModelManager(INTEGRATION_MODEL_DIR)
      expect(manager.getStatus()).toBe('ready')
    })

    it('model directory contains ONNX files', () => {
      const modelDir = path.join(
        INTEGRATION_MODEL_DIR, 'onnx-community',
        'piiranha-v1-detect-personal-information-ONNX'
      )
      expect(fs.existsSync(modelDir)).toBe(true)
      const onnxDir = path.join(modelDir, 'onnx')
      if (fs.existsSync(onnxDir)) {
        const files = fs.readdirSync(onnxDir)
        expect(files.some(f => f.endsWith('.onnx'))).toBe(true)
      }
    })
  })

  // ── PII Context Detection (piiranha's strength) ────────────────

  describe('PII Context Detection', () => {
    it('detects names in contact/form context', async () => {
      const entities = await detectWithNER('Kontakt: Hans Mueller, hans.mueller@gmail.com')
      const persons = entities.filter(e => e.category === 'PERSON')
      const emails = entities.filter(e => e.category === 'EMAIL')

      expect(persons.length).toBeGreaterThanOrEqual(1)
      expect(emails.length).toBeGreaterThanOrEqual(1)
    })

    it('detects GIVENNAME + SURNAME and merges to PERSON', async () => {
      const entities = await detectWithNER('Name: Hans Mueller, Vorname: Hans, Nachname: Mueller')
      const persons = entities.filter(e => e.category === 'PERSON')

      expect(persons.length).toBeGreaterThanOrEqual(1)
      const fullName = persons.find(p =>
        p.original.includes('Hans') && p.original.includes('eller')
      )
      expect(fullName).toBeDefined()
    })

    it('detects street addresses with building numbers', async () => {
      const entities = await detectWithNER(
        'Adresse: Bahnhofstrasse 42, 8001 Zürich'
      )
      const addresses = entities.filter(e => e.category === 'ADDRESS')
      const locations = entities.filter(e => e.category === 'LOCATION')

      expect(addresses.length + locations.length).toBeGreaterThanOrEqual(1)
    })

    it('detects phone numbers', async () => {
      const entities = await detectWithNER('Telefon: +41 79 123 45 67')
      const phones = entities.filter(e => e.category === 'PHONE')

      expect(phones.length).toBeGreaterThanOrEqual(1)
    })

    it('detects email addresses', async () => {
      const entities = await detectWithNER('Email: hans.mueller@gmail.com')
      const emails = entities.filter(e => e.category === 'EMAIL')

      expect(emails.length).toBeGreaterThanOrEqual(1)
      expect(emails[0].original).toContain('@')
    })

    it('detects dates of birth', async () => {
      const entities = await detectWithNER('Geboren am 15.03.1985 in Bern')
      const dobs = entities.filter(e => e.category === 'DATE_OF_BIRTH')

      expect(dobs.length).toBeGreaterThanOrEqual(1)
    })

    it('detects cities', async () => {
      const entities = await detectWithNER('Er wohnt in Zuerich und arbeitet in Bern.')
      const locations = entities.filter(e => e.category === 'LOCATION')

      expect(locations.length).toBeGreaterThanOrEqual(1)
    })

    it('detects ZIP codes', async () => {
      const entities = await detectWithNER('PLZ: 8001 Zürich')
      const locations = entities.filter(e => e.category === 'LOCATION')

      expect(locations.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── Multi-PII Detection ────────────────────────────────────────

  describe('Multi-PII', () => {
    it('detects multiple PII types in a form-like text', async () => {
      const text = [
        'Name: Hans Mueller',
        'Email: hans.mueller@gmail.com',
        'Telefon: +41 79 123 45 67',
        'Adresse: Bahnhofstrasse 42, 8001 Zürich',
        'Geboren: 15.03.1985'
      ].join('\n')

      const entities = await detectWithNER(text)
      const categories = new Set(entities.map(e => e.category))

      expect(categories.size).toBeGreaterThanOrEqual(3)
      console.log('[Multi-PII] Categories found:', [...categories])
      console.log('[Multi-PII] Entities:', entities.map(e =>
        `${e.category}: "${e.original}" (${e.confidence})`
      ))
    })
  })

  // ── Multilingual ───────────────────────────────────────────────

  describe('Multilingual', () => {
    it('detects PII in German context', async () => {
      const entities = await detectWithNER(
        'Kontakt: Thomas Keller, thomas.keller@bluewin.ch, Hauptstrasse 15, 3000 Bern'
      )
      expect(entities.length).toBeGreaterThanOrEqual(2)
    })

    it('detects PII in English context', async () => {
      const entities = await detectWithNER(
        'Contact: John Smith, john.smith@gmail.com, 123 Main Street, London'
      )
      expect(entities.length).toBeGreaterThanOrEqual(2)
    })

    it('detects PII in French context', async () => {
      const entities = await detectWithNER(
        'Contact: Marie Dupont, marie.dupont@gmail.com, Rue de la Gare 5, 1003 Lausanne'
      )
      expect(entities.length).toBeGreaterThanOrEqual(2)
    })

    it('detects PII in Italian context', async () => {
      const entities = await detectWithNER(
        'Contatto: Marco Rossi, marco.rossi@gmail.com, Via Roma 10, 6900 Lugano'
      )
      expect(entities.length).toBeGreaterThanOrEqual(2)
    })
  })

  // ── Entity Quality ─────────────────────────────────────────────

  describe('Entity Quality', () => {
    it('returns valid entity structure', async () => {
      const entities = await detectWithNER('Email: test@example.com, PLZ: 8001 Zürich')

      for (const entity of entities) {
        expect(entity).toHaveProperty('category')
        expect(entity).toHaveProperty('original')
        expect(entity).toHaveProperty('start')
        expect(entity).toHaveProperty('end')
        expect(entity).toHaveProperty('confidence')
        expect(entity).toHaveProperty('source')

        expect(typeof entity.category).toBe('string')
        expect(typeof entity.original).toBe('string')
        expect(entity.original.length).toBeGreaterThan(0)
        expect(entity.confidence).toBeGreaterThan(0)
        expect(entity.confidence).toBeLessThanOrEqual(1)
        expect(entity.source).toBe('ner')
      }
    })

    it('reconstructs offsets when start/end are null', async () => {
      const text = 'Kontakt: Hans Mueller in Zürich'
      const entities = await detectWithNER(text)

      for (const entity of entities) {
        expect(entity.start).toBeGreaterThanOrEqual(0)
        expect(entity.end).toBeLessThanOrEqual(text.length)
        expect(entity.start).toBeLessThan(entity.end)
      }
    })

    it('confidence scores for clear PII are high (>0.8)', async () => {
      const entities = await detectWithNER('Email: test@example.com, Tel: +41 79 123 45 67')
      const highConf = entities.filter(e => e.confidence > 0.8)
      expect(highConf.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ── Edge Cases ─────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('returns empty for text without PII', async () => {
      const entities = await detectWithNER('Das Wetter ist heute schoen.')
      expect(entities.length).toBe(0)
    })

    it('handles empty string', async () => {
      const entities = await detectWithNER('')
      expect(entities).toEqual([])
    })

    it('handles very short input', async () => {
      const entities = await detectWithNER('Hi')
      expect(Array.isArray(entities)).toBe(true)
    })

    it('handles special characters', async () => {
      const entities = await detectWithNER('Kontakt: Hans Müller (CEO) <hans@test.ch>')
      expect(Array.isArray(entities)).toBe(true)
    })

    it('handles long text without timeout', async () => {
      const longText = 'Kontakt: Hans Mueller, Email: hans@test.ch. '.repeat(20)
      const entities = await detectWithNER(longText)
      expect(Array.isArray(entities)).toBe(true)
    }, 30_000)
  })

  // ── Performance ────────────────────────────────────────────────

  describe('Performance', () => {
    it('inference completes within 500ms for short text', async () => {
      const start = performance.now()
      await detectWithNER('Email: test@example.com')
      const elapsed = performance.now() - start
      console.log(`[NER Performance] Short text: ${Math.round(elapsed)}ms`)
      expect(elapsed).toBeLessThan(500)
    })

    it('inference completes within 2000ms for medium text', async () => {
      const text = [
        'Name: Thomas Keller, Email: thomas@test.ch',
        'Adresse: Bahnhofstrasse 42, 8001 Zürich',
        'Tel: +41 79 123 45 67, Geboren: 15.03.1985'
      ].join('\n')
      const start = performance.now()
      await detectWithNER(text)
      const elapsed = performance.now() - start
      console.log(`[NER Performance] Medium text: ${Math.round(elapsed)}ms`)
      expect(elapsed).toBeLessThan(2000)
    })
  })

  // ── Graceful Degradation ───────────────────────────────────────

  describe('Graceful Degradation', () => {
    it('NERModelManager reports not_downloaded for non-existent path', () => {
      const manager = new NERModelManager('/tmp/non-existent-mingly-test-dir')
      expect(manager.getStatus()).toBe('not_downloaded')
    })

    it('NERDetector returns empty when model not available', async () => {
      const { NERDetector } = await import('../../src/main/privacy/ner-detector')
      const detector = new NERDetector(
        new NERModelManager('/tmp/non-existent-mingly-test-dir')
      )
      expect(detector.isAvailable()).toBe(false)
      const result = await detector.detect('Hans Mueller')
      expect(result).toEqual([])
      detector.shutdown()
    })
  })
})
