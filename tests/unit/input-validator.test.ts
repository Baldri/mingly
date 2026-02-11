import { describe, it, expect } from 'vitest'
import {
  validateRAGQuery,
  validateCollectionName,
  validateFilePath,
  validateMCPArgs,
  validateString,
  validatePositiveInt
} from '../../src/main/security/input-validator'

describe('Input Validator', () => {

  describe('validateRAGQuery()', () => {
    it('should accept valid queries', () => {
      expect(validateRAGQuery('What is machine learning?').valid).toBe(true)
    })

    it('should reject non-string input', () => {
      expect(validateRAGQuery(123).valid).toBe(false)
      expect(validateRAGQuery(null).valid).toBe(false)
    })

    it('should reject empty queries', () => {
      expect(validateRAGQuery('').valid).toBe(false)
    })

    it('should reject queries exceeding max length', () => {
      expect(validateRAGQuery('x'.repeat(10_001)).valid).toBe(false)
    })

    it('should reject queries with null bytes', () => {
      expect(validateRAGQuery('hello\0world').valid).toBe(false)
    })
  })

  describe('validateCollectionName()', () => {
    it('should accept valid collection names', () => {
      expect(validateCollectionName('documents').valid).toBe(true)
      expect(validateCollectionName('my-collection_v2').valid).toBe(true)
      expect(validateCollectionName('test.2024').valid).toBe(true)
    })

    it('should reject empty names', () => {
      expect(validateCollectionName('').valid).toBe(false)
    })

    it('should reject names with special characters', () => {
      expect(validateCollectionName('my collection').valid).toBe(false) // space
      expect(validateCollectionName('../evil').valid).toBe(false) // path traversal
      expect(validateCollectionName('name;DROP TABLE').valid).toBe(false) // SQL
    })

    it('should reject overly long names', () => {
      expect(validateCollectionName('x'.repeat(200)).valid).toBe(false)
    })
  })

  describe('validateFilePath()', () => {
    it('should accept valid file paths', () => {
      expect(validateFilePath('/Users/test/document.txt').valid).toBe(true)
      expect(validateFilePath('/tmp/file.pdf').valid).toBe(true)
    })

    it('should reject path traversal attacks', () => {
      expect(validateFilePath('../../../etc/passwd').valid).toBe(false)
      expect(validateFilePath('/home/user/../../etc/shadow').valid).toBe(false)
    })

    it('should reject null byte injection', () => {
      expect(validateFilePath('/tmp/file.txt\0.exe').valid).toBe(false)
    })

    it('should reject URL-encoded traversal', () => {
      expect(validateFilePath('%2e%2e/etc/passwd').valid).toBe(false)
    })

    it('should reject empty paths', () => {
      expect(validateFilePath('').valid).toBe(false)
    })

    it('should reject non-string input', () => {
      expect(validateFilePath(123).valid).toBe(false)
    })
  })

  describe('validateMCPArgs()', () => {
    it('should accept valid arguments', () => {
      expect(validateMCPArgs({ key: 'value' }).valid).toBe(true)
      expect(validateMCPArgs({}).valid).toBe(true)
    })

    it('should accept null/undefined (optional)', () => {
      expect(validateMCPArgs(null).valid).toBe(true)
      expect(validateMCPArgs(undefined).valid).toBe(true)
    })

    it('should reject non-object arguments', () => {
      expect(validateMCPArgs('string').valid).toBe(false)
      expect(validateMCPArgs(123).valid).toBe(false)
    })

    it('should reject oversized arguments', () => {
      const huge = { data: 'x'.repeat(100_000) }
      expect(validateMCPArgs(huge).valid).toBe(false)
    })
  })

  describe('validateString()', () => {
    it('should accept valid strings', () => {
      expect(validateString('hello', 'test').valid).toBe(true)
    })

    it('should reject non-string values', () => {
      expect(validateString(123, 'test').valid).toBe(false)
    })

    it('should reject strings exceeding custom max length', () => {
      expect(validateString('toolong', 'test', 3).valid).toBe(false)
    })

    it('should reject strings with null bytes', () => {
      expect(validateString('has\0null', 'test').valid).toBe(false)
    })
  })

  describe('validatePositiveInt()', () => {
    it('should accept valid positive integers', () => {
      expect(validatePositiveInt(0, 'test').valid).toBe(true)
      expect(validatePositiveInt(100, 'test').valid).toBe(true)
    })

    it('should accept undefined/null (optional)', () => {
      expect(validatePositiveInt(undefined, 'test').valid).toBe(true)
      expect(validatePositiveInt(null, 'test').valid).toBe(true)
    })

    it('should reject negative numbers', () => {
      expect(validatePositiveInt(-1, 'test').valid).toBe(false)
    })

    it('should reject floats', () => {
      expect(validatePositiveInt(3.5, 'test').valid).toBe(false)
    })

    it('should reject values exceeding max', () => {
      expect(validatePositiveInt(999999, 'test', 1000).valid).toBe(false)
    })
  })
})
