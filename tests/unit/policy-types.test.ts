import { describe, it, expect } from 'vitest'
import { atLeast, maxSensitivity, SENSITIVITY_ORDER } from '../../src/main/policy/policy-types'

describe('sensitivity ordering', () => {
  it('orders low < medium < high < critical', () => {
    expect(SENSITIVITY_ORDER.low).toBeLessThan(SENSITIVITY_ORDER.medium)
    expect(SENSITIVITY_ORDER.medium).toBeLessThan(SENSITIVITY_ORDER.high)
    expect(SENSITIVITY_ORDER.high).toBeLessThan(SENSITIVITY_ORDER.critical)
  })

  it('atLeast is true when the first level reaches the threshold', () => {
    expect(atLeast(SENSITIVITY_ORDER, 'high', 'high')).toBe(true)
    expect(atLeast(SENSITIVITY_ORDER, 'critical', 'high')).toBe(true)
  })

  it('atLeast is false below the threshold', () => {
    expect(atLeast(SENSITIVITY_ORDER, 'medium', 'high')).toBe(false)
    expect(atLeast(SENSITIVITY_ORDER, 'low', 'medium')).toBe(false)
  })

  it('maxSensitivity returns the highest level present', () => {
    expect(maxSensitivity(['low', 'critical', 'medium'])).toBe('critical')
    expect(maxSensitivity(['low', 'medium'])).toBe('medium')
  })

  it('maxSensitivity returns low for an empty list', () => {
    expect(maxSensitivity([])).toBe('low')
  })
})
