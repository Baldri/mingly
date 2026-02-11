/**
 * File Access Types Tests
 * Tests path safety validation and exported constants.
 */

import { describe, it, expect } from 'vitest'
import {
  isPathSafe,
  ALLOWED_READ_EXTENSIONS,
  ALLOWED_CREATE_EXTENSIONS,
  AI_OUTPUT_FOLDER
} from '../../src/shared/file-access-types'

describe('isPathSafe', () => {
  it('should allow paths within allowed directory', () => {
    expect(isPathSafe('/home/user/docs/file.txt', '/home/user/docs')).toBe(true)
  })

  it('should allow the allowed directory itself', () => {
    expect(isPathSafe('/home/user/docs', '/home/user/docs')).toBe(true)
  })

  it('should allow subdirectories', () => {
    expect(isPathSafe('/home/user/docs/sub/deep/file.md', '/home/user/docs')).toBe(true)
  })

  it('should reject paths outside allowed directory', () => {
    expect(isPathSafe('/home/user/secrets/file.txt', '/home/user/docs')).toBe(false)
  })

  it('should reject path traversal attacks', () => {
    expect(isPathSafe('/home/user/docs/../secrets/file.txt', '/home/user/docs')).toBe(false)
  })

  it('should reject parent directory', () => {
    expect(isPathSafe('/home/user', '/home/user/docs')).toBe(false)
  })
})

describe('File extension constants', () => {
  it('should include common document extensions for reading', () => {
    expect(ALLOWED_READ_EXTENSIONS).toContain('.txt')
    expect(ALLOWED_READ_EXTENSIONS).toContain('.md')
    expect(ALLOWED_READ_EXTENSIONS).toContain('.pdf')
    expect(ALLOWED_READ_EXTENSIONS).toContain('.json')
  })

  it('should include code extensions for reading', () => {
    expect(ALLOWED_READ_EXTENSIONS).toContain('.js')
    expect(ALLOWED_READ_EXTENSIONS).toContain('.ts')
    expect(ALLOWED_READ_EXTENSIONS).toContain('.py')
  })

  it('should include creation extensions', () => {
    expect(ALLOWED_CREATE_EXTENSIONS).toContain('.txt')
    expect(ALLOWED_CREATE_EXTENSIONS).toContain('.md')
    expect(ALLOWED_CREATE_EXTENSIONS).toContain('.json')
    expect(ALLOWED_CREATE_EXTENSIONS).toContain('.ts')
  })

  it('should define AI output folder name', () => {
    expect(AI_OUTPUT_FOLDER).toBe('Mingly-AI-Output')
  })
})
