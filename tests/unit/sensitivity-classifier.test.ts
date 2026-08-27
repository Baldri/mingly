/**
 * Deckt Invariante I3 ab: Trefferzahlen je Detektorschicht, nicht nur je Kategorie.
 */

import { describe, it, expect } from 'vitest'
import { classify } from '../../src/main/policy/sensitivity-classifier'
import type { PIIEntity } from '../../src/main/privacy/pii-types'

function entity(partial: Partial<PIIEntity>): PIIEntity {
  return {
    category: 'PERSON',
    original: 'Muster',
    start: 0,
    end: 6,
    confidence: 1,
    source: 'ner',
    sensitivity: 'high',
    ...partial
  }
}

describe('classify', () => {
  it('takes the highest entity sensitivity when it exceeds the workspace class', () => {
    const result = classify([entity({ sensitivity: 'critical', category: 'AHV' })], 'low')
    expect(result.level).toBe('critical')
  })

  it('takes the workspace class when no finding exceeds it', () => {
    const result = classify([entity({ sensitivity: 'medium' })], 'high')
    expect(result.level).toBe('high')
  })

  it('returns the workspace class when nothing was found', () => {
    const result = classify([], 'medium')
    expect(result.level).toBe('medium')
  })

  it('counts hits per detector source (I3)', () => {
    const result = classify(
      [
        entity({ source: 'swiss', category: 'AHV', sensitivity: 'critical' }),
        entity({ source: 'swiss', category: 'ADDRESS', sensitivity: 'medium' }),
        entity({ source: 'regex', category: 'EMAIL', sensitivity: 'high' }),
        entity({ source: 'ner', category: 'PERSON', sensitivity: 'high' })
      ],
      'low'
    )

    expect(result.bySource).toEqual({ regex: 1, swiss: 2, ner: 1, custom: 0 })
  })

  it('distinguishes the same category coming from two layers (I3)', () => {
    const result = classify(
      [
        entity({ source: 'swiss', category: 'ADDRESS', sensitivity: 'medium' }),
        entity({ source: 'ner', category: 'ADDRESS', sensitivity: 'medium' })
      ],
      'low'
    )

    expect(result.bySource.swiss).toBe(1)
    expect(result.bySource.ner).toBe(1)
  })

  it('states the reason for the audit entry', () => {
    const result = classify([entity({ sensitivity: 'critical', category: 'AHV' })], 'low')
    expect(result.reason).toContain('AHV')
  })

  it('never puts the detected text into the reason (audit safety)', () => {
    const distinctiveNumber = '756.9999.8888.77'
    const result = classify(
      [entity({ original: distinctiveNumber, source: 'swiss', category: 'AHV', sensitivity: 'critical' })],
      'low'
    )

    expect(result.reason).not.toContain(distinctiveNumber)
    expect(result.reason).toContain('AHV')
  })
})
