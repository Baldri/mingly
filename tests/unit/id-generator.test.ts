/**
 * ID Generator Tests
 */

import { describe, it, expect } from 'vitest'
import { generateId } from '../../src/main/utils/id-generator'

describe('generateId', () => {
  it('should return a hex string', () => {
    const id = generateId()
    expect(id).toMatch(/^[0-9a-f]+$/)
  })

  it('should return a 32-character string (16 bytes hex)', () => {
    const id = generateId()
    expect(id.length).toBe(32)
  })

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()))
    expect(ids.size).toBe(100)
  })
})
