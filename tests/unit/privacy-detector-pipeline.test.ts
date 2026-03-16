/**
 * Detector Pipeline Tests
 */
import { describe, it, expect } from 'vitest'
import { detectPII, deduplicateEntities } from '../../src/main/privacy/detector-pipeline'
import type { PIIEntity } from '../../src/main/privacy/pii-types'

describe('detectPII', () => {
  it('should detect email from regex layer', async () => {
    const result = await detectPII('Mail: hans@example.ch')
    expect(result.entities.length).toBeGreaterThan(0)
    const email = result.entities.find(e => e.category === 'EMAIL')
    expect(email).toBeDefined()
    expect(email!.original).toBe('hans@example.ch')
  })

  it('should detect Swiss AHV from swiss layer', async () => {
    const result = await detectPII('AHV: 756.1234.5678.97')
    const ahv = result.entities.find(e => e.category === 'AHV')
    expect(ahv).toBeDefined()
    expect(ahv!.source).toBe('swiss')
  })

  it('should return entities sorted by position', async () => {
    const result = await detectPII('hans@test.ch wohnt in 8001 Zürich, AHV 756.1234.5678.97')
    const starts = result.entities.map(e => e.start)
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1])
    }
  })

  it('should build stats per category', async () => {
    const result = await detectPII('hans@test.ch und peter@test.ch in Zürich')
    expect(result.stats.EMAIL).toBe(2)
  })

  it('should return empty for clean text', async () => {
    const result = await detectPII('Heute ist ein schöner Tag.')
    expect(result.entities).toHaveLength(0)
  })

  it('should include latency measurement', async () => {
    const result = await detectPII('test@test.ch')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('should preserve original text', async () => {
    const text = 'Original text'
    const result = await detectPII(text)
    expect(result.originalText).toBe(text)
  })
})

describe('deduplicateEntities', () => {
  const makeEntity = (
    start: number, end: number, source: 'regex' | 'swiss', confidence: number, category = 'PHONE' as const
  ): PIIEntity => ({
    category,
    original: 'test',
    start,
    end,
    confidence,
    source,
    sensitivity: 'medium'
  })

  it('should return empty for empty input', () => {
    expect(deduplicateEntities([])).toEqual([])
  })

  it('should return single entity unchanged', () => {
    const entities = [makeEntity(0, 10, 'regex', 1.0)]
    expect(deduplicateEntities(entities)).toHaveLength(1)
  })

  it('should keep non-overlapping entities', () => {
    const entities = [
      makeEntity(0, 10, 'regex', 1.0),
      makeEntity(20, 30, 'regex', 1.0)
    ]
    expect(deduplicateEntities(entities)).toHaveLength(2)
  })

  it('should prefer swiss over regex for overlapping spans', () => {
    const entities = [
      makeEntity(0, 15, 'regex', 1.0),
      makeEntity(0, 15, 'swiss', 1.0)
    ]
    const result = deduplicateEntities(entities)
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('swiss')
  })

  it('should prefer higher confidence for overlapping spans', () => {
    const entities = [
      makeEntity(0, 15, 'regex', 0.7),
      makeEntity(0, 15, 'regex', 0.95)
    ]
    const result = deduplicateEntities(entities)
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe(0.95)
  })
})
