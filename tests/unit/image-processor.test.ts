/**
 * ImageProcessor Tests
 * Tests image validation, MIME type detection, and size limits.
 * Note: processImageFile and processImageBuffer require Electron's nativeImage
 * and are tested via integration tests. This file tests the pure logic functions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron (required by image-processor)
vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: vi.fn() }
}))

// Mock fs for validateImageFile
vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 1000 })
  }
}))

import {
  getImageMimeType,
  validateImageFile,
  validateAttachmentCount,
  MAX_FILE_SIZE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_DIMENSION
} from '../../src/main/utils/image-processor'
import fs from 'fs'

describe('ImageProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: small file
    ;(fs.statSync as any).mockReturnValue({ size: 1000 })
  })

  describe('getImageMimeType', () => {
    it('should return correct MIME type for .jpg', () => {
      expect(getImageMimeType('photo.jpg')).toBe('image/jpeg')
    })

    it('should return correct MIME type for .jpeg', () => {
      expect(getImageMimeType('photo.jpeg')).toBe('image/jpeg')
    })

    it('should return correct MIME type for .png', () => {
      expect(getImageMimeType('screenshot.png')).toBe('image/png')
    })

    it('should return correct MIME type for .gif', () => {
      expect(getImageMimeType('animation.gif')).toBe('image/gif')
    })

    it('should return correct MIME type for .webp', () => {
      expect(getImageMimeType('modern.webp')).toBe('image/webp')
    })

    it('should return null for unsupported extensions', () => {
      expect(getImageMimeType('document.pdf')).toBeNull()
      expect(getImageMimeType('video.mp4')).toBeNull()
      expect(getImageMimeType('archive.zip')).toBeNull()
    })

    it('should handle case-insensitive extensions', () => {
      expect(getImageMimeType('photo.JPG')).toBe('image/jpeg')
      expect(getImageMimeType('image.PNG')).toBe('image/png')
    })

    it('should handle files with dots in path', () => {
      expect(getImageMimeType('/path/to/my.photo.jpg')).toBe('image/jpeg')
    })
  })

  describe('validateImageFile', () => {
    it('should reject unsupported file types', () => {
      const result = validateImageFile('document.pdf')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Unsupported')
    })

    it('should reject files over size limit', () => {
      ;(fs.statSync as any).mockReturnValue({ size: MAX_FILE_SIZE_BYTES + 1 })
      const result = validateImageFile('large.png')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('large')
    })

    it('should accept valid image files', () => {
      ;(fs.statSync as any).mockReturnValue({ size: 500_000 })
      const result = validateImageFile('photo.jpg')
      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('should accept files at exactly the size limit', () => {
      ;(fs.statSync as any).mockReturnValue({ size: MAX_FILE_SIZE_BYTES })
      const result = validateImageFile('photo.png')
      expect(result.valid).toBe(true)
    })
  })

  describe('validateAttachmentCount', () => {
    it('should reject when count exceeds maximum', () => {
      const result = validateAttachmentCount(MAX_IMAGES_PER_MESSAGE + 1)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('many')
    })

    it('should accept valid counts', () => {
      expect(validateAttachmentCount(1).valid).toBe(true)
      expect(validateAttachmentCount(MAX_IMAGES_PER_MESSAGE).valid).toBe(true)
    })

    it('should accept zero attachments', () => {
      expect(validateAttachmentCount(0).valid).toBe(true)
    })
  })

  describe('constants', () => {
    it('should have sensible defaults', () => {
      expect(MAX_FILE_SIZE_BYTES).toBe(10 * 1024 * 1024) // 10 MB
      expect(MAX_IMAGES_PER_MESSAGE).toBe(4)
      expect(MAX_DIMENSION).toBe(1024)
    })
  })
})
