import { describe, it, expect } from 'vitest'
import { preprocessText } from '../../src/main/privacy/text-preprocessor'

describe('text-preprocessor: HTML entity decoding', () => {
  it('decodes numeric HTML entities', () => {
    const result = preprocessText('hans&#64;test&#46;ch')
    expect(result.normalized).toBe('hans@test.ch')
    expect(result.wasModified).toBe(true)
  })

  it('decodes hex HTML entities', () => {
    const result = preprocessText('hans&#x40;test&#x2E;ch')
    expect(result.normalized).toBe('hans@test.ch')
    expect(result.wasModified).toBe(true)
  })

  it('decodes named HTML entities', () => {
    const result = preprocessText('hans&commat;test&period;ch')
    expect(result.normalized).toBe('hans@test.ch')
    expect(result.wasModified).toBe(true)
  })

  it('preserves offset mapping through HTML entity decoding', () => {
    const result = preprocessText('a&#64;b')
    expect(result.normalized).toBe('a@b')
    expect(result.toOriginalOffset(0)).toBe(0) // 'a' -> 0
    expect(result.toOriginalOffset(1)).toBe(1) // '@' -> 1 (start of &#64;)
    expect(result.toOriginalOffset(2)).toBe(6) // 'b' -> 6
  })
})

describe('text-preprocessor: fullwidth normalization', () => {
  it('normalizes fullwidth ASCII characters', () => {
    const result = preprocessText('hans\uFF20test\uFF0Ech')
    expect(result.normalized).toBe('hans@test.ch')
    expect(result.wasModified).toBe(true)
  })

  it('normalizes fullwidth digits', () => {
    const result = preprocessText('\uFF10\uFF17\uFF18 123 45 67')
    expect(result.normalized).toBe('078 123 45 67')
    expect(result.wasModified).toBe(true)
  })

  it('does not modify regular ASCII', () => {
    const result = preprocessText('normal text 123')
    expect(result.normalized).toBe('normal text 123')
    expect(result.wasModified).toBe(false)
  })
})
